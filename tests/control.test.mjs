import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootIdentity, processIdentity } from "../core/lib/process.mjs";
import { Store } from "../core/store.mjs";
import { acquireLock, atomicJSON } from "../core/lib/state.mjs";
import { closeSession, createThread, deleteSession, ensureSession, listSessions, orderSession, placeSession, publishControlDescriptor, publishMessage, renameSession, reopenSession, resolveSession, sendMessage, showSession } from "../core/control.mjs";
import { shouldReopen } from "../core/messages.mjs";
import { registerCurrentSession, unregisterCurrentSession } from "../pi/registration.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-control-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project"), stateDir = join(root, "state"); mkdirSync(projectRoot);
  const store = new Store(stateDir, projectRoot);
  const id = randomUUID();
  const record = { version: 1, id, agent: "pi", projectRoot, title: "worker", titleSource: "agent", role: "thread", coordinator: randomUUID(), cwd: projectRoot, space: "space-one", tab: `pt-${id}`, registration: "awaiting-extension", launchState: "claimed" };
  store.save(record);
  return { root, stateDir, projectRoot, store, record, options: { stateDir, projectRoot, id } };
}
function retained(f) {
  const directory = join(f.root, "pi-sessions"); mkdirSync(directory, { recursive: true });
  const sessionFile = join(directory, "retained.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: f.record.id, cwd: f.record.cwd }) + "\n" +
    JSON.stringify({ type: "message", id: "prior-human", message: { role: "user", content: "Remember this exact conversation" } }) + "\n");
  f.record = f.store.patch(f.record.id, { sessionFile, sessionDir: directory, registration: "offline", launchState: "registered", owner: { ...processIdentity(), start: "dead-generation" }, terminal: "t9", resolved: true });
  f.store.control(f.record.id, { paused: true, reason: "human abort" });
  return sessionFile;
}
function transport(f) {
  const calls = [], rows = [];
  const io = {
    calls, rows, delay: async () => {},
    async command(program, args) {
      calls.push({ program, args });
      if (program === "hc" && args[0] === "ls") {
        const filter = args.includes("--label") ? args[args.indexOf("--label") + 1].split("=") : undefined;
        return { terminals: rows.filter(row => !filter || row.labels?.[filter[0]] === filter[1]).map(({ address, state }) => ({ address, state })) };
      }
      if (program === "hc" && args[0] === "get") {
        const found = rows.find(row => row.address === args[1]);
        if (!found) throw new Error("No such terminal");
        return found;
      }
      if (program === "hc" && args[0] === "run") {
        const labels = {};
        for (let i = 0; i < args.length; i++) if (args[i] === "--label") {
          const value = args[++i], equals = value.indexOf("="); labels[value.slice(0, equals)] = value.slice(equals + 1);
        }
        const row = { address: `t${rows.length + 1}`, state: "live", parent: null, pid: process.pid, labels };
        rows.push(row);
        await io.onRun?.(row, args);
        return row;
      }
      if (program === "hc" && args[0] === "kill") {
        const row = rows.find(row => row.address === args[1]);
        row.state = "finished";
        return row;
      }
      throw new Error(`Unexpected transport call: ${program} ${JSON.stringify(args)}`);
    },
  };
  return io;
}
const runs = io => io.calls.filter(call => call.program === "hc" && call.args[0] === "run");
const focuses = io => io.calls.filter(call => call.args[1] === "agent.focus");
function register(f, row) {
  f.store.patch(row.labels["projects.session"], { registration: "registered", launchState: "registered", terminal: row.address, owner: processIdentity() });
}

test("resolve is organizational while show preserves resolve and sticky pause", async t => {
  const f = fixture(t), io = transport(f);
  retained(f);
  const row = { address: "t1", state: "live", parent: null, pid: process.pid, labels: { "herdr.space": f.record.space, "herdr.tab": "human-tab-name" } };
  io.rows.push(row);
  f.store.patch(f.record.id, { resolved: false, registration: "registered", terminal: row.address, owner: processIdentity() });
  const message = { id: randomUUID(), projectRoot: f.projectRoot, recipient: f.record.id, created: "2026-11-13", text: "pending work" };
  f.store.publish(message);
  const before = readFileSync(f.record.sessionFile, "utf8");
  const resolved = await resolveSession({ ...f.options, by: "agent" });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.paused, true);
  assert.equal(resolved.writer, "live");
  assert.deepEqual(f.store.messages(f.record.id), [message]);
  const shown = await showSession({ ...f.options, space: "another-space" }, io);
  assert.equal(shown.readyToFocus, true);
  assert.equal(shown.resolved, true);
  assert.equal(shown.paused, true);
  assert.equal(runs(io).length, 0);
  assert.equal(focuses(io).length, 0);
  assert.equal(shown.tab, "human-tab-name", "show uses observed placement without renaming the tab");
  assert.equal(shown.space, row.labels["herdr.space"], "a live session ignores requested placement");
  assert.equal(readFileSync(f.record.sessionFile, "utf8"), before);
});

test("stopped reopen preserves transcript, names, cwd, identity and pause, leaving old shell alone", async t => {
  const f = fixture(t), io = transport(f), sessionFile = retained(f);
  const before = readFileSync(sessionFile, "utf8");
  io.rows.push({ address: "t9", state: "live", labels: { "herdr.space": f.record.space, "herdr.tab": f.record.tab } });
  io.onRun = row => register(f, row);
  const reopened = await reopenSession(f.options, io);
  for (const key of ["id", "coordinator", "projectRoot", "cwd", "title", "role", "space", "tab"]) assert.equal(reopened[key], f.record[key], key);
  assert.equal(reopened.resolved, false);
  assert.equal(reopened.paused, true);
  assert.equal(reopened.registration, "registered");
  assert.equal(reopened.writer, "live");
  assert.equal(f.store.record(f.record.id).sessionFile, sessionFile);
  assert.equal(readFileSync(sessionFile, "utf8"), before);
  assert.equal(runs(io).length, 1);
  assert.equal(io.rows[0].state, "live");
  assert.equal(focuses(io).length, 0);
  assert.ok(!io.calls.some(call => ["send", "keys", "kill", "interrupt"].includes(call.args[0])));
});

