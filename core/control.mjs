#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bootIdentity, descendsFrom, ownerState, processTable } from "./lib/process.mjs";
import { agentKind, conversationRemover, sessionLaunchCommand } from "./agent-runtimes.mjs";
import { Store, stateDirectory } from "./store.mjs";
import { acquireLock, checkedStatePath, lockState, readJSON, sessionId } from "./lib/state.mjs";
import { shouldReopen } from "./messages.mjs";
import { LOCAL_TERMINAL, command, localPlacement, ownership, rejectedLaunch, terminal, terminalPlacement, terminals } from "./hc.mjs";

const errorText = error => error instanceof Error ? error.message : String(error);

function printable(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} must be nonempty printable text`);
  return value;
}
function validateRecord(record) {
  if (!record || typeof record !== "object") throw new Error("Missing session record");
  if (record.version !== 1) throw new Error("Unsupported session record version");
  sessionId(record.id); sessionId(record.coordinator);
  if (!["coordinator", "thread"].includes(record.role) || (record.role === "coordinator") !== (record.id === record.coordinator)) throw new Error("Invalid session role/coordinator");
  printable(record.title, "title");
  if (record.space !== undefined) localPlacement(record.space, "space");
  if (!["placeholder", "agent", "human"].includes(record.titleSource)) throw new Error("Invalid title source");
  if (record.tab !== undefined) localPlacement(record.tab, "tab");
  if (!isAbsolute(record.projectRoot || "") || !isAbsolute(record.cwd || "") || typeof record.registration !== "string") throw new Error("Invalid session project/cwd/registration");
  if (record.terminal !== undefined && !LOCAL_TERMINAL.test(record.terminal)) throw new Error("Invalid local terminal identity");
  if (record.resolved !== undefined && typeof record.resolved !== "boolean") throw new Error("Invalid resolved state");
  if (record.rank !== undefined && !Number.isFinite(record.rank)) throw new Error("Invalid session rank");
  if (record.transcriptState !== undefined && !["expected", "unwritten"].includes(record.transcriptState)) throw new Error("Invalid transcript state");
  if (record.resolvedBy !== undefined) {
    if (!["agent", "human"].includes(record.resolvedBy?.kind)) throw new Error("Invalid resolution author");
    if (record.resolvedBy.session !== undefined) sessionId(record.resolvedBy.session);
  }
  printable(record.agent, "agent runtime");
  return record;
}
function notice(store, record, action, previousTitle) {
  if (record.role !== "thread") return;
  const coordinator = store.record(record.coordinator);
  if (!coordinator || coordinator.role !== "coordinator") return;
  const sender = { kind: "system", session: coordinator.id, title: "Projects lifecycle" };
  store.publish({ version: 1, id: randomUUID(), projectRoot: record.projectRoot, recipient: coordinator.id,
    created: new Date().toISOString(), sender, author: sender, source: { session: record.id }, via: [],
    informational: true, text: `Thread ${JSON.stringify(record.title)} (${record.id}) ${action}${previousTitle ? ` from ${JSON.stringify(previousTitle)}` : ""}. Informational only; no action requested.` });
}
function writerState(stateDir, directory, record, snapshot) {
  const states = [lockState(join(stateDir, "writer-locks", record.id), snapshot), lockState(join(directory, "locks", `extension-${record.id}`), snapshot)];
  if (record.owner) states.push(ownerState(record.owner, snapshot));
  else if (record.registration !== "awaiting-extension") states.push("unknown");
  return states.includes("live") ? "live" : states.includes("unknown") ? "unknown" : "dead";
}
function view(stateDir, directory, record, rows, observationError, snapshot) {
  let paused = false, controlError;
  try {
    const control = readJSON(join(directory, "controls", `${record.id}.json`), { version: 1, paused: false });
    if (control?.version !== 1 || typeof control.paused !== "boolean") throw new Error("Invalid pause control");
    paused = control.paused;
  } catch (error) { paused = true; controlError = errorText(error); }
  const observed = rows?.find(row => row.address === record.terminal);
  const error = [observationError, controlError, record.launchError].filter(Boolean).join("; ");
  return {
    id: record.id, projectRoot: record.projectRoot, title: record.title, role: record.role, coordinator: record.coordinator, agent: record.agent,
    cwd: record.cwd, space: record.space, tab: record.tab, terminal: record.terminal, resolved: record.resolved ?? false,
    rank: record.rank ?? (Date.parse(record.created) || 0),
    registration: record.registration, writer: snapshot === false ? "unknown" : writerState(stateDir, directory, record, snapshot), paused,
    terminalState: rows ? observed?.state ?? "not-observed" : "unknown", terminalOwned: snapshot !== false && !!observed && !!ownership(stateDir, directory, record, observed, snapshot), launchState: record.launchState,
    ...(error ? { error } : {}),
  };
}
function open(options) {
  const stateDir = stateDirectory(options.stateDir);
  sessionId(options.id);
  const store = new Store(stateDir, options.projectRoot);
  const record = validateRecord(store.record(options.id));
  return { stateDir, store, record };
}

export async function listSessions({ stateDir: selected, projectRoot } = {}, io = {}) {
  const stateDir = stateDirectory(selected), sessions = [], errors = [], records = [];
  if (projectRoot !== undefined && (typeof projectRoot !== "string" || !isAbsolute(projectRoot))) throw new Error("projectRoot must be an absolute canonical path");
  const selectedProject = projectRoot === undefined ? undefined : createHash("sha256").update(projectRoot).digest("hex");
  let projects;
  try { projects = readdirSync(join(stateDir, "projects"), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { sessions }; throw error; }
  for (const project of projects) {
    if (!project.isDirectory() || (selectedProject !== undefined && project.name !== selectedProject)) continue;
    const directory = join(stateDir, "projects", project.name);
    let names;
    try { names = readdirSync(join(directory, "records")); }
    catch (error) {
      if (error.code !== "ENOENT") errors.push({ project: project.name, error: errorText(error) });
      continue;
    }
    for (const name of names.filter(name => name.endsWith(".json"))) {
      try {
        const record = validateRecord(readJSON(join(directory, "records", name)));
        if (name !== `${record.id}.json` || createHash("sha256").update(record.projectRoot).digest("hex") !== project.name) throw new Error("Stored session identity/project mismatch");
        let unavailable;
        try {
          if (realpathSync(record.projectRoot) !== record.projectRoot || !statSync(record.projectRoot).isDirectory()) throw new Error("Project is no longer a canonical directory");
          if (!statSync(record.cwd).isDirectory()) throw new Error("Session cwd is no longer a directory");
        } catch (error) { unavailable = errorText(error); errors.push({ projectRoot: record.projectRoot, id: record.id, error: unavailable }); }
        records.push({ directory, record, unavailable });
      } catch (error) { errors.push({ project: project.name, record: name, error: errorText(error) }); }
    }
  }
  let rows, observationError, snapshot;
  if (records.length) {
    try { rows = await terminals(io, new Set(records.map(({ record }) => record.terminal)), true); }
    catch (error) { observationError = errorText(error); errors.push({ error: observationError }); }
    if (process.platform === "darwin") {
      try { snapshot = processTable(); }
      catch (error) { snapshot = false; observationError = [observationError, errorText(error)].filter(Boolean).join("; "); errors.push({ error: errorText(error) }); }
    }
  }
  for (const { directory, record, unavailable } of records) sessions.push(view(stateDir, directory, record, rows, [unavailable, observationError].filter(Boolean).join("; "), snapshot));
  const coordinatorRanks = new Map(sessions.filter(session => session.role === "coordinator").map(session => [session.id, session.rank]));
  sessions.sort((a, b) => a.projectRoot.localeCompare(b.projectRoot) ||
    (coordinatorRanks.get(b.coordinator) ?? 0) - (coordinatorRanks.get(a.coordinator) ?? 0) ||
    a.coordinator.localeCompare(b.coordinator) ||
    Number(a.role === "thread") - Number(b.role === "thread") ||
    Number(a.resolved) - Number(b.resolved) || b.rank - a.rank || a.id.localeCompare(b.id));
  return { sessions, ...(errors.length ? { errors } : {}) };
}

export async function publishControlDescriptor(options, io = {}) {
  const { stateDir, store, record } = open(options);
  const observed = terminal(await (io.command ?? command)("hc", ["get", record.terminal, "--json"]));
  if (observed.address !== record.terminal || observed.state !== "live" || record.registration !== "registered" || !descendsFrom(record.owner, observed.pid)) throw new Error("Cannot advertise an unverified session terminal");
  const descriptor = { version: 1, command: [join(stateDir, "bin", "control")], stateDir };
  for (const path of descriptor.command) {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Control descriptor requires absolute printable paths");
  }
  const labelled = terminal(await (io.command ?? command)("hc", ["label", record.terminal, "--json",
    `projects.session=${record.id}`, `projects.project=${store.directory.split("/").pop()}`, `projects.control=${JSON.stringify(descriptor)}`]));
  if (labelled.address !== record.terminal || labelled.labels?.["projects.control"] !== JSON.stringify(descriptor)) throw new Error("hc did not retain the control descriptor");
  return descriptor;
}

export async function createCoordinator(options, io = {}) {
  const stateDir = stateDirectory(options.stateDir);
  const store = new Store(stateDir, options.projectRoot);
  const title = printable(options.title, "title"), space = options.space === undefined ? undefined : localPlacement(options.space, "space");
  const id = randomUUID(), created = new Date();
  store.transaction(() => store.save(validateRecord({ version: 1, id, projectRoot: options.projectRoot, title, titleSource: "human", role: "coordinator", coordinator: id, agent: agentKind(options.agent ?? "pi"),
    cwd: options.projectRoot, space, tab: space === undefined ? undefined : `pt-${id}`, resolved: false, registration: "awaiting-extension", launchState: "claimed",
    created: created.toISOString(), rank: created.getTime() })));
  return ensureSession({ stateDir, projectRoot: options.projectRoot, id }, io);
}

export async function createThread(options, io = {}) {
  const { stateDir, store, record: coordinator } = open(options);
  if (coordinator.role !== "coordinator") throw new Error("create-thread id must identify a coordinator");
  const by = options.by === undefined ? "agent" : options.by;
  if (!["agent", "human"].includes(by)) throw new Error("Create-thread by must be agent or human");
  const title = options.title === undefined ? "New thread" : printable(options.title, "title").trim();
  if (title.length > 80 || ["coordinator", "self"].includes(title)) throw new Error("Choose a thread title of at most 80 characters other than coordinator or self");
  const cwd = realpathSync(options.cwd === undefined ? coordinator.cwd : resolve(coordinator.projectRoot, options.cwd));
  if (!statSync(cwd).isDirectory()) throw new Error("cwd must be a directory");
  const id = randomUUID();
  let initial;
  if (options.initial !== undefined) {
    initial = validateEnvelope({ ...options.initial, recipient: id }, coordinator.projectRoot, id);
    if (initial.informational !== undefined || !initial.text.length || initial.text.length > 100000) throw new Error("Invalid initial message envelope");
  }
  let space = coordinator.space;
  const observed = (await terminals(io, new Set([coordinator.terminal]))).find(row => row.address === coordinator.terminal);
  if (observed && ownership(stateDir, store.directory, coordinator, observed)) space = terminalPlacement(observed).space;
  const titleSource = options.title === undefined ? "placeholder" : by;
  const created = new Date();
  const guard = acquireLock(join(stateDir, "control-locks", coordinator.id));
  let claim;
  try {
    if (store.record(coordinator.id)?.role !== "coordinator") throw new Error("Coordinator was deleted before thread creation");
    claim = store.claimThread(validateRecord({ version: 1, id, projectRoot: coordinator.projectRoot, title, titleSource, role: "thread", coordinator: coordinator.id, agent: agentKind(coordinator.agent),
      cwd, space, tab: space === undefined ? undefined : `pt-${id}`, resolved: false, launchState: "claimed", registration: "awaiting-extension",
      created: created.toISOString(), rank: created.getTime(), ...(initial ? { initial } : {}) }), { uniqueTitle: options.title === undefined || by === "human" });
    if (claim.created && initial?.sender.session !== coordinator.id) notice(store, claim.record, "created");
  } finally { guard.release(); }
  let availability;
  try { availability = await ensureSession({ stateDir, projectRoot: coordinator.projectRoot, id: claim.record.id }, io); }
  catch (error) { availability = { ...view(stateDir, store.directory, claim.record), error: errorText(error) }; }
  return { ...availability, repeatedName: !claim.created, initialMessage: claim.record.initial?.id };
}

export async function renameSession(options, io = {}) {
  const { stateDir, store, record } = open(options);
  const title = printable(options.title, "title").trim();
  const by = options.by ?? "human";
  if (!["agent", "human"].includes(by)) throw new Error("Rename by must be agent or human");
  if (record.role === "thread" && (title.length > 80 || ["coordinator", "self"].includes(title))) throw new Error("Choose a thread title of at most 80 characters other than coordinator or self");
  const renamed = store.transaction(() => {
    const current = validateRecord(store.record(record.id));
    if (by === "agent" && current.titleSource === "human") throw new Error("This title was chosen by a human; agents cannot rename it");
    if (current.role === "thread" && store.records().some(other => other.id !== current.id && other.role === "thread" && other.coordinator === current.coordinator && other.title === title)) throw new Error("Another thread in this project already has that title");
    const next = store.save({ ...current, title, titleSource: by });
    if (current.title !== title) notice(store, next, "renamed", current.title);
    return next;
  });
  let rows, observationError, current = renamed;
  try {
    rows = await terminals(io, new Set([record.terminal]));
    current = validateRecord(store.record(record.id));
    const observed = rows.find(row => row.address === current.terminal);
    if (observed && ownership(stateDir, store.directory, current, observed)) current = store.patch(current.id, terminalPlacement(observed));
  } catch (error) { observationError = errorText(error); }
  return view(stateDir, store.directory, current, rows, observationError);
}

export async function orderSession(options) {
  if (!Number.isFinite(options.rank)) throw new Error("rank must be a finite number");
  const { stateDir, store, record } = open(options);
  const ordered = store.patch(record.id, { rank: options.rank });
  return view(stateDir, store.directory, ordered);
}

function discoverLaunch(record) {
  return record.registration === "awaiting-extension" || ["requested", "unknown"].includes(record.launchState);
}
function launchPending(record, rows) {
  // A prior boot cannot still be starting; current live labels still block a second writer.
  const expired = record.launchBoot && record.launchBoot !== bootIdentity();
  return rows.some(row => row.labels?.["projects.session"] === record.id &&
    (row.state === "live" || !expired && row.state !== "finished"));
}

export async function placeSession(options, io = {}) {
  const space = localPlacement(options.space, "space");
  const { stateDir, store } = open(options);
  const guard = acquireLock(join(stateDir, "control-locks", options.id));
  try {
    const before = store.record(options.id);
    const rows = await terminals(io, discoverLaunch(before) ? undefined : new Set([before.terminal]), false, discoverLaunch(before) ? before.id : undefined);
    const placed = store.transaction(() => {
      const record = validateRecord(store.record(options.id));
      const observed = rows.find(row => row.address === record.terminal);
      const writer = writerState(stateDir, store.directory, record);
      if (observed && ownership(stateDir, store.directory, record, observed) || writer === "live") throw new Error("Session is running; close its terminal before moving it");
      if (writer !== "dead" || discoverLaunch(record) && launchPending(record, rows)) throw new Error("Session terminal ownership is uncertain; no placement changed");
      return store.save({ ...record, space });
    });
    return view(stateDir, store.directory, placed, rows);
  } finally { guard.release(); }
}

export async function ensureSession(options, io = {}) {
  const { stateDir, store } = open(options);
  const space = options.space === undefined ? undefined : localPlacement(options.space, "space");
  let guard;
  try { guard = acquireLock(join(stateDir, "control-locks", options.id)); }
  catch (error) {
    if (error.code !== "ELOCKED") throw error;
    return { ...view(stateDir, store.directory, store.record(options.id)), pending: true, error: "Another session-control operation owns this session; no launch attempted" };
  }
  let rows;
  const result = (extra = {}) => ({ ...view(stateDir, store.directory, store.record(options.id), rows), ...extra });
  try {
    const before = store.record(options.id);
    const coordinator = before.role === "thread" && space === undefined ? store.record(before.coordinator) : undefined;
    const discover = discoverLaunch(before);
    try {
      rows = await terminals(io, discover ? undefined : new Set([before.terminal, coordinator?.terminal]), false, discover ? before.id : undefined);
      if (discover && coordinator?.terminal) rows.push(...await terminals(io, new Set([coordinator.terminal]), true));
    } catch (error) { return result({ pending: true, error: errorText(error) }); }
    let record = validateRecord(store.record(options.id));
    const writer = writerState(stateDir, store.directory, record);
    if (writer !== "dead") {
      if (record.registration === "registered" && ownerState(record.owner) === "live") return result();
      return result({ pending: true, error: `${writer} writer ownership; no relaunch performed` });
    }
    if (discover && launchPending(record, rows)) {
      return result({ pending: true, error: "Launch outcome is uncertain or a live terminal still carries this session's label; no relaunch performed" });
    }
    const launchCommand = await sessionLaunchCommand(record, stateDir);
    let targetSpace = space ?? record.space;
    if (space === undefined && coordinator) {
      const parent = validateRecord(store.record(coordinator.id));
      const observed = rows.find(row => row.address === parent.terminal);
      targetSpace = observed && ownership(stateDir, store.directory, parent, observed) ? terminalPlacement(observed).space : parent.space;
    }
    record = { ...record, space: targetSpace, tab: targetSpace === undefined ? undefined : record.tab ?? `pt-${record.id}` };
    const launchToken = randomUUID();
    const launchBoot = bootIdentity();
    const args = ["run", "--bg", "--json", "--no-parent", "--cwd", record.cwd,
      ...(record.space === undefined ? [] : ["--label", `herdr.space=${record.space}`]),
      ...(record.tab === undefined ? [] : ["--label", `herdr.tab=${record.tab}`]),
      "--label", `projects.session=${record.id}`, "--label", `projects.project=${store.directory.split("/").pop()}`,
      "--label", `projects.launch=${launchToken}`,
      "--", ...launchCommand];
    const requested = store.transaction(() => {
      const current = validateRecord(store.record(record.id));
      if (writerState(stateDir, store.directory, current) !== "dead") return false;
      store.save({ ...current, space: record.space, tab: record.tab, launchState: "requested", launchToken, launchBoot, launchError: undefined, registration: "awaiting-extension" });
      return true;
    });
    if (!requested) return result({ pending: true, error: "Writer ownership changed during recovery; no launch performed" });
    let launched;
    try {
      launched = terminal(await (io.command ?? command)("hc", args, 15000));
      const observed = terminal(await (io.command ?? command)("hc", ["get", launched.address, "--json"]));
      if (observed.address !== launched.address || observed.parent != null || observed.labels?.["projects.session"] !== record.id ||
        observed.labels?.["projects.project"] !== store.directory.split("/").pop() || observed.labels?.["projects.launch"] !== launchToken ||
        observed.labels?.["herdr.space"] !== record.space || observed.labels?.["herdr.tab"] !== record.tab) throw new Error("hc launch identity/placement differs from its claim");
      const current = store.record(record.id);
      if (current.registration === "registered" && current.terminal !== observed.address) throw new Error("A different terminal registered during launch; ownership requires inspection");
      store.patch(record.id, { terminal: observed.address, launchState: "observed", launchError: undefined });
      rows = [...rows.filter(row => row.address !== observed.address), observed];
    } catch (error) {
      const failed = !launched && rejectedLaunch(error);
      store.patch(record.id, { launchState: failed ? "failed" : "unknown", launchError: errorText(error) });
      return result({ pending: !failed, requestedLaunch: launchToken });
    }
    const current = store.record(record.id);
    return result({ requestedLaunch: launchToken, ...(current.registration === "registered" && ownerState(current.owner) === "live" ? {} : { pending: true }) });
  } finally { guard.release(); }
}

export async function showSession(options, io = {}) {
  const ensured = await ensureSession(options, io);
  const { stateDir, store } = open(options);
  for (let attempt = 0; attempt < 30; attempt++) {
    const record = validateRecord(store.record(options.id));
    if (record.terminal) {
      const observed = terminal(await (io.command ?? command)("hc", ["get", record.terminal, "--json"]));
      const current = validateRecord(store.record(options.id));
      const owned = ownership(stateDir, store.directory, current, observed);
      if (owned) {
        const placed = store.patch(current.id, terminalPlacement(observed));
        if (ensured.requestedLaunch && ensured.requestedLaunch === placed.launchToken) notice(store, placed, "opened");
        return { ...view(stateDir, store.directory, placed, [observed]), readyToFocus: true, ...(owned === "starting" ? { pending: true } : {}) };
      }
    }
    if (attempt < 29) await (io.delay ?? delay)(100);
  }
  throw new Error(`Session terminal ownership is not confirmed; no focus performed${ensured.error ? `: ${ensured.error}` : " (launch may still be pending)"}`);
}

async function closeOwnedSession(stateDir, store, id, io, deleting = false) {
  const record = validateRecord(store.record(id));
  const discover = discoverLaunch(record);
  const rows = await terminals(io, discover ? undefined : new Set([record.terminal]), false, discover ? record.id : undefined);
  const row = rows.find(row => row.address === record.terminal);
  if (!row || row.state === "finished" || deleting && !ownership(stateDir, store.directory, record, row)) {
    if (writerState(stateDir, store.directory, record) !== "dead" || discover && launchPending(record, rows)) throw new Error("Session terminal ownership is uncertain; no terminal killed");
    return { ...view(stateDir, store.directory, record, rows), closed: true };
  }
  const observed = terminal(await (io.command ?? command)("hc", ["get", row.address, "--json"]));
  const current = validateRecord(store.record(id));
  if (!ownership(stateDir, store.directory, current, observed)) throw new Error("Session terminal ownership is not confirmed; no terminal killed");
  store.patch(current.id, terminalPlacement(observed));
  // hc has no conditional kill: revalidate immediately before its address-only operation.
  let killed = terminal(await (io.command ?? command)("hc", ["kill", observed.address, "--json"], 15000));
  for (let attempt = 0; killed.address === observed.address && killed.state === "live" && attempt < 30; attempt++) {
    await (io.delay ?? delay)(100);
    killed = terminal(await (io.command ?? command)("hc", ["get", observed.address, "--json"]));
  }
  if (killed.address !== observed.address || killed.state !== "finished") throw new Error("hc did not confirm that the owned terminal closed");
  if (!deleting) notice(store, current, "closed");
  return { ...view(stateDir, store.directory, store.record(id), [killed]), closed: true };
}

export async function closeSession(options, io = {}) {
  const { stateDir, store } = open(options);
  const guard = acquireLock(join(stateDir, "control-locks", options.id));
  try { return await closeOwnedSession(stateDir, store, options.id, io); }
  finally { guard.release(); }
}

export async function deleteSession(options, io = {}) {
  const { stateDir, store, record } = open(options);
  const guards = [], deleted = [];
  const lockPath = id => checkedStatePath(stateDir, join(stateDir, "control-locks", id));
  try {
    guards.push(acquireLock(lockPath(record.id)));
    const targets = record.role === "coordinator"
      ? [...store.records().filter(child => child.role === "thread" && child.coordinator === record.id).sort((a, b) => a.id.localeCompare(b.id)), record]
      : [record];
    for (const target of targets) {
      validateRecord(target);
      agentKind(target.agent);
      if (target.id !== record.id) guards.push(acquireLock(lockPath(target.id)));
    }
    checkedStatePath(stateDir, join(store.directory, "locks", "registry"));
    for (const target of targets) {
      const id = target.id;
      const paths = [
        store.inbox(id), join(store.directory, "deliveries", id),
        join(store.directory, "controls", `${id}.json`), join(store.directory, "records", `${id}.json`),
      ].map(path => checkedStatePath(stateDir, path));
      const writer = checkedStatePath(stateDir, join(stateDir, "writer-locks", id));
      const extension = checkedStatePath(stateDir, join(store.directory, "locks", `extension-${id}`));
      const removeConversation = await conversationRemover(target.agent);
      await closeOwnedSession(stateDir, store, id, io, true);
      for (let attempt = 0; writerState(stateDir, store.directory, validateRecord(store.record(id))) !== "dead"; attempt++) {
        if (attempt === 30) throw new Error(`Session ${id} still has a live or uncertain writer; no conversation deleted`);
        await (io.delay ?? delay)(100);
      }
      const writers = [];
      try {
        writers.push(acquireLock(writer));
        writers.push(acquireLock(extension));
        store.transaction(() => {
          const current = validateRecord(store.record(id));
          removeConversation(current, stateDir);
          for (const path of paths.slice(0, -1)) rmSync(path, { recursive: true, force: true });
          if (record.role === "thread") notice(store, current, "deleted");
          rmSync(paths[paths.length - 1]);
          deleted.push(id);
        });
      } finally { for (const lock of writers.reverse()) lock.release(); }
    }
    return { deleted };
  } catch (error) {
    if (deleted.length) throw new Error(`${errorText(error)}; already deleted: ${deleted.join(", ")}`, { cause: error });
    throw error;
  } finally { for (const guard of guards.reverse()) guard.release(); }
}

export async function resolveSession(options) {
  const { stateDir, store, record } = open(options);
  const by = options.by ?? "human";
  if (!["agent", "human"].includes(by)) throw new Error("Resolve by must be agent or human");
  if (record.role === "coordinator" && by === "agent") throw new Error("Only humans can resolve projects");
  const resolvedBy = { kind: by, ...(by === "agent" && options.session !== undefined ? { session: sessionId(options.session) } : {}) };
  const resolved = store.patch(record.id, { resolved: true, resolvedBy });
  if (!record.resolved) notice(store, resolved, "resolved");
  return view(stateDir, store.directory, resolved);
}
function reopenRecord(store, record) {
  const reopened = store.patch(record.id, { resolved: false, resolvedBy: undefined });
  if (record.resolved) notice(store, reopened, "reopened");
}
export async function reopenSession(options, io = {}) {
  const { store, record } = open(options);
  const by = options.by ?? "human";
  if (!["agent", "human"].includes(by)) throw new Error("Reopen by must be agent or human");
  if (record.role === "coordinator" && by === "agent") throw new Error("Only humans can reopen projects");
  const reopened = store.transaction(() => {
    const current = validateRecord(store.record(record.id));
    if (options.afterHumanTurn !== undefined && !shouldReopen(current, sessionId(options.afterHumanTurn))) return false;
    reopenRecord(store, current);
    return true;
  });
  if (!reopened) return view(stateDirectory(options.stateDir), store.directory, store.record(record.id));
  return ensureSession(options, io);
}

function messageText(value, label) {
  if (typeof value !== "string" || !value.length || value.length > 100000) throw new Error(`${label} must contain 1–100000 characters`);
  return value;
}
function validateEnvelope(value, projectRoot, recipient) {
  sessionId(value?.id);
  const optionalText = text => text === undefined || typeof text === "string";
  const author = item => item && typeof item.kind === "string" && !!item.kind.trim() &&
    typeof item.title === "string" && !!item.title.trim() && (item.session === undefined || typeof item.session === "string") &&
    optionalText(item.role) && optionalText(item.type);
  const source = item => item && typeof item.session === "string" && (item.entry === null || optionalText(item.entry)) && optionalText(item.toolCall);
  if (value.version !== 1 || value.projectRoot !== projectRoot || value.recipient !== recipient || typeof value.created !== "string" ||
      typeof value.text !== "string" || !optionalText(value.note) ||
      (value.informational !== undefined && typeof value.informational !== "boolean") ||
      !author(value.sender) || !author(value.author) || (value.source !== undefined && !source(value.source)) || !Array.isArray(value.via) ||
      value.via.some(item => !source(item) || item.sender !== undefined && !author(item.sender) || !optionalText(item.note))) throw new Error("Invalid message envelope");
  return value;
}

export async function publishMessage(options, envelope, io = {}) {
  const { stateDir, store, record } = open(options);
  const message = validateEnvelope(envelope, record.projectRoot, record.id);
  if (record.resolved) {
    if (record.role === "thread" && message.sender.kind === "agent") throw new Error("Thread is resolved; reopen it before sending a message");
    if (message.sender.kind === "human") reopenRecord(store, record);
  }
  store.publish(message);
  let availability;
  try { availability = await ensureSession({ stateDir, projectRoot: record.projectRoot, id: record.id }, io); }
  catch (error) { availability = { error: errorText(error) }; }
  return { message: message.id, recipient: record.id, state: "pending", execution: "not-requested", availability,
    note: "Persisted in recipient inbox. Availability recovery never overrides human pause; delivery is not task completion." };
}

export async function sendMessage(options, io = {}) {
  const sender = { kind: printable(options.sender?.kind, "sender.kind"), title: printable(options.sender?.title, "sender.title"),
    ...(options.sender?.session === undefined ? {} : { session: sessionId(options.sender.session) }) };
  const envelope = { version: 1, id: randomUUID(), projectRoot: options.projectRoot, recipient: options.id,
    created: new Date().toISOString(), sender, author: sender, via: [], text: messageText(options.text, "text"),
    ...(sender.session ? { source: { session: sender.session } } : {}),
    ...(options.note === undefined ? {} : { note: messageText(options.note, "note") }) };
  return publishMessage(options, envelope, io);
}

export async function main(argv = process.argv.slice(2)) {
  const actions = { list: listSessions, create: createCoordinator, "create-thread": createThread, ensure: ensureSession, show: showSession, place: placeSession, rename: renameSession, order: orderSession, send: sendMessage, close: closeSession, delete: deleteSession, resolve: resolveSession, reopen: reopenSession };
  if (argv.length !== 2 || !Object.hasOwn(actions, argv[0])) throw new Error("Usage: node control.mjs <list|create|create-thread|ensure|show|place|rename|order|send|close|delete|resolve|reopen> '<JSON options>'");
  const options = JSON.parse(argv[1]);
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Options must be a JSON object");
  const result = await actions[argv[0]](options);
  console.log(JSON.stringify(result));
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`projects: ${errorText(error)}`); process.exitCode = 1; });
}
