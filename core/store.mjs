import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { ownerState, requireProcessSupport } from "./lib/process.mjs";
import { acquireLock, atomicJSON, readJSON, sessionId } from "./lib/state.mjs";

const registryWait = new Int32Array(new SharedArrayBuffer(4));
export function stateDirectory(value = process.env.PI_PROJECTS_STATE_DIR ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-projects")) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error("stateDir must be an absolute printable path");
  return resolve(value);
}
export function projectDirectory(stateDir, projectRoot) {
  if (!isAbsolute(stateDir || "") || !isAbsolute(projectRoot || "")) throw new Error("State directory and project root must be absolute");
  const canonical = realpathSync(projectRoot);
  if (canonical !== projectRoot) throw new Error("Project root must be canonical");
  return join(stateDir, "projects", createHash("sha256").update(canonical).digest("hex"));
}

export class Store {
  constructor(stateDir, projectRoot) {
    requireProcessSupport();
    this.directory = projectDirectory(stateDir, projectRoot);
    this.projectRoot = projectRoot;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  transaction(fn) {
    if (this.inTransaction) return fn();
    // shortcut: synchronous contention can block the TUI for 2 s; use async retry if it becomes routine.
    const deadline = Date.now() + 2000;
    let lock;
    for (;;) {
      try { lock = acquireLock(join(this.directory, "locks", "registry")); break; }
      catch (error) {
        if (error.code !== "ELOCKED" || Date.now() >= deadline) throw error;
        Atomics.wait(registryWait, 0, 0, 10);
      }
    }
    this.inTransaction = true;
    try { return fn(); } finally { this.inTransaction = false; lock.release(); }
  }
  record(id) {
    const record = readJSON(join(this.directory, "records", `${sessionId(id)}.json`));
    if (record && (record.version !== 1 || record.id !== id || record.projectRoot !== this.projectRoot)) throw new Error("Stored session version/identity/project mismatch");
    return record;
  }
  records() {
    const directory = join(this.directory, "records");
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => name.endsWith(".json")).map(name => this.record(name.slice(0, -5)));
  }
  save(record) {
    if (record.projectRoot !== this.projectRoot) throw new Error("Cannot save a different project's session");
    return atomicJSON(join(this.directory, "records"), `${sessionId(record.id)}.json`, { ...record, version: 1 });
  }
  claimThread(record, { uniqueTitle = false } = {}) {
    return this.transaction(() => {
      const siblings = this.records().filter(candidate => candidate.role === "thread" && candidate.coordinator === record.coordinator);
      if (uniqueTitle) {
        const titles = new Set(siblings.map(candidate => candidate.title));
        let title = record.title, suffix = 2;
        while (titles.has(title)) title = `${record.title} ${suffix++}`;
        return { created: true, record: this.save({ ...record, title }) };
      }
      const existing = siblings.find(candidate => candidate.title === record.title);
      return existing ? { created: false, record: existing } : { created: true, record: this.save(record) };
    });
  }
  patch(id, changes) { return this.transaction(() => {
    const record = this.record(id);
    if (!record) throw new Error(`Unknown session ${id}`);
    return this.save({ ...record, ...changes });
  }); }
  inbox(id) { return join(this.directory, "inboxes", sessionId(id)); }
  publish(envelope) {
    return this.transaction(() => {
      sessionId(envelope.id); sessionId(envelope.recipient);
      if (envelope.projectRoot !== this.projectRoot || !this.record(envelope.recipient)) throw new Error("Message recipient is not registered in this project");
      try { atomicJSON(this.inbox(envelope.recipient), `${envelope.id}.json`, envelope, true); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const old = readJSON(join(this.inbox(envelope.recipient), `${envelope.id}.json`));
        if (JSON.stringify(old) !== JSON.stringify(envelope)) throw new Error("Message ID collision with different content");
      }
      return envelope;
    });
  }
  publishInitial(id) {
    const record = this.record(id);
    if (!record?.initial) return;
    if (record.registration !== "registered" || record.owner?.pid !== process.pid || ownerState(record.owner) !== "live") {
      throw new Error("Initial instruction must wait for this session's live extension registration");
    }
    if (record.initial.recipient !== id) throw new Error("Initial instruction recipient differs from launch claim");
    this.publish(record.initial);
  }
  messages(id, recorded = new Set()) {
    const directory = this.inbox(id);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => name.endsWith(".json") && !recorded.has(name.slice(0, -5))).map(name => {
      const message = readJSON(join(directory, name));
      if (message.id !== name.slice(0, -5) || message.recipient !== id || message.projectRoot !== this.projectRoot || typeof message.created !== "string") {
        throw new Error("Inbox message identity/project mismatch");
      }
      return message;
    }).sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  }
  delivery(id, messageId) {
    const value = readJSON(join(this.directory, "deliveries", sessionId(id), `${sessionId(messageId)}.json`));
    if (value && value.version !== 1) throw new Error("Unsupported delivery version");
    return value;
  }
  mark(id, messageId, value) { return atomicJSON(join(this.directory, "deliveries", sessionId(id)), `${sessionId(messageId)}.json`, { ...value, version: 1 }); }
  control(id, value) {
    const directory = join(this.directory, "controls");
    if (value !== undefined) return atomicJSON(directory, `${sessionId(id)}.json`, { ...value, version: 1 });
    const control = readJSON(join(directory, `${sessionId(id)}.json`), { version: 1, paused: false });
    if (control.version !== 1 || typeof control.paused !== "boolean") throw new Error("Invalid pause control");
    return control;
  }
}