test("parallel ensure requests serialize and preserve a concurrent resolve/registration", async t => {
  const f = fixture(t), io = transport(f);
  let entered, finish;
  const running = new Promise(resolve => { entered = resolve; });
  const release = new Promise(resolve => { finish = resolve; });
  io.onRun = async row => { entered(); await release; register(f, row); };
  const first = ensureSession(f.options, io);
  await running;
  const second = await ensureSession(f.options, io);
  assert.equal(second.pending, true);
  assert.match(second.error, /Another session-control/);
  await resolveSession(f.options);
  finish();
  const observed = await first;
  assert.equal(runs(io).length, 1);
  assert.equal(observed.registration, "registered");
  assert.equal(observed.resolved, true);
  assert.equal(observed.writer, "live");
});

test("unknown launch replies are recoverable after labels disappear, without needing hc history", async t => {
  const f = fixture(t), io = transport(f);
  retained(f);
  io.rows.push({ address: "t9", state: "finished", labels: { "projects.session": f.record.id, "projects.launch": "old-attempt" } });
  const command = io.command;
  io.command = async (program, args) => {
    if (args[0] === "run") { io.calls.push({ program, args }); throw new Error("hc response timed out"); }
    return command(program, args);
  };
  assert.equal((await ensureSession(f.options, io)).launchState, "unknown");
  assert.equal(f.store.record(f.record.id).launchBoot, bootIdentity());
  io.command = command;
  io.rows.length = 0;
  io.onRun = row => register(f, row);
  assert.equal((await ensureSession(f.options, io)).registration, "registered");
  assert.equal(runs(io).length, 2);
});

test("a proven hc preflight rejection is retryable without replacing session history", async t => {
    const f = fixture(t), io = transport(f), sessionFile = retained(f);
    const history = readFileSync(sessionFile, "utf8"), command = io.command;
    let reject = true;
    io.command = async (program, args) => {
      if (args[0] === "run" && reject) {
        reject = false;
        io.calls.push({ program, args });
        throw Object.assign(new Error("hc invalid_params"), { code: 6, killed: false, signal: null, stderr: JSON.stringify({ error: { kind: "invalid_params" } }) });
      }
      return command(program, args);
    };
    const failed = await ensureSession(f.options, io), token = f.store.record(f.record.id).launchToken;
    assert.equal(failed.launchState, "failed");
    assert.equal(failed.pending, false);
    assert.equal(runs(io).length, 1);
    io.onRun = row => register(f, row);
    const retried = await ensureSession(f.options, io);
    assert.equal(runs(io).length, 2);
    assert.equal(retried.id, f.record.id);
    assert.equal(retried.registration, "registered");
    assert.equal(retried.paused, true);
    assert.equal(retried.error, undefined);
    assert.notEqual(f.store.record(f.record.id).launchToken, token);
    assert.equal(readFileSync(sessionFile, "utf8"), history);
});

test("a rejected observation after a successful run is not a rejected launch", async t => {
  const f = fixture(t), io = transport(f), command = io.command;
  io.command = async (program, args) => {
    if (args[0] === "get") throw Object.assign(new Error("get rejected"), { code: 6, stderr: JSON.stringify({ error: { kind: "invalid_params" } }) });
    return command(program, args);
  };
  const failed = await ensureSession(f.options, io);
  assert.equal(failed.launchState, "unknown");
  assert.equal(failed.pending, true);
  io.command = command;
  await ensureSession(f.options, io);
  assert.equal(runs(io).length, 1);
});

test("live and uncertain writers block launch even when terminal observations say finished", async t => {
  const f = fixture(t), io = transport(f);
  const path = join(f.stateDir, "writer-locks", f.record.id);
  const held = acquireLock(path);
  try {
    const pending = await ensureSession(f.options, io);
    assert.equal(pending.writer, "live");
    assert.equal(pending.pending, true);
  } finally { held.release(); }
  mkdirSync(path);
  const unknown = await ensureSession(f.options, io);
  assert.equal(unknown.writer, "unknown");
  assert.equal(unknown.pending, true);
  assert.equal(runs(io).length, 0);
});

test("every live session label blocks uncertain recovery, even without a launch token", async t => {
  const f = fixture(t), io = transport(f);
  await ensureSession(f.options, io);
  io.rows[0].state = "finished";
  const labels = { "projects.session": f.record.id, "projects.project": f.store.directory.split("/").pop() };
  const shell = { address: "t9", state: "live", labels };
  const competing = { address: "t8", state: "live", labels: { ...labels, "projects.launch": randomUUID() } };
  io.rows.push(shell, competing);
  const blocked = await ensureSession(f.options, io);
  assert.equal(blocked.pending, true);
  assert.match(blocked.error, /uncertain/);
  assert.equal(runs(io).length, 1);
  competing.state = "finished";
  await ensureSession(f.options, io);
  assert.equal(runs(io).length, 1);
  shell.state = "finished";
  await ensureSession(f.options, io);
  assert.equal(runs(io).length, 2);
  assert.ok(!io.calls.some(call => ["kill", "keys", "send"].includes(call.args[0])));
});

