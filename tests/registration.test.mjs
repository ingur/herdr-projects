import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processIdentity } from "../core/lib/process.mjs";
import { atomicJSON, lockState } from "../core/lib/state.mjs";
import { acquireSessionLocks, findSessionRecord, isWriterConflict, messageNeedsTurn, observeTranscript, registerCurrentSession, releaseSessionRegistration, shutdownProjectThreads, unregisterCurrentSession } from "../pi/registration.mjs";
import { checkedSessionFile, piLaunchCommand } from "../pi/pi-launch.mjs";
import { Store, stateDirectory } from "../core/store.mjs";
import { listSessions } from "../core/control.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-registration-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project"), stateDir = join(root, "state"), sessionDir = join(root, "normal-pi-sessions");
  mkdirSync(projectRoot); mkdirSync(sessionDir);
  const id = randomUUID(), sessionFile = join(sessionDir, "existing.jsonl");
  const transcript = JSON.stringify({ type: "session", version: 3, id, cwd: projectRoot }) + "\n" +
    JSON.stringify({ type: "message", id: "human", message: { role: "user", content: "Already discussing the project" } }) + "\n";
  writeFileSync(sessionFile, transcript);
  const store = new Store(stateDir, projectRoot);
  const binding = { id, agent: "pi", cwd: projectRoot, title: "Existing conversation", sessionFile, sessionDir,
    terminal: "t1", owner: { ...processIdentity(), token: randomUUID() } };
  return { root, store, binding, stateDir, projectRoot, transcript };
}

test("unregistered sessions remain dormant without creating state", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-dormant-"))), state = join(root, "missing");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(findSessionRecord(state, randomUUID()), undefined);
  assert.equal(existsSync(state), false);
  assert.equal(stateDirectory(join(root, "selected")), join(root, "selected"));
  assert.throws(() => stateDirectory("relative"), /absolute/);
});

test("promotion and lookup by session UUID retain conversation, root, role and optional placement", t => {
  const f = fixture(t), locks = acquireSessionLocks(f.stateDir, f.store, f.binding.id);
  let promoted;
  try { promoted = registerCurrentSession(f.store, { ...f.binding, owner: locks[0].owner, promote: true, title: "My project" }); }
  finally { for (const lock of locks.reverse()) lock.release(); }
  for (const key of ["id", "sessionFile", "sessionDir", "terminal", "cwd"]) assert.equal(promoted[key], f.binding[key]);
  assert.equal(promoted.version, 1); assert.equal(promoted.space, undefined); assert.equal(promoted.tab, undefined);
  assert.equal(promoted.role, "coordinator"); assert.equal(promoted.coordinator, f.binding.id);
  assert.equal(findSessionRecord(f.stateDir, f.binding.id).projectRoot, f.projectRoot);
  assert.equal(registerCurrentSession(f.store, { ...f.binding, promote: true, title: "Not a rename" }).title, "My project");
  const otherRoot = join(f.root, "unrelated-project"); mkdirSync(otherRoot); new Store(f.stateDir, otherRoot);
  assert.equal(findSessionRecord(f.stateDir, f.binding.id).id, f.binding.id);
  const id = randomUUID(), file = join(f.binding.sessionDir, "thread.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", id, cwd: f.projectRoot }) + "\n");
  f.store.save({ id, agent: "pi", projectRoot: f.projectRoot, cwd: f.projectRoot, role: "thread", coordinator: promoted.id,
    title: "Retained thread", titleSource: "agent", resolved: true, registration: "awaiting-extension", reopenWithProject: true });
  const thread = registerCurrentSession(f.store, { ...f.binding, id, sessionFile: file });
  assert.equal(thread.role, "thread"); assert.equal(thread.coordinator, promoted.id); assert.equal(thread.resolved, true);
  assert.equal(thread.reopenWithProject, undefined, "individual registration consumes its project-reopen mark");
  assert.throws(() => registerCurrentSession(f.store, { ...f.binding, id, promote: true }), /already registered as a thread/);
  assert.deepEqual(piLaunchCommand(promoted, f.stateDir), [join(f.stateDir, "bin", "pi"), "--session", f.binding.sessionFile]);
  assert.equal(readFileSync(f.binding.sessionFile, "utf8"), f.transcript);
});

