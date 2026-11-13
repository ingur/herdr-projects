#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { adapter, agents } from "./adapters.mjs";
import { hc, observe, statusWord } from "./hc.mjs";
import { findRecord, locked, readRecord, readRecords, removeRecord, rewrite, stateDirectory, update, writeExecutable, writeRecord } from "./store.mjs";

export { findRecord, readRecord, stateDirectory };

const STORED = {
  coordinator: "stored; it goes out when the user resumes the project",
  thread: "stored; it goes out when the thread starts",
};
const UNLABEL = ["projects.session=", "projects.control=", "projects.changed="];
const errorText = error => error instanceof Error ? error.message : String(error);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const descriptor = stateDir => JSON.stringify({ version: 2, command: [join(stateDir, "bin", "control")], stateDir });

function session(stateDir, id) {
  const record = readRecord(stateDir, id);
  if (!record) throw new Error(`No session ${id}`);
  return record;
}
function threads(stateDir, coordinator) {
  return readRecords(stateDir).records.filter(record => record.role === "thread" && record.coordinator === coordinator);
}
function title(value, role) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 80 || /[\x00-\x1f\x7f]/.test(trimmed)) throw new Error("A title is 1 to 80 printable characters");
  if (role === "thread" && trimmed.toLowerCase() === "coordinator") throw new Error("A thread cannot be called coordinator");
  return trimmed;
}
function author(value) {
  if (value !== "user" && value !== "agent") throw new Error('by must be "user" or "agent"');
  return value;
}
function messageText(value) {
  if (typeof value !== "string" || !value.length || value.length > 100000) throw new Error("A message is 1 to 100000 characters");
  return value;
}
function space(value) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("space must be a Herdr space id");
  return value;
}
function terminalName(record) {
  const slug = record.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 23).replace(/-+$/, "");
  return `${slug ? `${slug}-` : ""}${record.id.slice(0, 8)}`;
}

const escape = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function wrap({ from, title, id, text }) {
  const sender = from === "user" ? "" : ` title="${escape(title)}" id="${escape(id)}"`;
  return `<message from="${from}"${sender}>\n${text}\n</message>`;
}

function view(record, observed, error) {
  const live = observed?.terminal;
  return {
    id: record.id, role: record.role, coordinator: record.coordinator, title: record.title, titleSource: record.titleSource,
    cwd: record.cwd, agent: record.agent, resolved: record.resolved, rank: record.rank, created: record.created,
    space: live?.labels["herdr.space"] ?? record.space, tab: live?.labels["herdr.tab"] ?? record.tab,
    ...(live ? { terminal: live.address } : {}),
    state: observed?.state ?? "stopped",
    ...(observed?.status ? { status: observed.status } : {}),
    waiting: record.waiting.length,
    ...(error ? { error } : {}),
  };
}

// projects.changed tells the sidebar to refresh; a terminal that ended meanwhile needs no refresh.
const mark = (io, address) => hc(io, ["label", address, "--json", `projects.changed=${Date.now()}`]).catch(() => {});
async function touch(io, id) {
  const { terminal } = await observe(io, id).catch(() => ({}));
  if (terminal) await mark(io, terminal.address);
}

async function changed(stateDir, id, io, extra = {}) {
  const record = session(stateDir, id);
  let observed, error;
  try { observed = await observe(io, id); } catch (caught) { error = errorText(caught); }
  if (observed?.terminal) await mark(io, observed.terminal.address);
  else if (record.role === "thread") await touch(io, record.coordinator);
  const errors = [extra.error, error].filter(Boolean).join("; ");
  return { ...view(record, observed), ...extra, ...(errors ? { error: errors } : {}) };
}

function remember(stateDir, id, row, io) {
  return update(stateDir, id, record => ({ space: row.labels["herdr.space"] ?? record.space, tab: row.labels["herdr.tab"] ?? record.tab }), io);
}

async function running(io, id, seconds) {
  for (let second = 0; ; second++) {
    const observed = await observe(io, id);
    if (observed.state === "running" || second >= seconds) return observed;
    await (io.delay ?? delay)(1000);
  }
}

// Reads the terminal right before typing: a shell left behind the label reports no status and is never typed into.
async function type(io, id, address, message) {
  const row = await hc(io, ["get", address, "--json"]);
  const status = statusWord(row.status);
  if (row.state !== "live" || row.labels?.["projects.session"] !== id || !status) return { sent: false, note: "not typed: the session stopped; send it again" };
  if (status === "blocked") return { sent: false, note: "not typed: the session is waiting on the user" };
  const result = await hc(io, ["send", "--json", address, message]);
  return { sent: true, ...(result.started === false && (status === "idle" || status === "done") ? { note: "typed, but no turn started" } : {}) };
}