test("unavailable terminal service and invalid pause records remain explicit and fail closed", async t => {
  const f = fixture(t);
  atomicJSON(join(f.store.directory, "controls"), `${f.record.id}.json`, { paused: "not-a-boolean" });
  const listed = await listSessions({ stateDir: f.stateDir }, { command: async () => { throw new Error("core unavailable"); } });
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].terminalState, "unknown");
  assert.equal(listed.sessions[0].paused, true);
  assert.match(listed.sessions[0].error, /core unavailable.*pause control/);
});

test("registration arriving during terminal observation wins over a stale launch claim", async t => {
  const f = fixture(t), io = transport(f);
  const command = io.command;
  io.command = async (program, args) => {
    if (program === "hc" && args[0] === "ls") {
      const row = { address: "t1", state: "live", labels: { "projects.session": f.record.id } };
      io.rows.push(row);
      register(f, row);
    }
    return command(program, args);
  };
  const observed = await ensureSession(f.options, io);
  assert.equal(observed.registration, "registered");
  assert.equal(observed.writer, "live");
  assert.equal(observed.terminal, "t1");
  assert.equal(runs(io).length, 0);
});

test("show opens a verified starting terminal for native trust prompts, never an unrelated shell", async t => {
  const f = fixture(t), io = transport(f);
  const shown = await showSession(f.options, io);
  assert.equal(shown.readyToFocus, true);
  assert.equal(shown.pending, true);
  assert.equal(shown.registration, "awaiting-extension");
  assert.equal(runs(io).length, 1);
  assert.equal(focuses(io).length, 0);
  io.rows[0].labels["projects.launch"] = "not-this-launch";
  await assert.rejects(showSession(f.options, io), /ownership is not confirmed/);
  assert.equal(focuses(io).length, 0);
});

function coordinator(f) {
  const id = f.record.coordinator;
  f.store.save({ ...f.record, id, role: "coordinator", coordinator: id, title: "Project", tab: `pt-${id}` });
  return { ...f.options, id };
}

test("only human controls archive and reopen a project without changing its threads or sending notices", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  const child = f.store.patch(f.record.id, { resolved: true });
  const openChild = f.store.save({ ...child, id: randomUUID(), title: "Open thread", resolved: false });
  f.store.patch(parent.id, { resolved: false, registration: "registered", owner: processIdentity() });
  await assert.rejects(resolveSession({ ...parent, by: "agent" }), /Only humans/);
  assert.equal(f.store.record(parent.id).resolved, false);
  assert.equal((await resolveSession(parent)).resolved, true);
  assert.deepEqual(f.store.record(openChild.id), openChild);
  await assert.rejects(reopenSession({ ...parent, by: "agent" }, io), /Only humans/);
  assert.equal(f.store.record(parent.id).resolved, true);
  assert.equal((await reopenSession(parent, io)).resolved, false);
  assert.deepEqual(f.store.record(child.id), child);
  assert.deepEqual(f.store.record(openChild.id), openChild);
  assert.deepEqual(f.store.messages(parent.id), []);
  assert.equal(runs(io).length, 0);
});

test("place refuses a live project and re-homes a stopped one without launching or changing its children", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  const child = f.store.record(f.record.id);
  const row = { address: "t1", state: "live", pid: process.pid, labels: {
    "herdr.space": "space-one", "herdr.tab": "project-tab" } };
  io.rows.push(row);
  const live = f.store.patch(parent.id, { terminal: row.address, registration: "registered", owner: processIdentity(), resolved: true });
  await assert.rejects(placeSession({ ...parent, space: "space-two" }, io), /running/);
  assert.deepEqual(f.store.record(parent.id), live);
  row.state = "finished";
  const stopped = f.store.patch(parent.id, { registration: "offline", owner: { ...processIdentity(), start: "dead-generation" } });
  const placed = await placeSession({ ...parent, space: "space-two" }, io);
  assert.equal(placed.space, "space-two");
  assert.deepEqual(f.store.record(parent.id), { ...stopped, space: "space-two" });
  assert.deepEqual(f.store.record(child.id), child);
  assert.deepEqual(f.store.messages(parent.id), []);
  assert.equal(runs(io).length, 0);
  io.onRun = row => register(f, row);
  const opened = await ensureSession(f.options, io);
  assert.equal(opened.space, "space-two", "a stopped thread follows its project's new home");
  assert.equal(io.rows[1].labels["herdr.space"], "space-two");
});

test("stopped threads reopen in their project's observed live space, not stale recorded placement", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  retained(f);
  const row = { address: "t1", state: "live", pid: process.pid, labels: {
    "herdr.space": "current-space", "herdr.tab": "project-tab" } };
  io.rows.push(row);
  f.store.patch(parent.id, { terminal: row.address, registration: "registered", owner: processIdentity() });
  io.onRun = row => register(f, row);
  const opened = await ensureSession(f.options, io);
  assert.equal(opened.space, "current-space");
  assert.equal(io.rows[1].labels["herdr.space"], "current-space");
  assert.equal(f.store.record(parent.id).space, "space-one");
});

