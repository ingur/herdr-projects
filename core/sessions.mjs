import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as mailbox from "./mailbox.mjs";
import { locked, readEnvironment, readRecord, readRecords, rewrite, session, update, writeFile, writeRecord } from "./state.mjs";
import * as terminals from "./terminals.mjs";

const errorText = error => error instanceof Error ? error.message : String(error);
export const isFolder = path => Boolean(statSync(path, { throwIfNoEntry: false })?.isDirectory());

export function threads(stateDir, project) {
  return readRecords(stateDir).records.filter(record => record.kind === "thread" && record.project === project);
}

export function title(value) {
  const trimmed = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!trimmed || trimmed.length > 80 || /\p{C}/u.test(trimmed)) throw new Error("A title is 1 to 80 printable characters");
  if (["coordinator", "user"].includes(trimmed.toLowerCase())) throw new Error(`A session cannot be called ${trimmed.toLowerCase()}`);
  return trimmed;
}

export function member(stateDir, me, address) {
  const found = address === "coordinator" ? session(stateDir, me.project) : readRecord(stateDir, address);
  if (found?.project !== me.project) throw new Error(`No session ${JSON.stringify(address)} in this project; a session is named by its id, which thread_list gives`);
  return found;
}

export function create(stateDir, fields) {
  const created = new Date();
  return writeRecord(stateDir, { version: 4, id: randomUUID(), ...fields, resolved: false, rank: created.getTime(), created: created.toISOString() });
}

export function identity(record) {
  return { id: record.id, kind: record.kind, ...(record.project ? { project: record.project } : {}), title: record.title, titleSource: record.titleSource };
}

function view(stateDir, record, observed, error) {
  const own = observed?.terminal ?? observed?.shell, state = observed?.state ?? "stopped";
  return {
    id: record.id, kind: record.kind, ...(record.project ? { project: record.project } : {}),
    title: record.title, titleSource: record.titleSource, folder: record.folder,
    resolved: record.resolved, rank: record.rank, created: record.created,
    space: own?.labels["herdr.space"] ?? record.space, tab: own?.labels["herdr.tab"] ?? record.tab,
    ...(own ? { terminal: own.address } : {}),
    state, ...(observed?.status ? { status: observed.status } : {}),
    interrupted: Boolean(observed?.shell),
    waiting: mailbox.waiting(stateDir, record.id),
    ...(error ? { error } : {}),
  };
}

const byRank = (a, b) => b.rank - a.rank || a.id.localeCompare(b.id);

// Each coordinator with its threads under it, unresolved first; then threads whose coordinator's record
// cannot be read; then plain sessions. Highest rank first.
function ordered(views) {
  const of = kind => views.filter(view => view.kind === kind).sort(byRank);
  const coordinators = of("coordinator"), threads = of("thread").sort((a, b) => Number(a.resolved) - Number(b.resolved));
  const projects = new Set(coordinators.map(view => view.id));
  return [
    ...coordinators.flatMap(coordinator => [coordinator, ...threads.filter(thread => thread.project === coordinator.id)]),
    ...threads.filter(thread => !projects.has(thread.project)), ...of("plain"),
  ];
}

export async function list(stateDir, io) {
  const { records, errors } = readRecords(stateDir);
  let rows, error;
  if (records.length) {
    try { rows = await terminals.all(io, stateDir); }
    catch (caught) { error = errorText(caught); }
  }
  const views = records.map(record => view(stateDir, record, rows && terminals.classify(rows, record.id), error));
  return { sessions: ordered(views), ...(errors.length ? { errors } : {}) };
}

export async function touch(io, id) {
  const { terminal } = await terminals.observe(io, id).catch(() => ({}));
  if (terminal) await terminals.mark(io, terminal.address);
}

