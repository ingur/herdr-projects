import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { actions, wrap } from "../core/control.mjs";
import { readRecord, writeRecord } from "../core/store.mjs";

const DEAD = 2 ** 31 - 1;
const ME = process.pid, OTHER = process.ppid;

function fakeHc() {
  const rows = [], calls = [];
  const find = address => {
    const row = rows.find(row => row.address === address);
    if (!row) throw new Error(`hc: no terminal ${address}`);
    return row;
  };
  const labels = pairs => Object.fromEntries(pairs.map(pair => pair.split(/=(.*)/s).slice(0, 2)));
  const io = {
    rows, calls, followed: [],
    delay: () => new Promise(resolve => setImmediate(resolve)),
    follow: (stateDir, id) => io.followed.push(id),
    terminal(labels = {}, status = "idle") {
      const row = { address: `t${rows.length + 1}`, state: "live", pid: ME, labels, status: status ? { app: "tool", state: status } : null, typed: [] };
      rows.push(row);
      return row;
    },
    async command(program, args) {
      calls.push(args);
      const [verb] = args;
      if (verb === "ls") {
        const [[key, value]] = Object.entries(labels([args[args.indexOf("--label") + 1]]));
        return { terminals: rows.filter(row => row.state === "live" && row.labels[key] === value).map(({ address, state }) => ({ address, state })) };
      }
      if (verb === "get") return structuredClone(find(args[1]));
      if (verb === "label") {
        const row = find(args[1]);
        for (const [key, value] of Object.entries(labels(args.slice(3)))) {
          if (value) row.labels[key] = value; else delete row.labels[key];
        }
        return structuredClone(row);
      }
      if (verb === "run") {
        const row = io.terminal(labels(args.filter((arg, index) => args[index - 1] === "--label")), io.startsWith ?? null);
        row.argv = args.slice(args.indexOf("--") + 1);
        return { address: row.address, state: "live" };
      }
      if (verb === "send") {
        await io.onSend?.(args[3]);
        find(args[2]).typed.push(args[3]);
        return { started: true };
      }
      if (verb === "exec") return { code: io.missing === args.at(-1) ? 1 : 0 };
      if (verb === "kill") {
        find(args[1]).state = "finished";
        return structuredClone(find(args[1]));
      }
      throw new Error(`unexpected hc ${verb}`);
    },
  };
  return io;
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-projects-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), cwd = join(root, "work"), options = { stateDir }, io = fakeHc(), removed = [];
  mkdirSync(cwd);
  io.adapters = {
    tool: {
      variables: ["PATH", "TOOL_HOME"],
      start: record => ["tool", "--name", record.title],
      resume: conversation => conversation.saved ? ["tool", "--resume", conversation.id] : undefined,
      remove: conversation => removed.push(conversation.id),
    },
  };
  const control = JSON.stringify({ version: 2, command: [join(stateDir, "bin", "control")], stateDir });
  const save = (fields = {}) => {
    const id = randomUUID();
    return writeRecord(stateDir, {
      version: 3, id, role: "coordinator", coordinator: id, title: "Project", titleSource: "user", cwd, agent: "tool",
      resolved: false, rank: 1, created: new Date().toISOString(), waiting: [], ...fields,
    });
  };
  const thread = (coordinator, title, fields = {}) => save({ role: "thread", coordinator: coordinator.id, title, ...fields });
  const waiting = id => ({ "projects.session": id, "projects.control": control, "projects.pid": `@${ME}` });
  const left = id => ({ ...waiting(id), "projects.launched": "1" });
  const started = id => ({ ...left(id), "projects.pid": `${ME}@${ME}` });
  const bound = (id, pid = ME) => ({ "projects.session": id, "projects.control": control, "projects.pid": `${pid}@${ME}`, "projects.bound": "1" });
  const arrive = (action, terminal, conversation, extra = {}) => actions[action]({
    ...options, cwd, agent: "tool", terminal: terminal.address, pid: ME, conversation: { id: conversation }, env: {}, ...extra,
  }, io);
  const state = async id => (await actions.list(options, io)).sessions.find(view => view.id === id).state;
  const record = id => readRecord(stateDir, id);
  return { stateDir, cwd, options, io, removed, save, thread, waiting, left, started, bound, arrive, state, record };
}

