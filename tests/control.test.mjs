import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { actions, readRecord, wrap } from "../core/control.mjs";
import { writeRecord } from "../core/store.mjs";
import { remove } from "../pi/adapter.mjs";

const DEAD = 2 ** 31 - 1; // above any pid_max, so no process has it

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-projects-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), cwd = join(root, "work"), agentDir = join(root, "pi");
  mkdirSync(cwd); mkdirSync(join(agentDir, "sessions", "--work--"), { recursive: true });
  const adapter = { command: ["pi"], env: { PI_CODING_AGENT_DIR: agentDir } };
  const save = (fields = {}) => {
    const id = randomUUID();
    return writeRecord(stateDir, { version: 2, id, role: "coordinator", coordinator: id, title: "Project", titleSource: "user", cwd, agent: "pi",
      resolved: false, rank: 1, created: new Date().toISOString(), waiting: [], adapter, ...fields });
  };
  const transcript = (id, path = join(agentDir, "sessions", "--work--", `${id}.jsonl`)) => {
    writeFileSync(path, JSON.stringify({ type: "session", id, cwd }) + "\n");
    return path;
  };
  // Labels of a terminal bound to a session, as register and launch set them.
  const bound = (id, pid = process.pid) => ({ "projects.session": id, "projects.pid": String(pid),
    "projects.control": JSON.stringify({ version: 2, command: [join(stateDir, "bin", "control")], stateDir }) });
  // What a launch leaves behind: the labels it set, the agent's pid gone.
  const left = id => { const labels = { ...bound(id), "projects.launched": "1" }; delete labels["projects.pid"]; return labels; };
  return { root, stateDir, cwd, agentDir, adapter, save, transcript, bound, left, options: { stateDir } };
}

// A fake hc: `ls` gives short rows, `get` the full terminal with status as {app, state}.
function hc() {
  const rows = [], calls = [];
  const find = address => {
    const row = rows.find(row => row.address === address);
    if (!row) throw new Error(`hc: no terminal ${address}`);
    return row;
  };
  const io = {
    rows, calls, delay: () => new Promise(resolve => setImmediate(resolve)),
    terminal(labels = {}, status = "idle", age = 0) {
      const row = { address: `t${rows.length + 1}`, state: "live", pid: process.pid, labels, status: status ? { app: "pi", state: status } : null, created_ms: Date.now() - age, typed: [] };
      rows.push(row);
      return row;
    },
    async command(program, args) {
      assert.equal(program, "hc");
      calls.push(args);
      const [verb] = args;
      if (verb === "ls") {
        const [key, value] = args[args.indexOf("--label") + 1].split(/=(.*)/s);
        return { terminals: rows.filter(row => row.state === "live" && row.labels[key] === value)
          .map(row => ({ address: row.address, state: row.state, ...(row.status ? { status: row.status.state } : {}) })) };
      }
      if (verb === "get") return structuredClone(await io.onGet?.(find(args[1])) ?? find(args[1]));
      if (verb === "label") {
        const row = find(args[1]);
        for (const pair of args.slice(3)) {
          const [key, value] = pair.split(/=(.*)/s);
          if (value) row.labels[key] = value; else delete row.labels[key];
        }
        return structuredClone(row);
      }
      if (verb === "run") {
        const labels = {};
        args.forEach((arg, index) => { if (arg === "--label") { const [key, value] = args[index + 1].split(/=(.*)/s); labels[key] = value; } });
        const row = io.terminal(labels, null);
        row.argv = args.slice(args.indexOf("--") + 1);
        io.onRun?.(row);
        return { address: row.address, state: "live" };
      }
      if (verb === "send") {
        await io.onSend?.(find(args[2]), args[3]);
        find(args[2]).typed.push(args[3]);
        return { started: true, status: "working", turn: 1 };
      }
      if (verb === "kill") {
        find(args[1]).state = "finished";
        return structuredClone(find(args[1]));
      }
      throw new Error(`unexpected hc ${verb}`);
    },
  };
  return io;
}
const verbs = (io, verb) => io.calls.filter(args => args[0] === verb);

test("messages are wrapped in one form with escaped attributes", () => {
  const id = randomUUID();
  assert.equal(wrap({ from: "thread", title: `a "b" <c> & d`, id, text: "line <one>\nline two" }),
    `<message from="thread" title="a &quot;b&quot; &lt;c&gt; &amp; d" id="${id}">\nline <one>\nline two\n</message>`);
  assert.equal(wrap({ from: "user", text: "hello" }), `<message from="user">\nhello\n</message>`);
});

