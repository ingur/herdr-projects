import { isAbsolute } from "node:path";
import * as mailbox from "./mailbox.mjs";
import * as messages from "./messages.mjs";
import { changed, closeThreads, create, identity, remember, rename, reopenThreads, rowsOf, title, touch } from "./sessions.mjs";
import { locked, readRecord, readRecords, removeRecord, rewrite, session, stateDirectory, update, writeEnvironment } from "./state.mjs";
import * as terminals from "../herdr/terminals.mjs";

function conversation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !value.id) {
    throw new Error("conversation must be an object with the agent's own id for it");
  }
  return value;
}

async function bind(stateDir, id, row, pid, talk, io) {
  await locked(stateDir, id, async () => {
    const observed = await terminals.observe(io, id);
    const other = observed.labelled.find(live => live.address !== row.address && terminals.holds(live, id));
    if (other) throw new Error(`This session is already open in terminal ${other.address}`);
    await terminals.bind(io, stateDir, id, row, pid);
    await terminals.vacate(io, observed.labelled, id, row.address);
    const { space, tab } = terminals.place(row);
    rewrite(stateDir, id, record => ({ conversation: talk, space: space ?? record.space, tab: tab ?? record.tab }));
  }, io);
}

function retire(stateDir, record, row, io) {
  return locked(stateDir, record.id, async () => {
    if (record.kind !== "plain" || io.adapter.resume(record.conversation) || mailbox.waiting(stateDir, record.id)) return false;
    await terminals.unlabel(io, row);
    removeRecord(stateDir, record.id);
    mailbox.discard(stateDir, record.id);
    return true;
  }, io);
}

// The session stops running in this terminal. `label` says what the terminal keeps: unbind or unlabel.
async function release(stateDir, record, row, io, label) {
  if (await retire(stateDir, record, row, io)) return;
  await remember(stateDir, record.id, row, io);
  await label(io, row);
  if (record.kind === "coordinator") await closeThreads(stateDir, record.id, io, await rowsOf(io, stateDir, record));
  await changed(stateDir, record.id, io);
}

async function told(stateDir, id, io, extra = {}) {
  await touch(io, id);
  return { session: identity(session(stateDir, id)), ...extra };
}

export async function enter(options, io) {
  const stateDir = stateDirectory(options.stateDir), talk = conversation(options.conversation);
  if (typeof options.terminal !== "string" || !options.terminal) throw new Error("terminal must name the agent's terminal");
  if (!Number.isInteger(options.pid) || options.pid <= 0) throw new Error("pid must be the agent's process id");
  if (typeof options.folder !== "string" || !isAbsolute(options.folder)) throw new Error("folder must be an absolute path");
  const read = () => terminals.read(io, options.terminal), seen = await read();
  // A terminal that core is starting is read again under its session's lock, once it says all it will.
  const starting = readRecord(stateDir, terminals.session(seen));
  const row = starting ? await locked(stateDir, starting.id, read, io) : seen;
  if (!terminals.live(row)) throw new Error(`Terminal ${row.address} is not live`);
  const label = terminals.session(row), here = terminals.holds(row, label) ? readRecord(stateDir, label) : undefined;
  const reported = terminals.reported(row), mine = terminals.agentPid(row) === options.pid;
  if (here && reported && !mine) throw new Error(`Terminal ${row.address} already runs the session ${here.title}`);
  const started = reported ? undefined : here, kept = reported ? here : undefined;
  const same = kept && (options.replaced || kept.conversation?.id === talk.id);
  const known = started ?? (same ? kept : readRecords(stateDir).records.find(record => record.conversation?.id === talk.id));
  if (kept && kept.id !== known?.id) await release(stateDir, kept, row, io, terminals.unlabel);
  const record = known ?? create(stateDir, { kind: "plain", title: "New session", titleSource: "placeholder", folder: options.folder });
  try {
    await bind(stateDir, record.id, row, options.pid, talk, io);
  } catch (error) {
    if (!known) removeRecord(stateDir, record.id);
    throw error;
  }
  const env = options.env ?? {};
  writeEnvironment(stateDir, Object.fromEntries(io.adapter.variables.filter(key => typeof env[key] === "string").map(key => [key, env[key]])));
  terminals.writeControl(stateDir);
  const opening = kept?.id !== record.id;
  return told(stateDir, record.id, io, record.kind === "coordinator" && opening ? await reopenThreads(stateDir, record, io) : {});
}

export async function leave(options, io) {
  const stateDir = stateDirectory(options.stateDir), row = await terminals.read(io, options.terminal);
  const held = terminals.agentPid(row) === options.pid ? readRecord(stateDir, terminals.session(row)) : undefined;
  if (held) await release(stateDir, held, row, io, terminals.unbind);
  return {};
}

export function current(options) {
  const record = readRecord(stateDirectory(options.stateDir), options.id);
  return record ? { session: identity(record) } : {};
}

export async function project(options, io) {
  const stateDir = stateDirectory(options.stateDir), name = options.title === undefined ? undefined : title(options.title);
  await update(stateDir, options.id, record => {
    if (record.kind !== "plain") throw new Error(record.kind === "thread" ? "A thread cannot become a project" : "This session is already a project");
    const named = name ? { title: name, titleSource: "user" } : record.titleSource === "placeholder" ? { title: "New project" } : {};
    return { kind: "coordinator", project: record.id, ...named };
  }, io);
  return told(stateDir, options.id, io);
}

export async function named(options, io) {
  const stateDir = stateDirectory(options.stateDir);
  await rename(stateDir, session(stateDir, options.id), options.title, "user", io);
  return { session: identity(session(stateDir, options.id)) };
}

export function mail(options) {
  const stateDir = stateDirectory(options.stateDir), { items, errors } = mailbox.read(stateDir, session(stateDir, options.id).id);
  return { items: items.map(item => ({ ...item, content: messages.wrap(item) })), ...(errors ? { errors } : {}) };
}

export async function stored(options, io) {
  const stateDir = stateDirectory(options.stateDir), { id } = session(stateDir, options.id);
  mailbox.remove(stateDir, id, options.ids);
  await touch(io, id);
  return {};
}

export async function typed(options, io) {
  const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
  if (record.resolved) {
    await update(stateDir, record.id, () => ({ resolved: false }), io);
    await touch(io, record.id);
  }
  return messages.typed(stateDir, record, options.text);
}

export function answered(options) {
  const stateDir = stateDirectory(options.stateDir);
  messages.answered(stateDir, session(stateDir, options.id), options.text);
  return {};
}

export function watch(options, changed) {
  const stateDir = stateDirectory(options.stateDir);
  return mailbox.watch(stateDir, session(stateDir, options.id).id, changed);
}