const runs = io => io.calls.filter(args => args[0] === "run");

test("messages are wrapped in one form with escaped attributes", () => {
  const id = randomUUID();
  assert.equal(wrap({ from: "thread", title: `a "b" <c> & d`, id, text: "line <one>\nline two" }),
    `<message from="thread" title="a &quot;b&quot; &lt;c&gt; &amp; d" id="${id}">\nline <one>\nline two\n</message>`);
  assert.equal(wrap({ from: "user", text: "hello" }), `<message from="user">\nhello\n</message>`);
});

test("a session core started is entered by the first agent in its terminal, and by no other process after it", async t => {
  const f = fixture(t), coordinator = f.save(), worker = f.thread(coordinator, "Worker"), gone = f.thread(coordinator, "Gone");
  const terminal = f.io.terminal(f.started(worker.id));
  assert.equal(await f.state(worker.id), "starting");

  const { session } = await f.arrive("enter", terminal, "first", { pid: OTHER });
  assert.deepEqual([session.id, session.role, session.state], [worker.id, "thread", "running"]);
  assert.equal(f.record(worker.id).conversation.id, "first");

  assert.deepEqual(await f.arrive("enter", terminal, "inner"), {});
  assert.deepEqual(await actions.session({ ...f.options, terminal: terminal.address, pid: ME }, f.io), {});
  assert.equal((await actions.session({ ...f.options, terminal: terminal.address, pid: OTHER }, f.io)).session.id, worker.id);
  assert.equal(f.record(worker.id).conversation.id, "first");

  assert.deepEqual(await f.arrive("enter", f.io.terminal(f.left(gone.id)), "unrelated"), {});
  assert.equal(f.record(gone.id).conversation, undefined);
});

test("a replaced conversation keeps the project; another conversation leaves it", async t => {
  const f = fixture(t), project = f.save({ conversation: { id: "one" } }), other = f.save({ title: "Other", conversation: { id: "elsewhere" } });
  const terminal = f.io.terminal({});

  assert.equal((await f.arrive("enter", terminal, "one")).session.id, project.id);
  assert.equal((await f.arrive("enter", terminal, "two", { replaced: true })).session.id, project.id);
  assert.equal(f.record(project.id).conversation.id, "two");

  assert.equal((await f.arrive("enter", terminal, "elsewhere")).session.id, other.id);
  assert.deepEqual([await f.state(project.id), await f.state(other.id)], ["stopped", "running"]);

  assert.deepEqual(await f.arrive("enter", terminal, "unknown"), {});
  assert.equal(await f.state(other.id), "stopped");
  assert.deepEqual(terminal.labels, {});
});

test("create makes the conversation a project, once", async t => {
  const f = fixture(t), terminal = f.io.terminal({});
  const { session } = await f.arrive("create", terminal, "talk", { title: "Mine" });
  assert.deepEqual([session.role, session.title, session.titleSource, session.state], ["coordinator", "Mine", "user", "running"]);
  await assert.rejects(f.arrive("create", f.io.terminal({}), "talk"), /already in a project/);

  const untitled = await f.arrive("create", f.io.terminal({}), "another");
  assert.deepEqual([untitled.session.title, untitled.session.titleSource], ["New project", "placeholder"]);
});

test("a session is open in one terminal", async t => {
  const f = fixture(t), project = f.save({ conversation: { id: "one" } });
  await f.arrive("enter", f.io.terminal({}), "one");
  const second = f.io.terminal({});
  await assert.rejects(f.arrive("enter", second, "one"), /already open in terminal t1/);
  assert.deepEqual(second.labels, {});
  assert.equal(await f.state(project.id), "running");
});

test("a terminal waits for the session its agent left, whoever started it", async t => {
  const f = fixture(t), launched = f.save(), own = f.save({ title: "Own" });
  const cores = f.io.terminal({ ...f.started(launched.id), "projects.bound": "1" }), users = f.io.terminal(f.bound(own.id));
  const leave = (terminal, pid) => actions.leave({ ...f.options, terminal: terminal.address, pid }, f.io);

  assert.deepEqual(await leave(users, OTHER), {});
  assert.equal(await f.state(own.id), "running");

  await leave(cores, ME);
  await leave(users, ME);
  assert.deepEqual(cores.labels, f.left(launched.id));
  assert.deepEqual(users.labels, f.waiting(own.id));
  assert.deepEqual([await f.state(launched.id), await f.state(own.id)], ["stopped", "stopped"]);
});

