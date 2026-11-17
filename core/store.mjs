import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A waiter writes its lock file before it waits, so LOCK_STALE covers LOCK_WAIT plus far more than any real hold.
const LOCK_WAIT = 120_000, LOCK_STALE = 10 * 60_000;

export function stateDirectory(value = process.env.PROJECTS_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "herdr-projects")) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("stateDir must be an absolute path");
  return resolve(value);
}

const recordPath = (stateDir, id) => join(stateDir, "sessions", `${id}.json`);

export function readRecord(stateDir, id) {
  if (typeof id !== "string" || !UUID.test(id)) return undefined;
  let record;
  try { record = JSON.parse(readFileSync(recordPath(stateDir, id), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  if (record?.version !== 3 || record.id !== id) throw new Error(`Session record ${id} is not a version 3 record`);
  return record;
}

export function readRecords(stateDir) {
  let names;
  try { names = readdirSync(join(stateDir, "sessions")); }
  catch (error) { if (error.code === "ENOENT") return { records: [], errors: [] }; throw error; }
  const records = [], errors = [];
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    if (!name.endsWith(".json") || !UUID.test(id)) continue;
    try {
      const record = readRecord(stateDir, id);
      if (record) records.push(record);
    } catch (error) { errors.push({ id, error: error.message }); }
  }
  return { records, errors };
}

export function findRecord(stateDir, predicate) {
  return readRecords(stateDir).records.find(predicate);
}

function atomicWrite(path, content, mode) {
  const temporary = join(dirname(path), `.${path.split("/").pop()}.${randomUUID()}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, content, { mode });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function writeRecord(stateDir, record) {
  atomicWrite(recordPath(stateDir, record.id), JSON.stringify(record, null, 2) + "\n", 0o600);
  return record;
}

export function writeExecutable(path, content) {
  atomicWrite(path, content, 0o755);
}

export function removeRecord(stateDir, id) {
  rmSync(recordPath(stateDir, id), { force: true });
}

const toolPath = (stateDir, agent) => join(stateDir, "tools", `${agent}.json`);

export function readTool(stateDir, agent) {
  try { return JSON.parse(readFileSync(toolPath(stateDir, agent), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { env: {} }; throw error; }
}

export function writeTool(stateDir, agent, tool) {
  atomicWrite(toolPath(stateDir, agent), JSON.stringify(tool, null, 2) + "\n", 0o600);
}

// The user's mail: one file per message. Its name is the key and sorts by time, so no lock is needed.
const KEY = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let last = 0;

export function writeMail(stateDir, message) {
  // Strictly increasing, so one sender's messages keep their order within a millisecond.
  last = Math.max(Date.now(), last + 1);
  atomicWrite(join(stateDir, "user", `${last}-${randomUUID()}.json`), JSON.stringify(message, null, 2) + "\n", 0o600);
}

// Removes the mail named in `taken`, then returns what waits, oldest first. A file that cannot be read
// (cut short by a crash, say) is listed in `errors` with its key, so it never hides the rest.
export function collectMail(stateDir, taken = []) {
  if (!Array.isArray(taken) || taken.some(key => typeof key !== "string" || !KEY.test(key))) throw new Error("taken must be a list of keys from collect");
  for (const key of taken) rmSync(join(stateDir, "user", `${key}.json`), { force: true });
  let names;
  try { names = readdirSync(join(stateDir, "user")); }
  catch (error) { if (error.code === "ENOENT") return { messages: [] }; throw error; }
  const messages = [], errors = [];
  for (const name of names.filter(name => name.endsWith(".json") && KEY.test(name.slice(0, -".json".length))).sort()) {
    const key = name.slice(0, -".json".length);
    try { messages.push({ key, ...JSON.parse(readFileSync(join(stateDir, "user", name), "utf8")) }); }
    catch (error) { if (error.code !== "ENOENT") errors.push({ key, error: error.message }); }
  }
  return { messages, ...(errors.length ? { errors } : {}) };
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

// The lock file holds its owner's pid; a lock whose owner died, or that is stale (after a reboot the pid may be another process), is taken over.
function abandoned(path) {
  try { return Date.now() - statSync(path).mtimeMs > LOCK_STALE || !alive(Number(readFileSync(path, "utf8"))); }
  catch { return false; }
}

export async function locked(stateDir, id, fn, io = {}) {
  const path = join(stateDir, "locks", id), temporary = `${path}.${randomUUID()}`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, String(process.pid), { mode: 0o600 });
  try {
    for (let waited = 0; ; waited += 100) {
      try { linkSync(temporary, path); break; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      if (abandoned(path)) { rmSync(path, { force: true }); continue; }
      if (waited >= LOCK_WAIT) throw new Error("This session is busy; try again");
      await (io.delay ?? delay)(100);
    }
  } finally { rmSync(temporary, { force: true }); }
  try { return await fn(); }
  finally { rmSync(path, { force: true }); }
}

// Read-modify-write for a caller that already holds the session's lock.
export function rewrite(stateDir, id, change) {
  const record = readRecord(stateDir, id);
  if (!record) throw new Error(`No session ${id}`);
  return writeRecord(stateDir, { ...record, ...change(record) });
}

export function update(stateDir, id, change, io = {}) {
  return locked(stateDir, id, () => rewrite(stateDir, id, change), io);
}
