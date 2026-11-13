import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, readJSON, sessionId } from "../core/lib/state.mjs";
import { ownerState } from "../core/lib/process.mjs";
import { projectDirectory } from "../core/store.mjs";
import { agentKind } from "../core/agent-runtimes.mjs";
import { checkedSessionFile } from "./pi-launch.mjs";
import { clearControlDescriptor } from "../core/control.mjs";

export const PROJECT_TOOLS = ["thread_start", "thread_list", "thread_send", "thread_rename", "thread_resolve", "thread_reopen"];
export const dormantHint = "Use /projects for status, /projects new [name] to make this conversation a project, or /projects resume [name] to resume one here.";

export function findSessionRecord(stateDir, id) {
  sessionId(id);
  let projects;
  try { projects = readdirSync(join(stateDir, "projects"), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  let found;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const directory = join(stateDir, "projects", project.name);
    const record = readJSON(join(directory, "records", `${id}.json`));
    if (!record) continue;
    if (record.version !== 1 || record.id !== id || projectDirectory(stateDir, record.projectRoot) !== directory) throw new Error("Stored session version/identity/project mismatch");
    if (found) throw new Error("Session UUID appears in more than one project");
    found = record;
  }
  return found;
}

export function messageNeedsTurn(message) {
  return message.informational !== true;
}

export function isWriterConflict(error) {
  return error?.writerConflict === true;
}

export function acquireSessionLocks(stateDir, store, id) {
  sessionId(id);
  const locks = [];
  try {
    locks.push(acquireLock(join(stateDir, "writer-locks", id)));
    locks.push(acquireLock(join(store.directory, "locks", `extension-${id}`)));
    const previous = store.record(id);
    if (previous?.owner && previous.owner.pid !== process.pid && ownerState(previous.owner) !== "dead") {
      throw Object.assign(new Error("Another live or uncertain writer owns this conversation"), { code: "ELOCKED" });
    }
    return locks;
  } catch (error) {
    for (const lock of locks.reverse()) lock.release();
    if (error.code === "ELOCKED") error.writerConflict = true;
    throw error;
  }
}

// Promotion binds the current conversation; it never allocates a new session or terminal.
export function registerCurrentSession(store, binding) {
  const { id, promote = false } = binding;
  sessionId(id);
  const agent = agentKind(binding.agent);
  return store.transaction(() => {
    const previous = store.record(id);
    if (previous && previous.agent !== agent) throw new Error("This conversation belongs to another agent runtime");
    if (!previous && !promote) return undefined;
    const role = previous?.role ?? "coordinator";
    const coordinator = role === "thread" ? sessionId(previous.coordinator) : id;
    if (promote && role === "thread") throw new Error("This conversation is already registered as a thread");
    const changedTranscript = previous?.sessionFile && previous.sessionFile !== binding.sessionFile;
    if (previous && (previous.cwd !== binding.cwd ||
        changedTranscript && (previous.transcriptState !== "unwritten" || existsSync(previous.sessionFile)))) throw new Error("Stored conversation differs from the current Pi session binding");
    if (role === "thread" && store.record(coordinator)?.role !== "coordinator") throw new Error("Thread requires its reserved record and coordinator");
    const title = previous?.title ?? binding.title ?? "coordinator";
    if (typeof title !== "string" || !title.trim() || /[\x00-\x1f\x7f]/.test(title)) throw new Error("Session title must be nonempty printable text");
    const titleSource = previous ? previous.titleSource : binding.titleSource ?? "human";
    if (!["placeholder", "agent", "human"].includes(titleSource)) throw new Error("Invalid title source");
    const now = new Date(), created = previous?.created ?? now.toISOString();
    const rank = previous?.rank === undefined ? (Date.parse(created) || 0) : previous.rank;
    if (!Number.isFinite(rank)) throw new Error("Invalid session rank");
    const record = { ...previous, id, projectRoot: store.projectRoot, role, coordinator, title, titleSource, agent,
      cwd: binding.cwd, terminal: binding.terminal, space: binding.space, tab: binding.tab,
      sessionFile: binding.sessionFile, sessionDir: binding.sessionDir, owner: binding.owner, resolved: previous?.resolved === true,
      transcriptState: previous?.transcriptState === "expected" || existsSync(binding.sessionFile) ? "expected" : "unwritten", created, rank,
      launchState: "registered", launchError: undefined, registration: "registered", registered: now.toISOString(), reopenWithProject: undefined };
    checkedSessionFile(record);
    return store.save(record);
  });
}

export function observeTranscript(store, { id, sessionFile }) {
  if (!existsSync(sessionFile)) return false;
  store.patch(id, { transcriptState: "expected" });
  return true;
}

export function unregisterCurrentSession(store, { id, sessionFile }) {
  observeTranscript(store, { id, sessionFile });
  return store.patch(id, { registration: "offline", owner: undefined, observed: new Date().toISOString() });
}

// Shutdown is also Pi's replacement boundary; release ownership while this process stays alive.
export async function releaseSessionRegistration(binding, io = {}) {
  try { await clearControlDescriptor(binding, io); }
  finally {
    try { unregisterCurrentSession(binding.store, binding); }
    finally { for (const lock of binding.locks.toReversed()) lock.release(); }
  }
}

export async function shutdownProjectThreads(binding, reason) {
  if (binding.role !== "coordinator" || reason === "reload") return;
  const { stateDir, projectRoot, id } = binding;
  // Detached with no terminal pipes: a disappearing Pi/PTY cannot interrupt the cascade.
  const child = spawn(join(stateDir, "bin", "control"), ["close-threads", JSON.stringify({ stateDir, projectRoot, id })],
    { detached: true, stdio: "ignore" });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Project thread close failed (${signal ?? code})`)));
  });
  child.unref();
  // Await completion while Pi is alive so replacement cannot race the old cascade.
  return finished;
}
