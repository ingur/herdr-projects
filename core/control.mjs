#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import adapters from "../adapters.mjs";
import { agentPid, classify, details, entered, hc, holds, observe, standIn } from "./hc.mjs";
import { tools } from "./roles.mjs";
import {
  collectMail, locked, readRecord, readRecords, readTool, removeRecord, rewrite, stateDirectory, update,
  writeExecutable, writeMail, writeRecord, writeTool,
} from "./store.mjs";

const STORED = {
  starting: "stored; it goes out when the session starts",
  blocked: "stored; the session is waiting on the user",
  coordinator: "stored; it goes out when the user resumes the project",
  user: "stored for the user, who gets it from their client",
  existing: "A thread with this title already exists, so nothing was sent to it",
};
const UNLABEL = ["projects.session=", "projects.pid=", "projects.bound=", "projects.control=", "projects.changed=", "projects.launched="];
const errorText = error => error instanceof Error ? error.message : String(error);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const descriptor = stateDir => JSON.stringify({ version: 2, command: [join(stateDir, "bin", "control")], stateDir });
// A project's terminals in one read, as list does; a lone thread reads only its own.
const snapshot = (io, stateDir, record) => details(io, record.role === "coordinator" ? `projects.control=${descriptor(stateDir)}` : `projects.session=${record.id}`);

function session(stateDir, id) {
  const record = readRecord(stateDir, id);
  if (!record) throw new Error(`No session ${id}`);
  return record;
}
function adapter(io, agent) {
  const known = io.adapters ?? adapters;
  if (!Object.hasOwn(known, agent)) throw new Error(`No adapter for agent ${JSON.stringify(agent)}`);
  return known[agent];
}

function actor(stateDir, as) {
  return as === undefined ? undefined : session(stateDir, as);
}

function target(stateDir, me, value) {
  if (!me) return session(stateDir, value);
  const project = [session(stateDir, me.coordinator), ...threads(stateDir, me.coordinator)];
  const found = value === "coordinator" ? project[0]
    : project.find(record => record.id === value)
      ?? project.find(record => record.role === "thread" && record.title.toLowerCase() === String(value).toLowerCase());
  if (!found) throw new Error(`No session ${JSON.stringify(value)} in this project`);
  return found;
}

function threads(stateDir, coordinator) {
  return readRecords(stateDir).records.filter(record => record.role === "thread" && record.coordinator === coordinator);
}
function title(value, role) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 80 || /[\x00-\x1f\x7f]/.test(trimmed)) throw new Error("A title is 1 to 80 printable characters");
  if (role === "thread" && ["coordinator", "user"].includes(trimmed.toLowerCase())) throw new Error(`A thread cannot be called ${trimmed.toLowerCase()}`);
  return trimmed;
}
function conversation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !value.id) {
    throw new Error("conversation must be an object with the tool's own id");
  }
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

async function type(io, id, address, message) {
  const row = await hc(io, ["get", address, "--json"]);
  const status = row.status?.state;
  if (!holds(row, id)) return { held: "stopped" };
  if (!entered(row, id) || !status) return { held: "starting" };
  if (status === "blocked") return { held: "blocked" };
  const result = await hc(io, ["send", "--json", address, message]);
  return result.started === false && (status === "idle" || status === "done") ? { note: "typed, but no turn started" } : {};
}

// Types waiting mail in order, removing each message once hc took it, after waiting up to `seconds`
// for the session to run. `held` says why mail is still waiting; `note` is about the last message typed.
async function deliver(stateDir, id, io, seconds = 0) {
  if (!session(stateDir, id).waiting.length) return {};
  try {
    const observed = await running(io, id, seconds);
    if (observed.state !== "running") return { held: observed.state };
    return await locked(stateDir, id, async () => {
      let typed = {};
      for (let [next] = session(stateDir, id).waiting; next; [next] = session(stateDir, id).waiting) {
        typed = await type(io, id, observed.terminal.address, wrap(next));
        if (typed.held) return typed;
        rewrite(stateDir, id, record => ({ waiting: record.waiting.slice(1) }));
      }
      return typed;
    }, io);
  } catch (error) { return { error: errorText(error) }; }
}

// What a session left behind: terminals that carry its label without holding it. An empty shell hc
// put in place of the program that ran there is closed; any other loses the labels, unless the session only stops.
async function vacate(io, rows, id, address, unlabel = true) {
  for (const row of rows) {
    if (row.address === address) continue;
    const current = await hc(io, ["get", row.address, "--json"]);
    if (current.state !== "live" || current.labels?.["projects.session"] !== id) continue;
    if (standIn(current)) await hc(io, ["kill", row.address, "--json"]);
    else if (unlabel) await hc(io, ["label", row.address, "--json", ...UNLABEL]);
  }
}