test("a tool starts with the environment its adapter named, as last seen", async t => {
  const f = fixture(t), terminal = f.io.terminal({});
  const { session } = await f.arrive("create", terminal, "talk", { env: { PATH: "/bin", TOOL_HOME: "/home", SECRET: "no" } });

  const fresh = await actions["create-thread"]({ ...f.options, coordinator: session.id, title: "Fresh" }, f.io);
  assert.deepEqual(f.io.rows.at(-1).argv, ["env", "PATH=/bin", "TOOL_HOME=/home", `PROJECTS_STATE_DIR=${f.stateDir}`, "tool", "--name", "Fresh"]);
  assert.equal(fresh.state, "starting");

  const saved = f.thread({ id: session.id }, "Saved", { conversation: { id: "kept", saved: true } });
  await actions.open({ ...f.options, id: saved.id }, f.io);
  assert.deepEqual(f.io.rows.at(-1).argv.slice(-3), ["tool", "--resume", "kept"]);

  await assert.rejects(actions["create-thread"]({ ...f.options, coordinator: session.id, agent: "unknown" }, f.io), /No adapter/);
  f.io.missing = "tool";
  const lost = await actions["create-thread"]({ ...f.options, coordinator: session.id, title: "Lost" }, f.io);
  assert.deepEqual([lost.state, /tool was not found/.test(lost.error)], ["stopped", true]);
  assert.equal(runs(f.io).length, 2);
});

test("mail goes out, in order, once the session has entered and reports a status", async t => {
  const f = fixture(t), coordinator = f.save(), worker = f.thread(coordinator, "Worker");
  f.io.startsWith = "idle";
  const first = await actions.send({ ...f.options, as: coordinator.id, to: "Worker", text: "one" }, f.io);
  assert.deepEqual([first.sent, first.state, first.waiting], [false, "starting", 1]);
  assert.match(first.note, /starts/);
  await actions.send({ ...f.options, to: worker.id, text: "two" }, f.io);
  const terminal = f.io.rows.at(-1);
  assert.deepEqual([runs(f.io).length, terminal.typed], [1, []]);

  await f.arrive("enter", terminal, "talk");
  assert.deepEqual(f.io.followed, [worker.id]);
  await actions.settle({ ...f.options, id: worker.id }, f.io);
  assert.deepEqual(terminal.typed, [
    wrap({ from: "coordinator", title: "Project", id: coordinator.id, text: "one" }),
    wrap({ from: "user", text: "two" }),
  ]);

  const third = await actions.send({ ...f.options, to: worker.id, text: "three" }, f.io);
  assert.deepEqual([third.sent, third.waiting, terminal.typed.length], [true, 0, 3]);
});

test("a message hc did not take stays waiting and is typed again", async t => {
  const f = fixture(t), project = f.save({ conversation: { id: "one" } }), terminal = f.io.terminal({});
  for (const text of ["one", "two"]) await actions.send({ ...f.options, to: project.id, text }, f.io);
  await f.arrive("enter", terminal, "one");
  let lost = false;
  f.io.onSend = text => { if (text.includes("two") && !lost) { lost = true; throw new Error("hc send: lost"); } };
  const failed = await actions.settle({ ...f.options, id: project.id }, f.io);
  assert.equal(failed.waiting, 1);
  assert.match(failed.error, /lost/);
  await actions.settle({ ...f.options, id: project.id }, f.io);
  assert.deepEqual(terminal.typed, ["one", "two"].map(text => wrap({ from: "user", text })));
});

test("a blocked session keeps its mail, and later mail does not overtake it", async t => {
  const f = fixture(t), project = f.save(), terminal = f.io.terminal(f.bound(project.id), "blocked");
  const held = await actions.send({ ...f.options, to: project.id, text: "first" }, f.io);
  assert.deepEqual([held.sent, held.status, held.waiting, terminal.typed], [false, "blocked", 1, []]);
  terminal.status.state = "idle";
  await actions.send({ ...f.options, to: project.id, text: "second" }, f.io);
  assert.deepEqual(terminal.typed, ["first", "second"].map(text => wrap({ from: "user", text })));
});