// The session's view after a change, with the sidebar told to refresh.
export async function changed(stateDir, id, io, extra = {}) {
  const record = session(stateDir, id);
  let observed, error;
  try { observed = await terminals.observe(io, id); } catch (caught) { error = errorText(caught); }
  if (observed?.terminal) await terminals.mark(io, observed.terminal.address);
  else if (record.kind === "thread") await touch(io, record.project);
  const errors = [extra.error, error].filter(Boolean).join("; ");
  return { ...view(stateDir, record, observed), ...extra, ...(errors ? { error: errors } : {}) };
}

export function remember(stateDir, id, row, io) {
  return update(stateDir, id, record => ({ space: row.labels["herdr.space"] ?? record.space, tab: row.labels["herdr.tab"] ?? record.tab }), io);
}

export async function launch(stateDir, id, io, place) {
  try {
    return await locked(stateDir, id, async () => {
      const record = session(stateDir, id), observed = await terminals.observe(io, id);
      if (observed.state !== "stopped") return {};
      if (!isFolder(record.folder)) throw new Error(`The folder ${record.folder} is gone; say where it moved, then open the session`);
      let space = place ?? record.space;
      if (place === undefined && record.kind === "thread") space = (await terminals.observe(io, record.project)).terminal?.labels["herdr.space"] ?? space;
      const tab = space === undefined ? undefined : record.tab ?? `pt-${id}`;
      const argv = (record.conversation && io.adapter.resume(record.conversation)) ?? io.adapter.start();
      const address = await terminals.start(io, stateDir, id, { folder: record.folder, space, tab, env: readEnvironment(stateDir), argv });
      // Starting first keeps the tab and the space alive; what the session left behind goes after.
      await terminals.vacate(io, observed.labelled, id, address);
      rewrite(stateDir, id, () => ({ space, tab }));
      return {};
    }, io);
  } catch (error) { return { error: errorText(error) }; }
}

export const rowsOf = (io, stateDir, record) => record.kind === "coordinator" ? terminals.all(io, stateDir) : terminals.of(io, record.id);

export async function stop(stateDir, id, io, rows) {
  const held = await terminals.stop(io, rows, id);
  if (held) await remember(stateDir, id, held, io);
}

export async function closeThreads(stateDir, project, io, rows) {
  await Promise.all(threads(stateDir, project).filter(thread => terminals.isOpen(rows, thread.id)).map(async thread => {
    await update(stateDir, thread.id, () => ({ reopenWithProject: true }), io);
    await stop(stateDir, thread.id, io, rows);
  }));
}

export async function close(stateDir, record, io) {
  const rows = await rowsOf(io, stateDir, record);
  if (record.kind === "coordinator") await closeThreads(stateDir, record.id, io, rows);
  await stop(stateDir, record.id, io, rows);
}

export async function reopenThreads(stateDir, coordinator, io) {
  const children = threads(stateDir, coordinator.id), errors = [];
  const rows = children.length ? await terminals.all(io, stateDir) : [];
  await Promise.all(children.filter(thread => thread.reopenWithProject || terminals.isOpen(rows, thread.id)).map(async thread => {
    await update(stateDir, thread.id, () => ({ reopenWithProject: undefined }), io);
    if (thread.resolved) return;
    const { error } = await launch(stateDir, thread.id, io);
    if (error) errors.push(`${thread.title}: ${error}`);
  }));
  return errors.length ? { error: errors.join("; ") } : {};
}

export async function rename(stateDir, record, value, by, io) {
  const name = title(value);
  await update(stateDir, record.id, current => {
    if (by === "agent" && current.titleSource === "user") throw new Error("The user chose this title; an agent cannot change it");
    return { title: name, titleSource: by };
  }, io);
  return changed(stateDir, record.id, io);
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// The command a client runs. The recorded node can go with an upgrade; the one on PATH then runs it.
export function writeControl(stateDir) {
  const script = fileURLToPath(new URL("../control.mjs", import.meta.url));
  writeFile(join(stateDir, "bin", "control"), `#!/bin/sh\nnode=${quote(process.execPath)}\n[ -x "$node" ] || node=node\nexec "$node" ${quote(script)} "$@"\n`, 0o755);
}