test("delete removes only the conversations of the deleted sessions", async t => {
  const f = fixture(t), io = hc();
  const coordinator = f.save(), other = f.save({ title: "Other" });
  const thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker" });
  const files = {};
  for (const record of [coordinator, thread, other]) {
    const sessionId = randomUUID();
    files[record.id] = f.transcript(sessionId);
    writeRecord(f.stateDir, { ...record, adapter: { ...f.adapter, sessionId, sessionFile: files[record.id] } });
  }
  const running = io.terminal(f.bound(thread.id));
  assert.deepEqual((await actions.delete({ ...f.options, id: coordinator.id }, io)).deleted, [thread.id, coordinator.id]);
  assert.equal(running.state, "finished");
  assert.equal(existsSync(files[coordinator.id]), false);
  assert.equal(existsSync(files[thread.id]), false);
  assert.equal(existsSync(files[other.id]), true);
  assert.equal(readRecord(f.stateDir, coordinator.id), undefined);
  assert.ok(readRecord(f.stateDir, other.id));

  const sessionId = randomUUID(), outside = f.transcript(sessionId, join(f.root, "outside.jsonl"));
  const link = join(f.agentDir, "sessions", "--work--", "link.jsonl");
  symlinkSync(outside, link);
  const wrongHeader = f.transcript(randomUUID());
  for (const sessionFile of [outside, link, wrongHeader]) remove({ adapter: { ...f.adapter, sessionId, sessionFile } });
  for (const path of [outside, link, wrongHeader]) assert.equal(existsSync(path), true, path);
});

test("close kills only a terminal that still carries the session's label", async t => {
  const f = fixture(t), io = hc(), thread = f.save({ role: "thread", coordinator: randomUUID() });
  const bystander = io.terminal({});
  const row = io.terminal(f.bound(thread.id));
  let gets = 0;
  io.onGet = found => { if (found === row && ++gets === 2) delete row.labels["projects.session"]; };
  await actions.close({ ...f.options, id: thread.id }, io);
  assert.equal(verbs(io, "kill").length, 0, "the label left between the first look and the kill");
  io.onGet = undefined;
  row.labels["projects.session"] = thread.id;
  await actions.close({ ...f.options, id: thread.id }, io);
  assert.deepEqual(verbs(io, "kill"), [["kill", row.address, "--json"]]);
  assert.equal(bystander.state, "live");
});

test("closing a project kills each of its sessions once and nothing else", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save(), other = f.save({ title: "Other" });
  const workers = ["One", "Two", "Three"].map(title => f.save({ role: "thread", coordinator: coordinator.id, title }));
  const stopped = f.save({ role: "thread", coordinator: coordinator.id, title: "Stopped" });
  const project = [coordinator, ...workers].map(record => io.terminal(f.bound(record.id)));
  const kept = [io.terminal({}), io.terminal(f.bound(stopped.id, DEAD)), io.terminal(f.bound(other.id))];
  await actions.close({ ...f.options, id: coordinator.id }, io);
  assert.deepEqual(verbs(io, "kill").map(args => args[1]).sort(), project.map(row => row.address).sort());
  assert.deepEqual(kept.map(row => row.state), ["live", "live", "live"]);
  assert.deepEqual([...workers, stopped].map(thread => readRecord(f.stateDir, thread.id).reopenWithProject), [true, true, true, undefined]);
});

test("a thread launches with its coordinator's current command", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save({ adapter: { ...f.adapter, sessionId: randomUUID() } });
  // The thread's own register stored the command it ran under, which has since moved.
  const sessionId = randomUUID(), thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker", reopenWithProject: true,
    adapter: { sessionId, command: ["/old/node", "/old/pi"], env: { PATH: "/old" } } });
  const moved = { ...coordinator.adapter, command: ["/new/node", "/new/pi"], env: { PATH: "/new" } };
  await actions.register({ ...f.options, id: coordinator.id, cwd: f.cwd, agent: "pi", adapter: moved, terminal: io.terminal({}).address, pid: process.pid }, io);
  assert.deepEqual(io.rows.at(-1).argv, ["env", "PATH=/new", `PROJECTS_SESSION=${thread.id}`, "/new/node", "/new/pi", "--session-id", sessionId]);
});

test("a terminal counts only while the agent process it names is alive", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save();
  const thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker" });
  const leftBehind = io.terminal(f.bound(coordinator.id, DEAD), "idle");
  const stored = await actions.send({ ...f.options, to: coordinator.id, from: thread.id, text: "result" }, io);
  assert.deepEqual([stored.state, stored.sent, stored.waiting], ["stopped", false, 1]);
  assert.deepEqual(leftBehind.typed, []);

  const slow = io.terminal(f.bound(thread.id), null, 120_000);
  assert.equal((await actions.list(f.options, io)).sessions.find(view => view.id === thread.id).state, "starting");
  const waiting = await actions.send({ ...f.options, to: thread.id, from: coordinator.id, text: "work" }, io);
  assert.deepEqual([waiting.state, waiting.sent, waiting.note], ["starting", false, "stored; it goes out when the session starts"]);
  assert.deepEqual(slow.typed, []);
  assert.equal(verbs(io, "run").length, 0);
});

