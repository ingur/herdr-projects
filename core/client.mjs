import { isAbsolute } from "node:path";
import * as log from "./log.mjs";
import * as mailbox from "./mailbox.mjs";
import * as messages from "./messages.mjs";
import * as sessions from "./sessions.mjs";
import { readRecord, removeRecord, session, stateDirectory, update } from "./state.mjs";
import * as terminals from "./terminals.mjs";
import * as threads from "./threads.mjs";

function space(value) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("space must be a herdr space id");
  return value;
}

export const list = (options = {}, io) => sessions.list(stateDirectory(options.stateDir), io);

export async function send(options, io) {
  return messages.send(stateDirectory(options.stateDir), undefined, options.to, options.text, undefined, io);
}

export async function collect(options = {}) {
  const stateDir = stateDirectory(options.stateDir), wait = options.wait ?? 0;
  if (!Number.isFinite(wait) || wait < 0) throw new Error("wait must be a number of seconds");
  mailbox.remove(stateDir, "user", options.taken ?? []);
  if (wait) await mailbox.arrival(stateDir, "user", wait);
  const { items, errors } = mailbox.read(stateDir, "user");
  return { messages: items, ...(errors ? { errors } : {}) };
}

export async function open(options, io) {
  const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
  const launched = await sessions.launch(stateDir, record.id, io, options.space === undefined ? undefined : space(options.space));
  const { terminal } = await terminals.observe(io, record.id);
  if (terminal) await sessions.remember(stateDir, record.id, terminal, io);
  return sessions.changed(stateDir, record.id, io, launched);
}

export async function close(options, io) {
  const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
  await sessions.close(stateDir, record, io);
  return sessions.changed(stateDir, record.id, io);
}

export async function rename(options, io) {
  const stateDir = stateDirectory(options.stateDir);
  return sessions.rename(stateDir, session(stateDir, options.id), options.title, "user", io);
}

export async function order(options, io) {
  const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
  if (!Number.isFinite(options.rank)) throw new Error("rank must be a number");
  await update(stateDir, record.id, () => ({ rank: options.rank }), io);
  return sessions.changed(stateDir, record.id, io);
}

async function whileStopped(options, io, change) {
  const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
  if ((await terminals.observe(io, record.id)).state !== "stopped") throw new Error("Close the session before moving it");
  await update(stateDir, record.id, () => change, io);
  return sessions.changed(stateDir, record.id, io);
}

export async function place(options, io) {
  return whileStopped(options, io, { space: space(options.space) });
}

export async function move(options, io) {
  if (typeof options.folder !== "string" || !isAbsolute(options.folder)) throw new Error("folder must be an absolute path");
  if (!sessions.isFolder(options.folder)) throw new Error(`${options.folder} is not a folder`);
  return whileStopped(options, io, { folder: options.folder });
}

async function remove(options, io) {
  const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id), rows = await sessions.rowsOf(io, stateDir, record);
  const drop = async target => {
    await terminals.stop(io, rows, target.id);
    await terminals.vacate(io, rows, target.id);
    const remaining = readRecord(stateDir, target.id);
    if (remaining?.conversation) io.adapter.remove(remaining.conversation);
    removeRecord(stateDir, target.id);
    mailbox.discard(stateDir, target.id);
    return target.id;
  };
  const deleted = [...await Promise.all(sessions.threads(stateDir, record.id).map(drop)), await drop(record)];
  if (record.kind === "coordinator") log.discard(stateDir, record.id);
  if (record.kind === "thread") await sessions.touch(io, record.project);
  return { deleted };
}
export { remove as delete };

export async function createThread(options, io) {
  const stateDir = stateDirectory(options.stateDir);
  return threads.start(stateDir, session(stateDir, options.coordinator), { title: options.title, folder: options.folder }, "user", io);
}

export async function resolve(options, io) {
  const stateDir = stateDirectory(options.stateDir);
  return threads.resolve(stateDir, session(stateDir, options.id), "user", io);
}

export async function unresolve(options, io) {
  const stateDir = stateDirectory(options.stateDir);
  return threads.unresolve(stateDir, session(stateDir, options.id), io);
}