test("foreign live writer is refused before registration or transcript writes", async t => {
  const f = fixture(t);
  registerCurrentSession(f.store, { ...f.binding, promote: true });
  const recordFile = join(f.store.directory, "records", `${f.binding.id}.json`), saved = readFileSync(recordFile, "utf8");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  try {
    atomicJSON(join(f.stateDir, "writer-locks", f.binding.id), `${randomUUID()}.json`, { ...processIdentity(child.pid), token: randomUUID() });
    assert.throws(() => acquireSessionLocks(f.stateDir, f.store, f.binding.id), error => error.code === "ELOCKED" && isWriterConflict(error));
    assert.equal(isWriterConflict({ code: "ELOCKED" }), false, "unrelated registry contention must not claim another session writer");
    assert.equal(readFileSync(recordFile, "utf8"), saved);
    assert.equal(readFileSync(f.binding.sessionFile, "utf8"), f.transcript);
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited;
  }
});

test("unwritten sessions may rebind once, but observed transcript loss and different identities fail closed", t => {
  const f = fixture(t), never = join(f.binding.sessionDir, "never-written.jsonl");
  registerCurrentSession(f.store, { ...f.binding, promote: true, sessionFile: never });
  assert.equal(checkedSessionFile(f.store.record(f.binding.id)), undefined);
  assert.equal(observeTranscript(f.store, { id: f.binding.id, sessionFile: never }), false);
  const next = join(f.binding.sessionDir, "next.jsonl");
  registerCurrentSession(f.store, { ...f.binding, sessionFile: next });
  writeFileSync(next, f.transcript);
  observeTranscript(f.store, { id: f.binding.id, sessionFile: next });
  assert.throws(() => registerCurrentSession(f.store, f.binding), /differs/);
  rmSync(next);
  assert.equal(unregisterCurrentSession(f.store, { id: f.binding.id, sessionFile: next }).transcriptState, "expected");
  assert.throws(() => checkedSessionFile(f.store.record(f.binding.id)), /expected conversation transcript is missing/);
  f.store.patch(f.binding.id, { agent: "another-agent" });
  assert.throws(() => registerCurrentSession(f.store, { ...f.binding, sessionFile: next }), /another agent runtime/);
});

test("records, controls and delivery attempts write schema version one", t => {
  const f = fixture(t), id = f.binding.id, message = randomUUID();
  registerCurrentSession(f.store, { ...f.binding, promote: true });
  f.store.control(id, { paused: true }); f.store.mark(id, message, { state: "attempting", execution: "unknown" });
  for (const path of [join(f.store.directory, "records", `${id}.json`), join(f.store.directory, "controls", `${id}.json`), join(f.store.directory, "deliveries", id, `${message}.json`)]) {
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);
  }
});

test("initial and queued project messages request turns without a human prompt; notices never wake", () => {
  assert.equal(messageNeedsTurn({ text: "Initial thread instruction" }), true);
  assert.equal(messageNeedsTurn({ text: "Queued before reopen or reload", informational: false }), true);
  assert.equal(messageNeedsTurn({ informational: true }), false);
});

test("replacement releases the old live-process registration and labels; a fork stays ordinary and resume rebinds placement", async t => {
  const f = fixture(t), locks = acquireSessionLocks(f.stateDir, f.store, f.binding.id);
  registerCurrentSession(f.store, { ...f.binding, owner: locks[0].owner, promote: true, space: "old-space", tab: "old-tab" });
  const row = { address: "t1", state: "live", pid: process.pid, labels: {
    "projects.session": f.binding.id, "projects.project": f.store.directory.split("/").pop(),
    "projects.control": "descriptor", "projects.launch": "claim", "herdr.space": "old-space", "herdr.tab": "old-tab" } };
  const io = { command: async (_program, args) => {
    if (args[0] === "ls") return { terminals: [row] };
    if (args[0] === "label") {
      assert.equal(lockState(join(f.stateDir, "writer-locks", f.binding.id)), "live", "hold ownership through label cleanup");
      for (const arg of args.slice(3)) { assert.ok(arg.endsWith("=")); delete row.labels[arg.slice(0, -1)]; }
    }
    return row;
  } };
  await releaseSessionRegistration({ ...f.binding, stateDir: f.stateDir, projectRoot: f.projectRoot, store: f.store, locks }, io);
  assert.equal(lockState(join(f.stateDir, "writer-locks", f.binding.id)), "dead");
  assert.equal(lockState(join(f.store.directory, "locks", `extension-${f.binding.id}`)), "dead");
  const stopped = f.store.record(f.binding.id);
  assert.equal(stopped.registration, "offline");
  assert.equal(stopped.owner, undefined);
  assert.ok(stopped.observed);
  const view = (await listSessions({ stateDir: f.stateDir }, io)).sessions[0];
  assert.equal(view.writer, "dead", "the old process still lives but no longer owns this session");
  assert.equal(view.terminalOwned, false);
  assert.deepEqual(row.labels, { "herdr.space": "old-space", "herdr.tab": "old-tab" });
  const forkId = randomUUID();
  assert.equal(findSessionRecord(f.stateDir, forkId), undefined);
  assert.equal(registerCurrentSession(f.store, { ...f.binding, id: forkId }), undefined);
  assert.equal(f.store.records().length, 1);
  const resumedLocks = acquireSessionLocks(f.stateDir, f.store, f.binding.id);
  try {
    const resumed = registerCurrentSession(f.store, { ...f.binding, owner: resumedLocks[0].owner, terminal: "t2", space: "new-space", tab: "new-tab" });
    assert.equal(resumed.space, "new-space");
    assert.equal(resumed.tab, "new-tab");
    assert.equal(resumed.terminal, "t2");
  } finally { for (const lock of resumedLocks.reverse()) lock.release(); }
  assert.equal(readFileSync(f.binding.sessionFile, "utf8"), f.transcript);
});