test("a stopped thread is launched under its live pid and gets its mail", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save(), thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker" });
  const shell = io.terminal({ "projects.session": thread.id }, "idle");
  io.onRun = row => { row.status = { app: "pi", state: "idle" }; };
  const sent = await actions.send({ ...f.options, to: thread.id, from: coordinator.id, text: "work" }, io);
  assert.equal(sent.sent, true);
  assert.deepEqual(shell.typed, []);
  assert.equal(shell.labels["projects.session"], undefined, "launching cleared the label left behind");
  const launched = io.rows.at(-1);
  assert.equal(launched.labels["projects.pid"], String(process.pid));
  assert.deepEqual(launched.typed, [wrap({ from: "coordinator", title: coordinator.title, id: coordinator.id, text: "work" })]);
});

test("reopening a session starts it in its tab, then closes the empty shell it left there", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save(), thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker" });
  // What a reboot leaves: the terminals core started, back as shells, one of them busy, and one of the user's.
  const empty = io.terminal(f.left(thread.id), null), busy = io.terminal(f.left(thread.id), null), own = io.terminal(f.bound(thread.id, DEAD), null);
  empty.foreground = { pid: empty.pid };
  busy.foreground = { pid: 4242 };
  own.foreground = { pid: own.pid };
  await actions.open({ ...f.options, id: thread.id }, io);
  const [run] = verbs(io, "run"), order = io.calls.map(args => `${args[0]} ${args[1]}`);
  assert.equal(run.slice(0, run.indexOf("--")).includes("--name"), false, "hc gives the terminal no name, so one left behind never takes the next one's");
  assert.ok(run.includes("projects.launched=1"), "core marks what it started");
  assert.ok(order.indexOf("run --bg") < order.indexOf(`kill ${empty.address}`), "the tab and its space stay alive until the session is back in them");
  assert.equal(empty.state, "finished");
  assert.deepEqual([busy.state, busy.labels], ["live", {}], "what the user runs there keeps its terminal");
  assert.deepEqual([own.state, own.labels], ["live", {}], "a terminal the user started is only unlabelled");
  assert.equal(io.rows.at(-1).labels["projects.pid"], String(process.pid));
});

test("release keeps the terminal core started for the session and gives the user's back", async t => {
  const f = fixture(t), io = hc(), started = f.save(), own = f.save({ title: "Other" });
  const launched = io.terminal({ ...f.left(started.id), "projects.pid": String(process.pid) }), user = io.terminal(f.bound(own.id));
  await actions.release({ ...f.options, id: started.id }, io);
  await actions.release({ ...f.options, id: own.id }, io);
  assert.deepEqual(launched.labels, f.left(started.id), "it waits for the session; only the agent's pid is gone");
  assert.deepEqual(user.labels, {}, "the user's own terminal is theirs again");
});

test("register reopens a thread that left a terminal of core's behind, with no flag to go by", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save({ adapter: { ...f.adapter, sessionId: randomUUID() } });
  const thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker" });
  const empty = io.terminal(f.left(thread.id), null);
  empty.foreground = { pid: empty.pid };
  const terminal = io.terminal({});
  await actions.register({ ...f.options, id: coordinator.id, cwd: f.cwd, agent: "pi", adapter: coordinator.adapter, terminal: terminal.address, pid: process.pid }, io);
  assert.equal(verbs(io, "run").length, 1, "the thread it left behind is started again");
  assert.equal(empty.state, "finished");
  assert.equal(io.rows.at(-1).labels["projects.session"], thread.id);
});

test("deleting a project also closes the empty shells its sessions left behind", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save(), thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker" });
  const empty = io.terminal(f.left(thread.id), null), other = io.terminal({ "herdr.space": "s" }, null);
  empty.foreground = { pid: empty.pid };
  await actions.delete({ ...f.options, id: coordinator.id }, io);
  assert.deepEqual([empty.state, other.state], ["finished", "live"]);
});