test("core keeps an agent to its role and its project", async t => {
  const f = fixture(t), coordinator = f.save(), other = f.save({ title: "Other" });
  const worker = f.thread(coordinator, "Worker", { titleSource: "placeholder" }), peer = f.thread(coordinator, "Peer");
  const stranger = f.thread(other, "Stranger");
  const as = (id, action, options = {}) => actions[action]({ ...f.options, as: id, ...options }, f.io);

  await assert.rejects(as(worker.id, "create-thread", { title: "Mine" }), /under a coordinator/);
  await assert.rejects(actions.act({ ...f.options, tool: "thread_send", args: { target: "user", text: "hi" } }, f.io), /not in a project/);
  assert.equal((await actions.act({ ...f.options, as: worker.id, tool: "thread_send", args: { target: "user", text: "hi" } }, f.io)).sent, false);
  await assert.rejects(as(worker.id, "resolve", { id: "Peer" }), /Only a thread's coordinator/);
  await assert.rejects(as(worker.id, "rename", { id: "Peer", title: "Mine" }), /only itself/);
  await assert.rejects(as(worker.id, "send", { to: worker.id, text: "hi" }), /not yourself/);
  for (const to of ["Stranger", stranger.id]) await assert.rejects(as(worker.id, "send", { to, text: "hi" }), /No session/);

  const listed = await as(worker.id, "list");
  assert.equal(listed.you, worker.id);
  assert.deepEqual(listed.sessions.map(view => view.id).sort(), [coordinator.id, worker.id, peer.id].sort());

  assert.equal((await as(worker.id, "rename", { title: "Parser" })).titleSource, "agent");
  await assert.rejects(as(coordinator.id, "rename", { title: "Theirs" }), /user chose/);
  assert.equal((await as(coordinator.id, "resolve", { id: "peer" })).resolved, true);
  assert.deepEqual([f.record(stranger.id).waiting, f.record(stranger.id).resolved], [[], false]);
});

test("only its coordinator or the user reopens a resolved thread by sending", async t => {
  const f = fixture(t), coordinator = f.save(), worker = f.thread(coordinator, "Worker", { resolved: true }), peer = f.thread(coordinator, "Peer");
  f.io.terminal(f.bound(worker.id));
  await assert.rejects(actions.send({ ...f.options, as: peer.id, to: "Worker", text: "hi" }, f.io), /resolved/);
  assert.equal(f.record(worker.id).resolved, true);
  assert.equal((await actions.send({ ...f.options, as: coordinator.id, to: "Worker", text: "again" }, f.io)).resolved, false);
  writeRecord(f.stateDir, { ...f.record(worker.id), resolved: true });
  assert.equal((await actions.send({ ...f.options, to: worker.id, text: "from the user" }, f.io)).resolved, false);
});

test("a client asks a stopped project as the user and collects the answer", async t => {
  const f = fixture(t), project = f.save({ conversation: { id: "talk", saved: true } });
  const asked = await actions.send({ ...f.options, to: project.id, text: "How far is the port?" }, f.io);
  assert.deepEqual([asked.sent, asked.state, asked.waiting], [false, "stopped", 1]);
  await assert.rejects(actions.send({ ...f.options, to: "user", text: "hello" }, f.io), /comes from a session/);

  f.io.startsWith = "idle";
  await actions.open({ ...f.options, id: project.id }, f.io);
  const terminal = f.io.rows.at(-1);
  await f.arrive("enter", terminal, "talk");
  await actions.settle({ ...f.options, id: project.id }, f.io);
  assert.deepEqual(terminal.typed, [wrap({ from: "user", text: "How far is the port?" })]);

  const answered = await actions.send({ ...f.options, as: project.id, to: "user", text: "12 of 30 files." }, f.io);
  assert.equal(answered.sent, false);
  assert.match(answered.note, /stored for the user/);
  const { messages } = await actions.collect(f.options);
  assert.deepEqual(messages.map(({ from, title, id, text }) => [from, title, id, text]), [["coordinator", "Project", project.id, "12 of 30 files."]]);
  assert.deepEqual(await actions.collect(f.options), { messages });
  assert.deepEqual(await actions.collect({ ...f.options, taken: [messages[0].key] }), { messages: [] });
  await assert.rejects(actions.collect({ ...f.options, taken: ["../sessions/x"] }), /keys from collect/);
});

test("closing a project closes its threads, and entering it again brings the open ones back", async t => {
  const f = fixture(t), project = f.save({ conversation: { id: "talk" } }), bystander = f.io.terminal({});
  const open = f.thread(project, "Open"), done = f.thread(project, "Done", { resolved: true }), idle = f.thread(project, "Idle");
  const terminals = [project, open, done].map(record => f.io.terminal(f.bound(record.id)));
  await actions.close({ ...f.options, id: project.id }, f.io);
  assert.deepEqual(terminals.map(row => row.state), ["finished", "finished", "finished"]);
  assert.equal(bystander.state, "live");

  await f.arrive("enter", f.io.terminal({}), "talk");
  await actions.settle({ ...f.options, id: project.id }, f.io);
  assert.deepEqual(runs(f.io).length, 1);
  assert.equal(f.io.rows.at(-1).labels["projects.session"], open.id);
  assert.deepEqual([await f.state(done.id), await f.state(idle.id)], ["stopped", "stopped"]);
});

test("opening a session starts it in its tab, then closes the empty shell hc put there, and no shell the user is in", async t => {
  const f = fixture(t), worker = f.thread(f.save(), "Worker");
  const empty = f.io.terminal(f.waiting(worker.id), null), busy = f.io.terminal(f.left(worker.id), null);
  const restored = f.io.terminal({ ...f.started(worker.id), "projects.bound": "1" }, null), own = f.io.terminal(f.waiting(worker.id), null);
  for (const row of [empty, busy, restored]) row.pid = ME + 1;
  for (const row of [empty, restored, own]) row.foreground = { pid: row.pid };
  busy.foreground = { pid: 4242 };
  assert.equal(await f.state(worker.id), "stopped");

  await actions.open({ ...f.options, id: worker.id }, f.io);
  const order = f.io.calls.map(args => `${args[0]} ${args[1]}`);
  assert.ok(order.indexOf("run --bg") < order.indexOf(`kill ${empty.address}`));
  assert.deepEqual([empty.state, restored.state, busy.state, busy.labels, own.state, own.labels], ["finished", "finished", "live", {}, "live", {}]);
  assert.equal(f.io.rows.at(-1).labels["projects.launched"], "1");
});

test("a terminal holds a session only while its agent is alive", async t => {
  const f = fixture(t), project = f.save(), dead = f.io.terminal(f.bound(project.id, DEAD));
  const stored = await actions.send({ ...f.options, to: project.id, text: "hello" }, f.io);
  assert.deepEqual([stored.state, stored.sent, stored.waiting, dead.typed], ["stopped", false, 1, []]);
});

test("delete removes the sessions, their conversations and nothing else", async t => {
  const f = fixture(t), project = f.save({ conversation: { id: "a" } }), other = f.save({ title: "Other", conversation: { id: "c" } });
  const worker = f.thread(project, "Worker", { conversation: { id: "b" } }), unstarted = f.thread(project, "Unstarted");
  const running = f.io.terminal(f.bound(worker.id));
  const { deleted } = await actions.delete({ ...f.options, id: project.id }, f.io);
  assert.deepEqual(deleted.sort(), [project.id, worker.id, unstarted.id].sort());
  assert.deepEqual([running.state, f.removed.sort(), f.record(project.id)], ["finished", ["a", "b"], undefined]);
  assert.ok(f.record(other.id));
});

test("a lock whose owner died is taken over", async t => {
  const f = fixture(t), project = f.save();
  mkdirSync(join(f.stateDir, "locks"));
  writeFileSync(join(f.stateDir, "locks", project.id), String(DEAD));
  assert.equal((await actions.order({ ...f.options, id: project.id, rank: 5 }, f.io)).rank, 5);
});