test("stopped threads follow their project's newly registered placement, including no Herdr space", async t => {
  for (const space of ["new-space", undefined]) {
    const f = fixture(t), io = transport(f), parent = coordinator(f);
    retained(f);
    const sessionDir = join(f.root, "pi-sessions"), sessionFile = join(sessionDir, "project.jsonl");
    registerCurrentSession(f.store, { id: parent.id, agent: "pi", cwd: f.projectRoot, owner: processIdentity(),
      terminal: "t2", space, tab: space ? "new-tab" : undefined, sessionDir, sessionFile });
    unregisterCurrentSession(f.store, { id: parent.id, sessionFile });
    assert.equal(f.store.record(f.record.id).space, "space-one", "moving a project does not rewrite its threads");
    io.onRun = row => register(f, row);
    const opened = await ensureSession(f.options, io);
    assert.equal(opened.space, space);
    assert.equal(io.rows[0].labels["herdr.space"], space);
    if (space === undefined) {
      assert.equal(opened.tab, undefined);
      assert.ok(!runs(io)[0].args.some(value => value.startsWith("herdr.")));
    }
  }
});

test("close kills only the owned coordinator terminal, leaving threads and transcript intact", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  const sessionFile = retained(f), before = readFileSync(sessionFile, "utf8");
  const child = f.store.record(f.record.id);
  const row = { address: "t1", state: "live", pid: process.pid, labels: {
    "projects.session": parent.id, "projects.project": f.store.directory.split("/").pop(),
    "herdr.space": "current-space", "herdr.tab": "project-tab" } };
  io.rows.push(row, { address: "t2", state: "live", parent: "t1", pid: process.pid, labels: {} });
  f.store.patch(parent.id, { terminal: row.address, registration: "registered", owner: processIdentity() });
  const closed = await closeSession(parent, io);
  assert.equal(closed.closed, true);
  assert.equal(closed.space, "current-space");
  assert.equal(f.store.record(parent.id).space, "current-space");
  assert.deepEqual(io.calls.filter(call => call.args[0] === "kill").map(call => call.args), [["kill", "t1", "--json"]]);
  assert.equal(io.rows[1].state, "live");
  assert.deepEqual(f.store.record(child.id), child);
  assert.equal(readFileSync(sessionFile, "utf8"), before);
  assert.equal(runs(io).length, 0);
});

test("close and list reject reused or unrelated shells even when a writer remains live", async t => {
  const f = fixture(t), io = transport(f);
  f.store.patch(f.record.id, { registration: "registered", terminal: "t1", owner: processIdentity() });
  io.rows.push({ address: "t1", state: "live", pid: 2147483647, labels: {
    "projects.session": f.record.id, "herdr.space": f.record.space, "herdr.tab": f.record.tab } });
  const listed = await listSessions({ stateDir: f.stateDir }, io);
  assert.equal(listed.sessions[0].writer, "live");
  assert.equal(listed.sessions[0].terminalOwned, false);
  await assert.rejects(closeSession(f.options, io), /ownership is not confirmed/);
  io.rows[0].pid = process.pid;
  io.rows[0].labels["projects.session"] = randomUUID();
  await assert.rejects(closeSession(f.options, io), /ownership is not confirmed/);
  assert.ok(!io.calls.some(call => call.args[0] === "kill"));
});

test("close serializes against ensure and cannot kill an unclaimed pending launch", async t => {
  const f = fixture(t), io = transport(f);
  const held = acquireLock(join(f.stateDir, "control-locks", f.record.id));
  try { await assert.rejects(closeSession(f.options, io), /owner/); }
  finally { held.release(); }
  await ensureSession(f.options, io);
  io.rows[0].labels["projects.launch"] = randomUUID();
  await assert.rejects(closeSession(f.options, io), /ownership is not confirmed/);
  assert.equal(runs(io).length, 1);
  assert.ok(!io.calls.some(call => call.args[0] === "kill"));
});

test("parallel shows attribute an opened notice only to the initiating recovery", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  let entered, finish;
  const running = new Promise(resolve => { entered = resolve; });
  const release = new Promise(resolve => { finish = resolve; });
  io.onRun = async row => { register(f, row); entered(); await release; };
  const recovery = showSession(f.options, io);
  await running;
  const focus = await showSession(f.options, io);
  assert.equal(focus.readyToFocus, true);
  assert.deepEqual(f.store.messages(parent.id), []);
  finish();
  await recovery;
  assert.equal(f.store.messages(parent.id).length, 1);
  assert.equal(runs(io).length, 1);
});

test("agent naming transitions placeholders and honors human precedence even for an unchanged title", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  f.store.patch(f.record.id, { titleSource: "placeholder" });
  f.store.save({ ...f.record, id: randomUUID(), title: "Taken" });
  await assert.rejects(renameSession({ ...f.options, title: "Taken" }, io), /already has/);
  await renameSession({ ...f.options, title: "Parser review", by: "agent" }, io);
  assert.equal(f.store.record(f.record.id).titleSource, "agent");
  assert.equal(f.store.messages(parent.id).length, 1);
  await renameSession({ ...f.options, title: "Parser review" }, io);
  assert.equal(f.store.record(f.record.id).titleSource, "human");
  assert.equal(f.store.messages(parent.id).length, 1, "an authorship-only change is not another rename");
  for (const title of ["Parser review", "Agent replacement"]) {
    await assert.rejects(renameSession({ ...f.options, title, by: "agent" }, io), /chosen by a human/);
  }
  await assert.rejects(renameSession({ ...f.options, title: "Invalid author", by: "system" }, io), /agent or human/);
  assert.equal(f.store.record(f.record.id).title, "Parser review");
  await renameSession({ ...parent, title: "Specific project purpose", by: "agent" }, io);
  assert.equal(f.store.record(parent.id).titleSource, "agent");
  assert.equal(f.store.record(parent.id).title, "Specific project purpose");
  assert.equal(runs(io).length, 0);
});

