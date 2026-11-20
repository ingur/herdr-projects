import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A waiter writes its lock file before it waits, so LOCK_STALE covers LOCK_WAIT plus far more than any real hold.
const LOCK_WAIT = 120_000, LOCK_STALE = 10 * 60_000;

export function stateDirectory(value = process.env.PROJECTS_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "herdr-projects")) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("stateDir must be an absolute path");
  return resolve(value);
}

export function writeFile(path, content, mode = 0o600) {
  const temporary = join(dirname(path), `.${path.split("/").pop()}.${randomUUID()}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, content, { mode });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

export function fileNames(directory) {
  try { return readdirSync(directory).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

const recordPath = (stateDir, id) => join(stateDir, "records", `${id}.json`);

export function readRecord(stateDir, id) {
  if (typeof id !== "string" || !UUID.test(id)) return undefined;
  const record = readJson(recordPath(stateDir, id));
  if (record && (record.version !== 4 || record.id !== id)) throw new Error(`Session record ${id} is not a version 4 record`);
  return record;
}

export function readRecords(stateDir) {
  const records = [], errors = [];
  for (const name of fileNames(join(stateDir, "records"))) {
    const id = name.slice(0, -".json".length);
    if (!name.endsWith(".json") || !UUID.test(id)) continue;
    try {
      const record = readRecord(stateDir, id);
      if (record) records.push(record);
    } catch (error) { errors.push({ id, error: error.message }); }
  }
  return { records, errors };
}

export function session(stateDir, id) {
  if (typeof id !== "string") throw new Error("A session is named by its id");
  const record = readRecord(stateDir, id);
  if (!record) throw new Error(`No session ${id}`);
  return record;
}

export function writeRecord(stateDir, record) {
  writeJson(recordPath(stateDir, record.id), record);
  return record;
}

export function removeRecord(stateDir, id) {
  rmSync(recordPath(stateDir, id), { force: true });
}

const environmentPath = stateDir => join(stateDir, "environment.json");
export const readEnvironment = stateDir => readJson(environmentPath(stateDir)) ?? {};
export const writeEnvironment = (stateDir, env) => writeJson(environmentPath(stateDir), env);

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
  const record = session(stateDir, id);
  return writeRecord(stateDir, { ...record, ...change(record) });
}

export function update(stateDir, id, change, io = {}) {
  return locked(stateDir, id, () => rewrite(stateDir, id, change), io);
}