async function launch(stateDir, id, io, place) {
  try {
    return await locked(stateDir, id, async () => {
      const record = session(stateDir, id), observed = await observe(io, id);
      if (observed.state !== "stopped") return {};
      let target = place ?? record.space;
      if (place === undefined && record.role === "thread") target = (await observe(io, record.coordinator)).terminal?.labels["herdr.space"] ?? target;
      const tab = target === undefined ? undefined : record.tab ?? `pt-${id}`;
      const module = adapter(io, record.agent), tool = readTool(stateDir, record.agent);
      const argv = (record.conversation && module.resume(record.conversation, tool)) ?? module.start(record, tool);
      const env = Object.entries(tool.env).map(([key, value]) => `${key}=${value}`);
      const found = await hc(io, ["exec", "--json", ...env.flatMap(pair => ["--env", pair]), "--", "sh", "-c", 'command -v "$1"', "sh", argv[0]]);
      if (found.code !== 0) throw new Error(`${argv[0]} was not found on the PATH herdr starts it with`);
      const { address } = await hc(io, ["run", "--bg", "--json", "--no-parent", "--cwd", record.cwd,
        ...(target === undefined ? [] : ["--label", `herdr.space=${target}`, "--label", `herdr.tab=${tab}`]),
        "--label", `projects.session=${id}`, "--label", `projects.control=${descriptor(stateDir)}`, "--label", "projects.launched=1",
        "--", "env", ...env, `PROJECTS_STATE_DIR=${stateDir}`, ...argv]);
      // With `env … agent`, env execs the agent, so the program pid hc reports is the agent's.
      const { pid } = await hc(io, ["get", address, "--json"]);
      if (!pid) throw new Error("hc reported no pid for the new terminal");
      await hc(io, ["label", address, "--json", `projects.pid=${pid}@${pid}`]);
      // Starting first keeps the tab and the space alive; what the session left behind goes after.
      await vacate(io, observed.labelled, id, address);
      rewrite(stateDir, id, () => ({ space: target, tab }));
      return {};
    }, io);
  } catch (error) { return { error: errorText(error) }; }
}

// hc has no conditional kill: the label is read again right before it. A delete leaves no session to
// wait for, so it also takes the labels off a terminal it leaves running.
async function stop(stateDir, id, io, rows, unlabel = false) {
  const { terminal, labelled } = classify(rows, id);
  const current = terminal && await hc(io, ["get", terminal.address, "--json"]);
  if (current && holds(current, id)) {
    await remember(stateDir, id, current, io);
    const killed = await hc(io, ["kill", current.address, "--json"]);
    if (killed.state !== "finished") throw new Error(`hc could not stop terminal ${current.address}`);
  }
  await vacate(io, labelled, id, terminal?.address, unlabel);
}

// A thread is open while an agent sits in its terminal, or a terminal core started still waits for it.
function isOpen(rows, id) {
  const { terminal, labelled } = classify(rows, id);
  return terminal || labelled.some(row => row.labels["projects.launched"]);
}

async function closeThreads(stateDir, coordinator, io, rows) {
  await Promise.all(threads(stateDir, coordinator).filter(thread => isOpen(rows, thread.id)).map(async thread => {
    await update(stateDir, thread.id, () => ({ reopenWithProject: true }), io);
    await stop(stateDir, thread.id, io, rows);
  }));
}

async function close(stateDir, record, io) {
  const rows = await snapshot(io, stateDir, record);
  if (record.role === "coordinator") await closeThreads(stateDir, record.id, io, rows);
  await stop(stateDir, record.id, io, rows);
}

function writeShim(stateDir) {
  // The recorded node can go with an upgrade; the one on PATH then runs it.
  writeExecutable(join(stateDir, "bin", "control"), `#!/bin/sh\nnode=${quote(process.execPath)}\n[ -x "$node" ] || node=node\nexec "$node" ${quote(fileURLToPath(import.meta.url))} "$@"\n`);
}

function follow(stateDir, id) {
  spawn(join(stateDir, "bin", "control"), ["settle", JSON.stringify({ id, stateDir })], { detached: true, stdio: "ignore" }).unref();
}

function inConversation(stateDir, agent, talk) {
  return readRecords(stateDir).records.find(record => record.agent === agent && record.conversation?.id === talk.id);
}