test("explicit human creation titles have precedence independently of initial-task authorship", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  const sender = { kind: "human", title: "External operator" };
  const initial = { version: 1, id: randomUUID(), projectRoot: f.projectRoot, created: new Date().toISOString(),
    sender, author: sender, via: [], text: "Review the parser" };
  const created = await createThread({ ...parent, title: "Human review", by: "human", initial }, io);
  assert.equal(f.store.record(created.id).titleSource, "human");
  await assert.rejects(renameSession({ ...f.options, id: created.id, title: "Replacement", by: "agent" }, io), /chosen by a human/);
  const agent = await createThread({ ...parent, title: "Agent review", by: "agent", initial }, io);
  assert.equal(f.store.record(agent.id).titleSource, "agent", "task authorship does not determine title authorship");
  assert.equal((await createThread({ ...parent, title: created.title, by: "agent" }, io)).id, created.id);
  assert.equal(f.store.record(created.id).titleSource, "human");
  const duplicate = await createThread({ ...parent, title: created.title, by: "human" }, io);
  assert.notEqual(duplicate.id, created.id);
  assert.equal(duplicate.title, `${created.title} 2`);
  assert.equal(duplicate.repeatedName, false);
  assert.equal(f.store.record(duplicate.id).titleSource, "human");
});

test("external send persists exact attribution before availability recovery and retains human pause", async t => {
  const f = fixture(t), io = transport(f);
  const sender = { kind: "human", title: "External operator" };
  f.store.control(f.record.id, { paused: true, reason: "Human abort" });
  io.onRun = row => {
    assert.equal(f.store.messages(f.record.id).length, 1, "publication precedes recovery");
    register(f, row);
  };
  const result = await sendMessage({ ...f.options, text: "  exact text\r\n雪\n", note: "Separate note", sender }, io);
  const [message] = f.store.messages(f.record.id);
  assert.equal(result.message, message.id);
  assert.equal(result.recipient, f.record.id);
  assert.equal(result.state, "pending");
  assert.equal(result.execution, "not-requested");
  assert.equal(result.availability.paused, true);
  assert.equal(result.availability.registration, "registered");
  assert.equal(message.version, 1);
  assert.equal(message.text, "  exact text\r\n雪\n");
  assert.equal(message.note, "Separate note");
  assert.deepEqual(message.sender, sender);
  assert.deepEqual(message.author, sender);
  assert.equal(Object.hasOwn(message, "source"), false);
  assert.deepEqual(message.via, []);
  assert.equal(f.store.control(f.record.id).reason, "Human abort");
});

test("send rejects malformed input before publication or launch", async t => {
  const f = fixture(t), io = transport(f), input = { ...f.options, text: "Valid", sender: { kind: "agent", title: "External agent" } };
  for (const change of [
    { text: "" }, { text: 7 }, { text: "a".repeat(100001) }, { note: "" }, { note: false },
    { sender: undefined }, { sender: { kind: "", title: "Agent" } }, { sender: { kind: "agent", title: "bad\nname" } },
    { sender: { ...input.sender, session: "not-a-uuid" } }, { id: randomUUID() }, { id: "../bad" },
  ]) await assert.rejects(sendMessage({ ...input, ...change }, io));
  assert.deepEqual(f.store.messages(f.record.id), []);
  assert.equal(io.calls.length, 0);
});

test("send reports recovery failure without losing its session-authored envelope", async t => {
  const f = fixture(t), io = transport(f);
  f.store.patch(f.record.id, { agent: "not-installed" });
  const sender = { kind: "agent", title: "Peer", session: randomUUID() };
  const sent = await sendMessage({ ...f.options, text: "Durable work", sender }, io);
  assert.match(sent.availability.error, /No Projects runtime installed/);
  const [message] = f.store.messages(f.record.id);
  assert.equal(message.id, sent.message);
  assert.deepEqual(message.source, { session: sender.session });
  assert.deepEqual(message.sender, sender);
  assert.deepEqual(message.author, sender);
  assert.equal(runs(io).length, 0);
});

test("order accepts finite numeric ranks without lifecycle notices, launch or pause changes", async t => {
  const f = fixture(t), parent = coordinator(f);
  f.store.patch(f.record.id, { resolved: true, rank: 10 });
  const control = { paused: true, reason: "Human abort" };
  f.store.control(f.record.id, control);
  for (const rank of [-5.25, 0]) {
    const before = f.store.record(f.record.id);
    const ordered = await orderSession({ ...f.options, rank });
    assert.equal(ordered.rank, rank);
    assert.equal(ordered.resolved, true);
    assert.equal(ordered.paused, true);
    assert.deepEqual(f.store.record(f.record.id), { ...before, rank });
  }
  const before = f.store.record(f.record.id);
  for (const rank of ["1", NaN, Infinity]) {
    await assert.rejects(orderSession({ ...f.options, rank }), /finite number/);
    assert.deepEqual(f.store.record(f.record.id), before);
  }
  assert.equal((await orderSession({ ...parent, rank: 12.5 })).rank, 12.5);
  assert.deepEqual(f.store.control(f.record.id), { ...control, version: 1 });
  assert.deepEqual(f.store.messages(parent.id), []);
  assert.deepEqual(f.store.messages(f.record.id), []);
});