// Types waiting mail in order and removes each message once hc accepted it; the rest stays for the next register.
async function deliver(stateDir, id, io) {
  if (!session(stateDir, id).waiting.length) return {};
  try {
    const observed = await running(io, id, 60);
    if (observed.state !== "running") return {};
    await locked(stateDir, id, async () => {
      for (let [next] = session(stateDir, id).waiting; next; [next] = session(stateDir, id).waiting) {
        if (!(await type(io, id, observed.terminal.address, wrap(next))).sent) return;
        rewrite(stateDir, id, record => ({ waiting: record.waiting.slice(1) }));
      }
    }, io);
    return {};
  } catch (error) { return { error: errorText(error) }; }
}

async function launch(stateDir, id, io, place) {
  try {
    return await locked(stateDir, id, async () => {
      const record = session(stateDir, id), observed = await observe(io, id);
      if (observed.state !== "stopped") return {};
      for (const row of observed.live) await hc(io, ["label", row.address, "--json", ...UNLABEL]);
      let target = place ?? record.space;
      if (place === undefined && record.role === "thread") target = (await observe(io, record.coordinator)).terminal?.labels["herdr.space"] ?? target;
      const tab = target === undefined ? undefined : record.tab ?? `pt-${id}`;
      const module = await adapter(record.agent);
      const argv = module.resume(record) ?? module.start(record);
      const env = Object.entries(module.env(record)).map(([key, value]) => `${key}=${value}`);
      await hc(io, ["run", "--bg", "--json", "--no-parent", "--cwd", record.cwd, "--name", terminalName(record),
        ...(target === undefined ? [] : ["--label", `herdr.space=${target}`, "--label", `herdr.tab=${tab}`]),
        "--label", `projects.session=${id}`, "--label", `projects.control=${descriptor(stateDir)}`,
        "--", "env", ...env, `PROJECTS_SESSION=${id}`, ...argv]);
      rewrite(stateDir, id, () => ({ space: target, tab }));
      return {};
    }, io);
  } catch (error) { return { error: errorText(error) }; }
}

// hc has no conditional kill: the label is read again right before it.
async function stop(stateDir, id, io) {
  const { terminal } = await observe(io, id);
  if (!terminal) return;
  const current = await hc(io, ["get", terminal.address, "--json"]);
  if (current.state !== "live" || current.labels?.["projects.session"] !== id) return;
  await remember(stateDir, id, current, io);
  const killed = await hc(io, ["kill", current.address, "--json"]);
  if (killed.state !== "finished") throw new Error(`hc could not stop terminal ${current.address}`);
}

async function closeThreads(stateDir, coordinator, io) {
  for (const thread of threads(stateDir, coordinator)) {
    if (!(await observe(io, thread.id)).terminal) continue;
    await update(stateDir, thread.id, () => ({ reopenWithProject: true }), io);
    await stop(stateDir, thread.id, io);
  }
}

async function close(stateDir, record, io) {
  if (record.role === "coordinator") await closeThreads(stateDir, record.id, io);
  await stop(stateDir, record.id, io);
}