test("failed label cleanup still saves an offline record and releases both writer locks", async t => {
  const f = fixture(t), locks = acquireSessionLocks(f.stateDir, f.store, f.binding.id);
  registerCurrentSession(f.store, { ...f.binding, owner: locks[0].owner, promote: true });
  await assert.rejects(releaseSessionRegistration({ ...f.binding, stateDir: f.stateDir, projectRoot: f.projectRoot, store: f.store, locks },
    { command: async () => { throw new Error("transport unavailable"); } }), /transport unavailable/);
  assert.equal(f.store.record(f.binding.id).registration, "offline");
  assert.equal(f.store.record(f.binding.id).owner, undefined);
  const next = acquireSessionLocks(f.stateDir, f.store, f.binding.id);
  for (const lock of next.reverse()) lock.release();
});

test("clean shutdown starts the stable control shim detached so it finishes after Pi's process exits", async t => {
  const f = fixture(t), output = join(f.root, "closed.json"), parentFile = join(f.root, "parent");
  const bin = join(f.stateDir, "bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "control"), `#!${process.execPath}
const fs = require("node:fs");
const parent = Number(fs.readFileSync(${JSON.stringify(parentFile)}, "utf8"));
const timer = setInterval(() => {
  try { process.kill(parent, 0); }
  catch (error) {
    if (error.code !== "ESRCH") throw error;
    clearInterval(timer);
    fs.writeFileSync(${JSON.stringify(output + ".tmp")}, JSON.stringify(process.argv.slice(2)));
    fs.renameSync(${JSON.stringify(output + ".tmp")}, ${JSON.stringify(output)});
  }
}, 10);
setTimeout(() => process.exit(1), 5000).unref();
`, { mode: 0o700 });
  let watcher;
  const written = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Detached control did not finish")), 7000);
    watcher = watch(f.root, () => {
      if (!existsSync(output)) return;
      clearTimeout(timer); watcher.close(); resolve();
    });
    t.after(() => { clearTimeout(timer); watcher.close(); });
  });
  const binding = { role: "coordinator", stateDir: f.stateDir, projectRoot: f.projectRoot, id: f.binding.id };
  const launcher = spawn(process.execPath, ["--input-type=module", "-e", `
import { writeFileSync } from "node:fs";
import { shutdownProjectThreads } from ${JSON.stringify(new URL("../pi/registration.mjs", import.meta.url).href)};
writeFileSync(${JSON.stringify(parentFile)}, String(process.pid));
shutdownProjectThreads(${JSON.stringify(binding)}, "quit");
process.exit(0);
`], { stdio: "ignore" });
  await new Promise((resolve, reject) => { launcher.once("error", reject); launcher.once("exit", code => code === 0 ? resolve() : reject(new Error(String(code)))); });
  await written;
  const [action, options] = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(action, "close-threads");
  assert.deepEqual(JSON.parse(options), { stateDir: f.stateDir, projectRoot: f.projectRoot, id: f.binding.id });
  await shutdownProjectThreads({ role: "thread" }, "quit");
  await shutdownProjectThreads({ role: "coordinator" }, "reload");
});