async function arrival(options, io) {
  const stateDir = stateDirectory(options.stateDir);
  adapter(io, options.agent);
  if (typeof options.terminal !== "string" || !options.terminal) throw new Error("terminal must name an hc terminal");
  if (!Number.isInteger(options.pid) || options.pid <= 0) throw new Error("pid must be the agent's process id");
  const talk = conversation(options.conversation);
  const read = () => hc(io, ["get", options.terminal, "--json"]);
  const seen = await read();
  const starting = readRecord(stateDir, seen.labels?.["projects.session"]);
  const row = starting ? await locked(stateDir, starting.id, read, io) : seen;
  if (row.state !== "live") throw new Error(`Terminal ${row.address} is not live`);
  const id = row.labels?.["projects.session"], here = holds(row, id) ? readRecord(stateDir, id) : undefined;
  const taken = row.labels?.["projects.bound"] === "1";
  return {
    stateDir, row, talk,
    started: taken ? undefined : here,
    kept: taken && agentPid(row) === options.pid ? here : undefined,
  };
}

async function bind(stateDir, id, row, options, talk, io) {
  await locked(stateDir, id, async () => {
    const observed = await observe(io, id);
    const other = observed.labelled.find(live => live.address !== row.address && holds(live, id));
    if (other) throw new Error(`This session is already open in terminal ${other.address}`);
    await hc(io, ["label", row.address, "--json", `projects.session=${id}`, `projects.pid=${options.pid}@${row.pid}`,
      "projects.bound=1", `projects.control=${descriptor(stateDir)}`]);
    await vacate(io, observed.labelled, id, row.address);
    rewrite(stateDir, id, record => ({
      agent: options.agent, conversation: talk, reopenWithProject: undefined,
      space: row.labels["herdr.space"] ?? record.space, tab: row.labels["herdr.tab"] ?? record.tab,
    }));
  }, io);
  const env = options.env ?? {};
  writeTool(stateDir, options.agent, {
    env: Object.fromEntries(adapter(io, options.agent).variables.filter(key => typeof env[key] === "string").map(key => [key, env[key]])),
  });
  writeShim(stateDir);
  (io.follow ?? follow)(stateDir, id);
  return changed(stateDir, id, io);
}

async function release(stateDir, record, row, io, labels) {
  await remember(stateDir, record.id, row, io);
  await hc(io, ["label", row.address, "--json", ...labels]);
  if (record.role === "coordinator") await closeThreads(stateDir, record.id, io, await snapshot(io, stateDir, record));
}

