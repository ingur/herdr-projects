import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

// record.adapter: { sessionId, sessionFile, command: Pi argv prefix, env: values of ENV }
export const ENV = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PROJECTS_PI_COMMAND", "PATH"];

function command(record) {
  const { command } = record.adapter;
  if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== "string" || !arg)) {
    throw new Error("No Pi command is recorded for this project; open the project in Pi once to record it");
  }
  if (isAbsolute(command[0]) && !existsSync(command[0])) throw new Error(`Pi is no longer at ${command[0]}; start Pi and use /projects resume`);
  return command;
}

export function start(record, coordinator) {
  return [...command(coordinator), "--name", record.title];
}

// --session-id only finds sessions of the current folder, so the file wins once it exists.
export function resume(record, coordinator) {
  const { sessionFile, sessionId } = record.adapter;
  if (typeof sessionFile === "string" && existsSync(sessionFile)) return [...command(coordinator), "--session", sessionFile];
  if (typeof sessionId === "string") return [...command(coordinator), "--session-id", sessionId];
}

export function env(record) {
  const values = record.adapter.env ?? {};
  return Object.fromEntries(ENV.filter(key => typeof values[key] === "string").map(key => [key, values[key]]));
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