test("resolved threads reject authored and forwarded agent sends until explicitly reopened", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  f.store.patch(f.record.id, { resolved: true, registration: "registered", owner: processIdentity() });
  const sender = { kind: "agent", title: "Peer", session: parent.id };
  await assert.rejects(sendMessage({ ...f.options, sender, text: "More work" }, io), /resolved; reopen/);
  const message = { version: 1, id: randomUUID(), projectRoot: f.projectRoot, recipient: f.record.id,
    created: new Date().toISOString(), sender, author: { kind: "human", title: "Original human" }, text: "Forwarded work", via: [] };
  await assert.rejects(publishMessage(f.options, message, io), /resolved; reopen/);
  assert.equal(f.store.record(f.record.id).resolved, true);
  assert.deepEqual(f.store.messages(f.record.id), []);
  assert.deepEqual(f.store.messages(parent.id), []);
  assert.deepEqual(io.calls, []);
  await reopenSession({ ...f.options, by: "agent" }, io);
  const sent = await sendMessage({ ...f.options, sender, text: "Explicitly reopened work" }, io);
  assert.equal(sent.state, "pending");
  assert.equal(f.store.messages(f.record.id).length, 1);
});

test("human external sends reopen resolved threads, notify once and preserve abort pause", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  f.store.patch(f.record.id, { resolved: true, registration: "registered", owner: processIdentity() });
  const control = { paused: true, reason: "Human abort" };
  f.store.control(f.record.id, control);
  assert.equal(shouldReopen(f.store.record(f.record.id)), true);
  const sender = { kind: "human", title: "Voice operator" };
  const sent = await sendMessage({ ...f.options, sender, text: "Continue this work" }, io);
  assert.equal(sent.availability.resolved, false);
  assert.equal(sent.availability.paused, true);
  assert.equal(f.store.record(f.record.id).resolved, false);
  assert.equal(shouldReopen(f.store.record(f.record.id)), false);
  assert.equal(f.store.messages(f.record.id)[0].id, sent.message);
  await sendMessage({ ...f.options, sender, text: "One more detail" }, io);
  assert.equal(f.store.messages(f.record.id).length, 2);
  const [notice] = f.store.messages(parent.id);
  assert.equal(f.store.messages(parent.id).length, 1);
  assert.equal(notice.informational, true);
  assert.deepEqual(f.store.control(f.record.id), { ...control, version: 1 });
  assert.equal(runs(io).length, 0);
});

test("resolved coordinators receive agent reports without reopening, while human input and sends reopen them", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  f.store.patch(parent.id, { resolved: true, registration: "registered", owner: processIdentity() });
  const control = { paused: true, reason: "Human abort" };
  f.store.control(parent.id, control);
  const report = await sendMessage({ ...parent, text: "Thread result", sender: { kind: "agent", title: "Worker", session: f.record.id } }, io);
  assert.equal(report.availability.resolved, true);
  assert.equal(f.store.record(parent.id).resolved, true);
  assert.deepEqual(f.store.messages(parent.id).map(message => message.id), [report.message]);
  const human = await sendMessage({ ...parent, text: "Continue", sender: { kind: "human", title: "Operator" } }, io);
  assert.equal(human.availability.resolved, false);
  assert.equal(shouldReopen(f.store.record(parent.id)), false);
  await resolveSession(parent);
  assert.equal(shouldReopen(f.store.record(parent.id)), true, "interactive input must reopen a resolved coordinator");
  const reopened = await reopenSession(parent, io);
  assert.equal(reopened.resolved, false);
  assert.deepEqual(new Set(f.store.messages(parent.id).map(message => message.id)), new Set([report.message, human.message]), "project transitions never send self-notices");
  assert.deepEqual(f.store.control(parent.id), { ...control, version: 1 });
  assert.equal(runs(io).length, 0);
});

test("thread deletion removes its conversation, transport, reservation and stale writers, notifying only its coordinator", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f), transcript = retained(f);
  io.rows.push({ address: "t9", state: "live", pid: process.pid, labels: {} });
  const message = { id: randomUUID(), projectRoot: f.projectRoot, recipient: f.record.id, created: new Date().toISOString(), text: "Queued" };
  f.store.publish(message);
  f.store.mark(f.record.id, message.id, { state: "attempting" });
  const subagents = join(f.stateDir, "subagents", f.record.id);
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(subagents, "state.json"), "{}");
  for (const path of [join(f.stateDir, "writer-locks", f.record.id), join(f.store.directory, "locks", `extension-${f.record.id}`)]) {
    atomicJSON(path, `${randomUUID()}.json`, { ...processIdentity(), start: "dead-generation" });
  }
  assert.deepEqual(await deleteSession(f.options, io), { deleted: [f.record.id] });
  assert.equal(io.rows[0].state, "live", "a reused shell is not the conversation's writer");
  assert.ok(!io.calls.some(call => call.args[0] === "kill"));
  assert.ok(existsSync(subagents), "another package's data is not Projects' to remove");
  for (const path of [transcript, f.store.inbox(f.record.id), join(f.store.directory, "deliveries", f.record.id),
    join(f.store.directory, "controls", `${f.record.id}.json`), join(f.stateDir, "writer-locks", f.record.id),
    join(f.store.directory, "locks", `extension-${f.record.id}`), join(f.stateDir, "control-locks", f.record.id)]) assert.equal(existsSync(path), false, path);
  assert.equal(f.store.record(f.record.id), undefined);
  const notices = f.store.messages(parent.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].informational, true);
  const replacement = await createThread({ ...parent, title: f.record.title }, io);
  assert.notEqual(replacement.id, f.record.id);
  assert.equal(replacement.repeatedName, false);
});