export const actions = {
  async list(options = {}, io = {}) {
    const stateDir = stateDirectory(options.stateDir);
    const { records, errors } = readRecords(stateDir);
    let rows, error;
    if (records.length) {
      try { rows = await details(io, `projects.control=${descriptor(stateDir)}`); }
      catch (caught) { error = errorText(caught); }
    }
    const sessions = records.map(record => view(record, rows && classify(rows, record.id), error));
    const ranks = new Map(sessions.filter(view => view.role === "coordinator").map(view => [view.id, view.rank]));
    sessions.sort((a, b) => (ranks.get(b.coordinator) ?? 0) - (ranks.get(a.coordinator) ?? 0) || a.coordinator.localeCompare(b.coordinator) ||
      Number(a.role === "thread") - Number(b.role === "thread") || Number(a.resolved) - Number(b.resolved) || b.rank - a.rank || a.id.localeCompare(b.id));
    const me = actor(stateDir, options.as);
    if (me) return { you: me.id, sessions: sessions.filter(view => view.coordinator === me.coordinator) };
    return { sessions, ...(errors.length ? { errors } : {}) };
  },

  async enter(options, io = {}) {
    const { stateDir, row, talk, started, kept } = await arrival(options, io);
    const same = kept && (options.replaced || kept.conversation?.id === talk.id);
    const next = started ?? (same ? kept : inConversation(stateDir, options.agent, talk));
    if (kept && kept.id !== next?.id) await release(stateDir, kept, row, io, UNLABEL);
    if (!next) return {};
    return { session: await bind(stateDir, next.id, row, options, talk, io) };
  },

  async create(options, io = {}) {
    const { stateDir, row, talk, started, kept } = await arrival(options, io);
    if (typeof options.cwd !== "string" || !isAbsolute(options.cwd)) throw new Error("cwd must be an absolute path");
    if (started || kept || inConversation(stateDir, options.agent, talk)) throw new Error("This conversation is already in a project");
    const id = randomUUID(), created = new Date();
    writeRecord(stateDir, {
      version: 3, id, role: "coordinator", coordinator: id,
      title: options.title === undefined ? "New project" : title(options.title, "coordinator"),
      titleSource: options.title === undefined ? "placeholder" : "user",
      cwd: options.cwd, agent: options.agent, resolved: false, rank: created.getTime(), created: created.toISOString(), waiting: [],
    });
    try {
      return { session: await bind(stateDir, id, row, options, talk, io) };
    } catch (error) {
      removeRecord(stateDir, id);
      throw error;
    }
  },

  async leave(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), row = await hc(io, ["get", options.terminal, "--json"]);
    const held = agentPid(row) === options.pid ? readRecord(stateDir, row.labels?.["projects.session"]) : undefined;
    if (!held) return {};
    await release(stateDir, held, row, io, ["projects.bound=", `projects.pid=@${row.pid}`]);
    return { session: await changed(stateDir, held.id, io) };
  },

  async session(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), row = await hc(io, ["get", options.terminal, "--json"]);
    const id = row.labels?.["projects.session"];
    const held = agentPid(row) === options.pid && entered(row, id) ? readRecord(stateDir, id) : undefined;
    return held ? { session: view(held, classify([row], id)) } : {};
  },

  async act(options, io = {}) {
    const tool = tools.find(tool => tool.name === options.tool);
    if (!tool) throw new Error(`No tool ${JSON.stringify(options.tool)}`);
    if (typeof options.as !== "string") throw new Error("This conversation is not in a project");
    return actions[tool.action]({ stateDir: options.stateDir, as: options.as, ...tool.options(options.args ?? {}) }, io);
  },

  async settle(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
    const errors = [], children = record.role === "coordinator" ? threads(stateDir, record.id) : [];
    const rows = children.length ? await snapshot(io, stateDir, record) : [];
    await Promise.all(children.filter(thread => thread.reopenWithProject || isOpen(rows, thread.id)).map(async thread => {
      await update(stateDir, thread.id, () => ({ reopenWithProject: undefined }), io);
      if (thread.resolved) return;
      const { error } = await launch(stateDir, thread.id, io);
      if (error) errors.push(`${thread.title}: ${error}`);
    }));
    const { error } = await deliver(stateDir, record.id, io, 60);
    if (error) errors.push(error);
    return changed(stateDir, record.id, io, errors.length ? { error: errors.join("; ") } : {});
  },

  async "create-thread"(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), me = actor(stateDir, options.as);
    const coordinator = me ?? session(stateDir, options.coordinator);
    if (coordinator.role !== "coordinator") throw new Error("Threads are created under a coordinator");
    const by = me ? "agent" : "user", wanted = options.title === undefined ? undefined : title(options.title, "thread");
    const text = options.text === undefined ? undefined : messageText(options.text), agent = options.agent ?? coordinator.agent;
    adapter(io, agent);
    if (options.cwd !== undefined && typeof options.cwd !== "string") throw new Error("cwd must be a path");
    const cwd = resolve(coordinator.cwd, options.cwd ?? ".");
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${cwd} is not a directory`);
    const { existing, record } = await locked(stateDir, coordinator.id, () => {
      const siblings = threads(stateDir, coordinator.id), taken = new Set(siblings.map(thread => thread.title.toLowerCase()));
      const existing = wanted === undefined ? undefined : siblings.find(thread => thread.title.toLowerCase() === wanted.toLowerCase());
      if (existing && by === "agent") return { existing };
      if (existing) throw new Error(`A thread called ${existing.title} already exists`);
      let name = wanted ?? "New thread";
      for (let number = 2; taken.has(name.toLowerCase()); number++) name = `New thread ${number}`;
      const created = new Date();
      return { record: writeRecord(stateDir, { version: 3, id: randomUUID(), role: "thread", coordinator: coordinator.id, title: name,
        titleSource: wanted === undefined ? "placeholder" : by, cwd, agent, resolved: false,
        rank: created.getTime(), created: created.toISOString(),
        waiting: text === undefined ? [] : [{ from: "coordinator", title: coordinator.title, id: coordinator.id, text, created: created.toISOString() }] }) };
    }, io);
    if (existing) return changed(stateDir, existing.id, io, { existing: true, note: STORED.existing });
    const launched = await launch(stateDir, record.id, io);
    return changed(stateDir, record.id, io, launched.error || text === undefined ? launched : { note: STORED.starting });
  },

  async open(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id);
    const launched = await launch(stateDir, record.id, io, options.space === undefined ? undefined : space(options.space));
    const { terminal } = await observe(io, record.id);
    if (terminal) await remember(stateDir, record.id, terminal, io);
    return changed(stateDir, record.id, io, launched);
  },

  async send(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), sender = actor(stateDir, options.as), text = messageText(options.text);
    if (options.to === "user") {
      if (!sender) throw new Error("A message to the user comes from a session");
      writeMail(stateDir, { from: sender.role, title: sender.title, id: sender.id, text, created: new Date().toISOString() });
      return changed(stateDir, sender.id, io, { sent: false, note: STORED.user });
    }
    const recipient = target(stateDir, sender, options.to);
    if (recipient.id === sender?.id) throw new Error("Send to another session, not yourself");
    if (recipient.role === "thread" && recipient.resolved) {
      if (sender && sender.id !== recipient.coordinator) throw new Error("This thread is resolved; only its coordinator or the user can reopen it");
      await update(stateDir, recipient.id, () => ({ resolved: false }), io);
    }
    const message = { from: sender?.role ?? "user", ...(sender ? { title: sender.title, id: sender.id } : {}), text, created: new Date().toISOString() };
    await update(stateDir, recipient.id, record => ({ waiting: [...record.waiting, message] }), io);
    const observed = await observe(io, recipient.id);
    let result = { held: observed.state };
    if (observed.state === "running") result = await deliver(stateDir, recipient.id, io);
    else if (observed.state === "stopped" && recipient.role === "thread") {
      const launched = await launch(stateDir, recipient.id, io);
      result = launched.error ? { ...launched, held: "stopped" } : { held: "starting" };
    }
    const sent = !session(stateDir, recipient.id).waiting.some(entry => JSON.stringify(entry) === JSON.stringify(message));
    const note = sent ? result.note : result.held === "blocked" ? STORED.blocked
      : recipient.role === "coordinator" && result.held === "stopped" ? STORED.coordinator : STORED.starting;
    return changed(stateDir, recipient.id, io, { sent, ...(note ? { note } : {}), ...(result.error ? { error: result.error } : {}) });
  },

  async collect(options = {}) {
    return collectMail(stateDirectory(options.stateDir), options.taken);
  },

  async rename(options, io = {}) {
    const stateDir = stateDirectory(options.stateDir), me = actor(stateDir, options.as);
    const record = me && options.id === undefined ? me : target(stateDir, me, options.id);
    if (me?.role === "thread" && record.id !== me.id) throw new Error("A thread renames only itself");
    const by = me ? "agent" : "user", name = title(options.title, record.role);
    const change = current => {
      if (by === "agent" && current.titleSource === "user") throw new Error("The user chose this title; an agent cannot change it");
      if (current.role === "thread" && threads(stateDir, current.coordinator).some(thread => thread.id !== current.id && thread.title.toLowerCase() === name.toLowerCase())) {
        throw new Error(`Another thread is already called ${name}`);
      }
      return { title: name, titleSource: by };
    };
    // Thread titles are checked under the coordinator's lock, as in create-thread.
    await locked(stateDir, record.coordinator, () => record.role === "thread" ? update(stateDir, record.id, change, io) : rewrite(stateDir, record.id, change), io);
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
    const stateDir = stateDirectory(options.stateDir), me = actor(stateDir, options.as), record = target(stateDir, me, options.id);
    if (me) {
      if (me.role !== "coordinator" || record.role !== "thread") throw new Error("Only a thread's coordinator can resolve it");
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

  async unresolve(options, io = {}) {
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
    const stateDir = stateDirectory(options.stateDir), record = session(stateDir, options.id), rows = await snapshot(io, stateDir, record);
    const remove = async target => {
      await stop(stateDir, target.id, io, rows, true);
      const { agent, conversation } = session(stateDir, target.id);
      if (conversation) adapter(io, agent).remove(conversation, readTool(stateDir, agent));
      removeRecord(stateDir, target.id);
      return target.id;
    };
    const deleted = [...await Promise.all(threads(stateDir, record.id).map(remove)), await remove(record)];
    if (record.role === "thread") await touch(io, record.coordinator);
    return { deleted };
  },
};

async function main() {
  const argv = process.argv.slice(2), [name, json = readFileSync(0, "utf8")] = argv;
  if (!Object.hasOwn(actions, name)) throw new Error(`usage: control <${Object.keys(actions).join("|")}> ['JSON options', else on stdin]`);
  const options = JSON.parse(json);
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("options must be a JSON object");
  console.log(JSON.stringify(await actions[name](options)));
}

// Real paths, so a symlinked checkout still runs main.
function invoked() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (process.argv[1] && invoked()) {
  main().catch(error => { console.error(`projects: ${errorText(error)}`); process.exitCode = 1; });
}
