import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_WAIT = 120_000;

export function stateDirectory(value = process.env.PROJECTS_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "projects")) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("stateDir must be an absolute path");
  return resolve(value);
}

const recordPath = (stateDir, id) => join(stateDir, "sessions", `${id}.json`);

export function readRecord(stateDir, id) {
  if (typeof id !== "string" || !UUID.test(id)) return undefined;
  let record;
  try { record = JSON.parse(readFileSync(recordPath(stateDir, id), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  if (record?.version !== 2 || record.id !== id) throw new Error(`Session record ${id} is not a version 2 record`);
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

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

// The lock file holds its owner's pid; a lock whose owner died is taken over.
function abandoned(path) {
  try { return !alive(Number(readFileSync(path, "utf8"))); }
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