test("coordinator deletion removes open and resolved threads but leaves other projects untouched", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  const sibling = randomUUID(), unrelated = randomUUID();
  f.store.save({ ...f.record, id: sibling, resolved: true });
  f.store.save({ ...f.record, id: unrelated, role: "coordinator", coordinator: unrelated });
  const transcripts = f.store.records().map(record => {
    const sessionFile = join(f.stateDir, "sessions", `${record.id}.jsonl`);
    mkdirSync(join(f.stateDir, "sessions"), { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: record.id, cwd: record.cwd }) + "\n");
    f.store.patch(record.id, { sessionFile, sessionDir: join(f.stateDir, "sessions") });
    return { id: record.id, sessionFile };
  });
  const result = await deleteSession(parent, io);
  assert.deepEqual(result.deleted, [f.record.id, sibling].sort().concat(parent.id));
  for (const { id, sessionFile } of transcripts) assert.equal(existsSync(sessionFile), id === unrelated);
  assert.equal(existsSync(f.store.inbox(parent.id)), false);
  assert.deepEqual(f.store.records().map(record => record.id), [unrelated]);
  assert.deepEqual(f.store.messages(parent.id), []);
  assert.deepEqual(f.store.messages(unrelated), []);
});

test("delete waits for the verified owned terminal and its writer to finish before removing any conversation", async t => {
  const f = fixture(t), io = transport(f), transcript = retained(f), parent = coordinator(f);
  const writer = acquireLock(join(f.stateDir, "writer-locks", f.record.id));
  t.after(() => writer.release());
  const row = { address: "t9", state: "live", pid: process.pid, labels: {
    "projects.session": f.record.id, "herdr.space": f.record.space, "herdr.tab": f.record.tab } };
  io.rows.push(row);
  f.store.patch(f.record.id, { registration: "registered", owner: processIdentity() });
  const command = io.command;
  let stopping = false, waits = 0;
  io.command = async (program, args) => {
    if (args[0] === "kill") {
      assert.ok(existsSync(transcript));
      assert.ok(f.store.record(f.record.id));
      io.calls.push({ program, args });
      stopping = true;
      return row;
    }
    return command(program, args);
  };
  io.delay = async () => {
    assert.equal(stopping, true);
    assert.ok(existsSync(transcript));
    if (++waits === 1) row.state = "finished";
    else {
      writer.release();
      f.store.patch(f.record.id, { registration: "offline", owner: { ...processIdentity(), start: "dead-generation" } });
    }
  };
  assert.deepEqual(await deleteSession(f.options, io), { deleted: [f.record.id] });
  assert.equal(waits, 2);
  assert.equal(existsSync(transcript), false);
  assert.equal(io.calls.filter(call => call.args[0] === "kill").length, 1);
  assert.equal(f.store.messages(parent.id).length, 1, "deleting does not also publish a closed notice");
});

test("adapter validation failure keeps the record, inbox and conversation for inspection", async t => {
  const f = fixture(t), io = transport(f), transcript = retained(f);
  writeFileSync(transcript, "broken transcript header\n");
  const message = { id: randomUUID(), projectRoot: f.projectRoot, recipient: f.record.id, created: "2026-11-13", text: "Keep" };
  f.store.publish(message);
  await assert.rejects(deleteSession(f.options, io), SyntaxError);
  assert.ok(f.store.record(f.record.id));
  assert.equal(readFileSync(transcript, "utf8"), "broken transcript header\n");
  assert.deepEqual(f.store.messages(f.record.id), [message]);
  assert.equal(existsSync(join(f.stateDir, "writer-locks", f.record.id)), false);
});

test("delete refuses an unknown runtime before stopping a terminal or deleting siblings", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  const transcript = retained(f);
  f.store.patch(parent.id, { agent: "other-agent" });
  await assert.rejects(deleteSession(parent, io), /No Projects runtime installed/);
  assert.ok(f.store.record(parent.id));
  assert.ok(f.store.record(f.record.id));
  assert.ok(existsSync(transcript));
  assert.deepEqual(io.calls, []);
});

for (const kind of ["outside", "other-state-directory", "transcript-symlink", "registry-symlink"]) {
  test(`delete refuses ${kind} path escape without removing the record or outside data`, async t => {
    const f = fixture(t), io = transport(f), transcript = retained(f), outside = join(f.root, "outside.jsonl");
    const content = readFileSync(transcript, "utf8");
    writeFileSync(outside, content);
    if (kind === "outside") f.store.patch(f.record.id, { sessionFile: outside });
    if (kind === "other-state-directory") {
      const path = join(f.stateDir, "wrong.jsonl");
      writeFileSync(path, content);
      f.store.patch(f.record.id, { sessionFile: path });
    }
    if (kind === "transcript-symlink") {
      rmSync(transcript);
      symlinkSync(outside, transcript);
    }
    if (kind === "registry-symlink") symlinkSync(f.root, join(f.store.directory, "deliveries"));
    await assert.rejects(deleteSession(f.options, io), /inside.*(?:stateDir|session directory)/);
    assert.ok(f.store.record(f.record.id));
    assert.equal(readFileSync(outside, "utf8"), content);
    assert.equal(readFileSync(transcript, "utf8"), content);
  });
}

for (const kind of ["writer", "extension", "uncertain", "control"]) {
  test(`delete refuses a competing ${kind} lock and retains conversation data`, async t => {
    const f = fixture(t), io = transport(f), transcript = retained(f);
    const path = kind === "extension" ? join(f.store.directory, "locks", `extension-${f.record.id}`)
      : join(f.stateDir, kind === "control" ? "control-locks" : "writer-locks", f.record.id);
    const held = kind === "uncertain" ? mkdirSync(path, { recursive: true }) && undefined : acquireLock(path);
    try {
      await assert.rejects(deleteSession(f.options, io), /owner/);
      assert.ok(f.store.record(f.record.id));
      assert.ok(existsSync(transcript));
      assert.ok(!io.calls.some(call => call.args[0] === "kill"));
    } finally { held?.release(); }
  });
}