test("cleanup leaves a terminal reassigned to another session alone", async t => {
  const f = fixture(t), io = hc(), thread = f.save({ role: "thread", coordinator: randomUUID() });
  const row = io.terminal(f.left(thread.id), null), replacement = f.bound(randomUUID());
  row.foreground = { pid: row.pid };
  let gets = 0;
  io.onGet = found => { if (found === row && ++gets === 2) row.labels = { ...replacement }; };
  await actions.close({ ...f.options, id: thread.id }, io);
  assert.equal(row.state, "live");
  assert.deepEqual(row.labels, replacement);
});

test("double launch is refused", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save({ adapter: { ...f.adapter, sessionId: randomUUID() } });
  const first = io.terminal({}), second = io.terminal({});
  const register = terminal => actions.register({ ...f.options, id: coordinator.id, cwd: f.cwd, agent: "pi", adapter: coordinator.adapter, terminal, pid: process.pid }, io);
  await register(first.address);
  await assert.rejects(register(second.address), /already open in terminal t1/);
  assert.equal(second.labels["projects.session"], undefined);

  const thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker" });
  await Promise.all([actions.open({ ...f.options, id: thread.id }, io), actions.open({ ...f.options, id: thread.id }, io)]);
  assert.equal(verbs(io, "run").length, 1);
});

test("waiting mail is kept in order and handed over once", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save({ adapter: { ...f.adapter, sessionId: randomUUID() } });
  const thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker" });
  for (const text of ["one", "two", "three"]) await actions.send({ ...f.options, to: coordinator.id, from: thread.id, text }, io);
  assert.equal(readRecord(f.stateDir, coordinator.id).waiting.length, 3);
  const terminal = io.terminal({});
  let failed = false;
  io.onSend = (row, text) => { if (text.includes("\nthree\n") && !failed) { failed = true; throw new Error("hc send: lost"); } };
  const register = () => actions.register({ ...f.options, id: coordinator.id, cwd: f.cwd, agent: "pi", adapter: coordinator.adapter, terminal: terminal.address, pid: process.pid }, io);
  const first = await register();
  assert.equal(first.waiting, 1);
  assert.match(first.error, /lost/);
  io.onSend = () => new Promise(resolve => setImmediate(resolve));
  await Promise.all([register(), register()]);
  const message = text => wrap({ from: "thread", title: "Worker", id: thread.id, text });
  assert.deepEqual(terminal.typed, [message("one"), message("two"), message("three")]);
  assert.deepEqual(readRecord(f.stateDir, coordinator.id).waiting, []);
});

test("a blocked session keeps the message and later mail does not overtake it", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save(), thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker" });
  const row = io.terminal(f.bound(thread.id), "blocked");
  const held = await actions.send({ ...f.options, to: thread.id, from: coordinator.id, text: "first" }, io);
  assert.deepEqual([held.sent, held.note, held.waiting], [false, "stored; the session is waiting on the user", 1]);
  assert.deepEqual(row.typed, []);
  row.status = { app: "pi", state: "idle" };
  const later = await actions.send({ ...f.options, to: thread.id, from: coordinator.id, text: "second" }, io);
  assert.deepEqual([later.sent, later.waiting], [true, 0]);
  const message = text => wrap({ from: "coordinator", title: coordinator.title, id: coordinator.id, text });
  assert.deepEqual(row.typed, [message("first"), message("second")]);
});

test("only its coordinator or the user reopens a resolved thread by sending", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save();
  const thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker", resolved: true });
  const peer = f.save({ role: "thread", coordinator: coordinator.id, title: "Peer" });
  const row = io.terminal(f.bound(thread.id));
  await assert.rejects(actions.send({ ...f.options, to: thread.id, from: peer.id, text: "hi" }, io), /resolved/);
  assert.equal(readRecord(f.stateDir, thread.id).resolved, true);
  assert.equal((await actions.send({ ...f.options, to: thread.id, from: coordinator.id, text: "again" }, io)).resolved, false);
  writeRecord(f.stateDir, { ...readRecord(f.stateDir, thread.id), resolved: true });
  assert.equal((await actions.send({ ...f.options, to: thread.id, text: "from the user" }, io)).resolved, false);
  assert.equal(row.typed.length, 2);
});

test("an agent cannot rename a title the user chose", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save({ title: "Mine", titleSource: "user" });
  await assert.rejects(actions.rename({ ...f.options, id: coordinator.id, title: "Theirs", by: "agent" }, io), /user chose/);
  assert.equal(readRecord(f.stateDir, coordinator.id).title, "Mine");
  const thread = f.save({ role: "thread", coordinator: coordinator.id, title: "New thread", titleSource: "placeholder" });
  const renamed = await actions.rename({ ...f.options, id: thread.id, title: "Parser", by: "agent" }, io);
  assert.equal(renamed.title, "Parser");
  assert.equal(renamed.titleSource, "agent");
});