function writeShim(stateDir) {
  writeExecutable(join(stateDir, "bin", "control"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} "$@"\n`);
}

export const actions = {
  async list(options = {}, io = {}) {
    const stateDir = stateDirectory(options.stateDir);
    const { records, errors } = readRecords(stateDir);
    const sessions = await Promise.all(records.map(async record => {
      try { return view(record, await observe(io, record.id)); }
      catch (error) { return view(record, undefined, errorText(error)); }
    }));
    const ranks = new Map(sessions.filter(view => view.role === "coordinator").map(view => [view.id, view.rank]));
    sessions.sort((a, b) => (ranks.get(b.coordinator) ?? 0) - (ranks.get(a.coordinator) ?? 0) || a.coordinator.localeCompare(b.coordinator) ||
      Number(a.role === "thread") - Number(b.role === "thread") || Number(a.resolved) - Number(b.resolved) || b.rank - a.rank || a.id.localeCompare(b.id));
    return { sessions, ...(errors.length ? { errors } : {}) };
  },

  async register(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir);
    if (!agents.includes(options.agent)) throw new Error(`No adapter for agent ${JSON.stringify(options.agent)}`);
    if (typeof options.cwd !== "string" || !isAbsolute(options.cwd)) throw new Error("cwd must be an absolute path");
    if (!options.adapter || typeof options.adapter !== "object" || Array.isArray(options.adapter)) throw new Error("adapter must be an object");
    if (typeof options.terminal !== "string" || !options.terminal) throw new Error("terminal must name an hc terminal");
    const promoted = options.id === undefined, id = promoted ? randomUUID() : session(stateDir, options.id).id;
    if (promoted) {
      const created = new Date();
      writeRecord(stateDir, { version: 2, id, role: "coordinator", coordinator: id,
        title: options.title === undefined ? "New project" : title(options.title, "coordinator"),
        titleSource: options.title === undefined ? "placeholder" : "user",
        cwd: options.cwd, agent: options.agent, resolved: false, rank: created.getTime(), created: created.toISOString(), waiting: [], adapter: options.adapter });
    }
    try {
      await locked(stateDir, id, async () => {
        const row = await hc(io, ["get", options.terminal, "--json"]);
        if (row.state !== "live") throw new Error(`Terminal ${row.address} is not live`);
        const other = (await observe(io, id)).live.find(live => live.address !== row.address && statusWord(live.status));
        if (other) throw new Error(`This session is already open in terminal ${other.address}`);
        await hc(io, ["label", row.address, "--json", `projects.session=${id}`, `projects.control=${descriptor(stateDir)}`]);
        rewrite(stateDir, id, record => ({ cwd: options.cwd, agent: options.agent, adapter: options.adapter, reopenWithProject: undefined,
          space: row.labels["herdr.space"] ?? record.space, tab: row.labels["herdr.tab"] ?? record.tab }));
      }, io);
    } catch (error) {
      if (promoted) removeRecord(stateDir, id);
      throw error;
    }
    writeShim(stateDir);
    const errors = [];
    for (const thread of threads(stateDir, id).filter(thread => thread.reopenWithProject)) {
      await update(stateDir, thread.id, () => ({ reopenWithProject: undefined }), io);
      if (thread.resolved) continue;
      const { error } = await launch(stateDir, thread.id, io);
      if (error) errors.push(`${thread.title}: ${error}`);
    }
    const { error } = await deliver(stateDir, id, io);
    if (error) errors.push(error);
    return changed(stateDir, id, io, errors.length ? { error: errors.join("; ") } : {});
  },

  async release(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
    for (const row of (await observe(io, record.id)).live) {
      await remember(stateDir, record.id, row, io);
      await hc(io, ["label", row.address, "--json", ...UNLABEL]);
    }
    if (record.role === "coordinator") await closeThreads(stateDir, record.id, io);
    return changed(stateDir, record.id, io);
  },

  async "create-thread"(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), coordinator = session(stateDir, options.coordinator);
    if (coordinator.role !== "coordinator") throw new Error("Threads are created under a coordinator");
    const by = author(options.by), wanted = options.title === undefined ? undefined : title(options.title, "thread");
    const text = options.text === undefined ? undefined : messageText(options.text);
    if (options.cwd !== undefined && typeof options.cwd !== "string") throw new Error("cwd must be a path");
    const cwd = resolve(coordinator.cwd, options.cwd ?? ".");
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${cwd} is not a directory`);
    const inherited = (await adapter(coordinator.agent)).inherit(coordinator);
    const { existing, record } = await locked(stateDir, coordinator.id, () => {
      const siblings = threads(stateDir, coordinator.id), taken = new Set(siblings.map(thread => thread.title.toLowerCase()));
      const existing = wanted === undefined ? undefined : siblings.find(thread => thread.title.toLowerCase() === wanted.toLowerCase());
      if (existing && by === "agent") return { existing };
      if (existing) throw new Error(`A thread called ${existing.title} already exists`);
      let name = wanted ?? "New thread";
      for (let number = 2; taken.has(name.toLowerCase()); number++) name = `New thread ${number}`;
      const created = new Date();
      return { record: writeRecord(stateDir, { version: 2, id: randomUUID(), role: "thread", coordinator: coordinator.id, title: name,
        titleSource: wanted === undefined ? "placeholder" : by, cwd, agent: coordinator.agent, resolved: false,
        rank: created.getTime(), created: created.toISOString(),
        waiting: text === undefined ? [] : [{ from: "coordinator", title: coordinator.title, id: coordinator.id, text, created: created.toISOString() }],
        adapter: inherited }) };
    }, io);
    if (existing) return changed(stateDir, existing.id, io, { existing: true });
    const launched = await launch(stateDir, record.id, io);
    return changed(stateDir, record.id, io, launched.error ? launched : await deliver(stateDir, record.id, io));
  },

  async open(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
    const launched = await launch(stateDir, record.id, io, options.space === undefined ? undefined : space(options.space));
    const { terminal } = await observe(io, record.id);
    if (terminal) await remember(stateDir, record.id, terminal, io);
    return changed(stateDir, record.id, io, launched);
  },

  async send(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), recipient = session(stateDir, options.to);
    const sender = options.from === undefined ? undefined : session(stateDir, options.from), text = messageText(options.text);
    if (recipient.role === "thread" && recipient.resolved) {
      if (sender && sender.id !== recipient.coordinator) throw new Error("This thread is resolved; only its coordinator or the user can reopen it");
      await update(stateDir, recipient.id, () => ({ resolved: false }), io);
    }
    const message = { from: sender?.role ?? "user", ...(sender ? { title: sender.title, id: sender.id } : {}), text, created: new Date().toISOString() };
    let observed = await observe(io, recipient.id);
    if (observed.state === "starting") observed = await running(io, recipient.id, 30);
    if (observed.state === "running") return changed(stateDir, recipient.id, io, await type(io, recipient.id, observed.terminal.address, wrap(message)));
    await update(stateDir, recipient.id, record => ({ waiting: [...record.waiting, message] }), io);
    if (recipient.role === "coordinator") return changed(stateDir, recipient.id, io, { sent: false, note: STORED.coordinator });
    const launched = await launch(stateDir, recipient.id, io);
    const { error } = launched.error ? launched : await deliver(stateDir, recipient.id, io);
    const sent = !session(stateDir, recipient.id).waiting.length;
    return changed(stateDir, recipient.id, io, { sent, ...(sent ? {} : { note: STORED.thread }), ...(error ? { error } : {}) });
  },

  async rename(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
    const by = author(options.by), name = title(options.title, record.role);
    await update(stateDir, record.id, current => {
      if (by === "agent" && current.titleSource === "user") throw new Error("The user chose this title; an agent cannot change it");
      if (current.role === "thread" && threads(stateDir, current.coordinator).some(thread => thread.id !== current.id && thread.title.toLowerCase() === name.toLowerCase())) {
        throw new Error(`Another thread is already called ${name}`);
      }
      return { title: name, titleSource: by };
    }, io);
    return changed(stateDir, record.id, io);
  },

  async order(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
    if (!Number.isFinite(options.rank)) throw new Error("rank must be a number");
    await update(stateDir, record.id, () => ({ rank: options.rank }), io);
    return changed(stateDir, record.id, io);
  },

  async place(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id), target = space(options.space);
    if ((await observe(io, record.id)).state !== "stopped") throw new Error("Close the session before moving it");
    await update(stateDir, record.id, () => ({ space: target }), io);
    return changed(stateDir, record.id, io);
  },

  async resolve(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
    if (author(options.by) === "agent") {
      if (record.role !== "thread" || options.from !== record.coordinator) throw new Error("Only a thread's coordinator can resolve it");
      // A thread usually reports just before its turn ends; give that turn a moment to finish.
      for (let second = 0; (await observe(io, record.id)).status === "working"; second++) {
        if (second >= 20) throw new Error("This thread is still working; wait for its result, then resolve it");
        await (io.delay ?? delay)(1000);
      }
    }
    await update(stateDir, record.id, () => ({ resolved: true }), io);
    await close(stateDir, record, io);
    return changed(stateDir, record.id, io);
  },

  async reopen(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
    await update(stateDir, record.id, () => ({ resolved: false }), io);
    return changed(stateDir, record.id, io);
  },

  async close(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
    await close(stateDir, record, io);
    return changed(stateDir, record.id, io);
  },

  async delete(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
    const deleted = [];
    for (const target of record.role === "coordinator" ? [...threads(stateDir, record.id), record] : [record]) {
      await stop(stateDir, target.id, io);
      (await adapter(target.agent)).remove(session(stateDir, target.id));
      removeRecord(stateDir, target.id);
      deleted.push(target.id);
    }
    if (record.role === "thread") await touch(io, record.coordinator);
    return { deleted };
  },
};

export async function main(argv = process.argv.slice(2)) {
  const [name, json] = argv;
  if (argv.length !== 2 || !Object.hasOwn(actions, name)) throw new Error(`usage: control <${Object.keys(actions).join("|")}> 'JSON options'`);
  const options = JSON.parse(json);
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("options must be a JSON object");
  const result = await actions[name](options);
  console.log(JSON.stringify(result));
  return result;
}

// Real paths, so the installed `pi-projects` bin link runs main too.
function invoked() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (process.argv[1] && invoked()) {
  main().catch(error => { console.error(`projects: ${errorText(error)}`); process.exitCode = 1; });
}
