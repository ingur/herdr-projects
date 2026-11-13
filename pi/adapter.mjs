import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

// record.adapter: { sessionId, sessionFile, command: Pi argv prefix, env: values of ENV }
export const ENV = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PROJECTS_STATE_DIR", "PI_PROJECTS_PI_COMMAND", "PATH"];

function command(record) {
  const { command } = record.adapter;
  if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== "string" || !arg)) {
    throw new Error("No Pi command is recorded for this project; open the project in Pi once to record it");
  }
  return command;
}

export function start(record) {
  return [...command(record), "--name", record.title];
}

// --session-id only finds sessions of the current folder, so the file wins once it exists.
export function resume(record) {
  const { sessionFile, sessionId } = record.adapter;
  if (typeof sessionFile === "string" && existsSync(sessionFile)) return [...command(record), "--session", sessionFile];
  if (typeof sessionId === "string") return [...command(record), "--session-id", sessionId];
}

export function env(record) {
  const values = record.adapter.env ?? {};
  return Object.fromEntries(ENV.filter(key => typeof values[key] === "string").map(key => [key, values[key]]));
}

export function inherit(record) {
  return { command: record.adapter.command, env: env(record) };
}

function inside(root, path) {
  let real;
  try { real = realpathSync(root); } catch { return false; }
  const tail = relative(real, path);
  return tail !== ".." && !tail.startsWith("../") && !isAbsolute(tail);
}

function header(path) {
  const buffer = Buffer.alloc(64 * 1024), fd = openSync(path, "r");
  let length;
  try { length = readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
  try { return JSON.parse(buffer.subarray(0, length).toString("utf8").split("\n")[0]); } catch { return undefined; }
}

// Deletes the transcript only when it is a regular file in a Pi sessions directory whose header names this conversation.
export function remove(record) {
  const { sessionFile, sessionId } = record.adapter;
  if (typeof sessionFile !== "string" || typeof sessionId !== "string" || !isAbsolute(sessionFile)) return;
  if (!lstatSync(sessionFile, { throwIfNoEntry: false })?.isFile()) return;
  const values = env(record), folder = realpathSync(dirname(sessionFile));
  const roots = [values.PI_CODING_AGENT_SESSION_DIR, join(values.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions")];
  if (!roots.some(root => root && inside(root, folder))) return;
  const value = header(sessionFile);
  if (value?.type !== "session" || value.id !== sessionId) return;
  rmSync(sessionFile);
}