test("a coordinator deletion blocks new thread reservations while terminal closure is in progress", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f), command = io.command;
  let attempted = false;
  io.command = async (program, args) => {
    if (!attempted && args[0] === "ls") {
      attempted = true;
      await assert.rejects(createThread({ ...parent, title: "Racing creation" }, transport(f)), /owner/);
    }
    return command(program, args);
  };
  await deleteSession(parent, io);
  assert.equal(attempted, true);
  assert.deepEqual(f.store.records(), []);
});

test("creation rechecks a coordinator deleted while placement was being observed", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f), command = io.command;
  io.command = async (program, args) => {
    if (args[0] === "ls") await deleteSession(parent, transport(f));
    return command(program, args);
  };
  await assert.rejects(createThread({ ...parent, title: "Late creation" }, io), /Coordinator was deleted/);
  assert.deepEqual(f.store.records(), []);
});

test("delete refuses another conversation's transcript even inside the allowed sessions directory", async t => {
  const f = fixture(t), io = transport(f), transcript = retained(f);
  writeFileSync(transcript, JSON.stringify({ type: "session", id: randomUUID(), cwd: f.record.cwd }) + "\n");
  await assert.rejects(deleteSession(f.options, io), /identity\/cwd/);
  assert.ok(f.store.record(f.record.id));
  assert.ok(existsSync(transcript));
});


test("settle reopening honors resolution authorship and clears provenance only on reopen", async t => {
  const f = fixture(t), io = transport(f), peer = randomUUID();
  f.store.patch(f.record.id, { registration: "registered", owner: processIdentity() });
  for (const [by, session, reopens] of [["agent", f.record.id, false], ["human", undefined, false], ["agent", undefined, false], ["agent", peer, true]]) {
    await resolveSession({ ...f.options, by, session });
    const record = f.store.record(f.record.id);
    assert.deepEqual(record.resolvedBy, { kind: by, ...(session ? { session } : {}) });
    assert.equal(shouldReopen(record), true, "human input always reopens");
    assert.equal(shouldReopen(record, f.record.id), reopens);
    await reopenSession({ ...f.options, afterHumanTurn: f.record.id }, io);
    assert.equal(f.store.record(f.record.id).resolved, !reopens);
    assert.deepEqual(f.store.record(f.record.id).resolvedBy, reopens ? undefined : record.resolvedBy);
  }
  await resolveSession({ ...f.options, by: "human" });
  await reopenSession(f.options, io);
  assert.equal(f.store.record(f.record.id).resolvedBy, undefined);
});

test("uncertain current and prior-boot launches can be deleted after writers and live labels disappear", async t => {
  for (const launchBoot of [bootIdentity(), "previous-boot"]) {
    const f = fixture(t), io = transport(f);
    f.store.patch(f.record.id, { launchState: "unknown", launchToken: randomUUID(), launchBoot });
    const row = { address: "t9", state: "live", labels: { "projects.session": f.record.id } };
    io.rows.push(row);
    await assert.rejects(deleteSession(f.options, io), /ownership is uncertain/);
    io.rows.length = 0;
    assert.deepEqual(await deleteSession(f.options, io), { deleted: [f.record.id] });
  }
});

test("launch discovery asks hc for this session label and never inspects unrelated terminals", async t => {
  const f = fixture(t), io = transport(f);
  io.rows.push({ address: "t9", state: "live", labels: { "projects.session": randomUUID() } });
  await ensureSession(f.options, io);
  assert.deepEqual(io.calls[0].args, ["ls", "--all", "--json", "--label", `projects.session=${f.record.id}`]);
  assert.ok(!io.calls.some(call => call.args[0] === "get" && call.args[1] === "t9"));
});

test("thread cwd accepts absolute and project-relative paths outside the project as documented", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  for (const [title, cwd] of [["Relative worktree", ".."], ["Absolute worktree", f.root]]) {
    const created = await createThread({ ...parent, title, cwd }, io);
    assert.equal(created.cwd, f.root);
  }
});

test("unplaced projects launch threads through the stable Pi shim without Herdr labels", async t => {
  const f = fixture(t), io = transport(f), parent = coordinator(f);
  f.store.patch(parent.id, { space: undefined, tab: undefined });
  const created = await createThread({ ...parent, title: "No app required" }, io);
  const args = runs(io)[0].args;
  assert.equal(created.space, undefined);
  assert.equal(created.tab, undefined);
  assert.ok(args.includes("--no-parent"));
  assert.ok(!args.some(value => value.startsWith("herdr.")));
  assert.deepEqual(args.slice(args.indexOf("--") + 1), [join(f.stateDir, "bin", "pi"), "--session-id", created.id, "--name", "No app required"]);
  assert.equal(f.store.record(created.id).version, 1);
  const shown = await showSession({ ...parent, id: created.id }, io);
  assert.equal(shown.readyToFocus, true, "our launch labels prove starting ownership before registration");
  assert.equal(shown.space, undefined);
});

test("a verified unplaced registration advertises only the stable control shim", async t => {
  const f = fixture(t);
  f.store.patch(f.record.id, { registration: "registered", terminal: "t1", owner: processIdentity(), space: undefined, tab: undefined });
  const row = { address: "t1", state: "live", pid: process.pid, labels: {} };
  const descriptor = await publishControlDescriptor(f.options, { command: async (program, args) => {
    assert.equal(program, "hc");
    if (args[0] === "label") for (const item of args.slice(3)) {
      const index = item.indexOf("="); row.labels[item.slice(0, index)] = item.slice(index + 1);
    }
    return row;
  } });
  assert.deepEqual(descriptor, { version: 1, command: [join(f.stateDir, "bin", "control")], stateDir: f.stateDir });
});
