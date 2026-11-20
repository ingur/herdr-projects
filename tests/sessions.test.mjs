import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DEAD, fixture, ME, OTHER } from "./fixture.mjs";

test("every agent in a terminal is a session: a new conversation becomes a plain session", async t => {
  const f = fixture(t), terminal = f.io.terminal({});
  const { session } = await f.enter(terminal, "talk");
  assert.deepEqual([session.kind, session.title, session.titleSource, session.project], ["plain", "New session", "placeholder", undefined]);
  assert.deepEqual([f.record(session.id).folder, f.record(session.id).conversation], [f.folder, { id: "talk" }]);
  assert.equal(await f.state(session.id), "running");
  assert.deepEqual(f.extension.current({ id: session.id }), { session });
});

test("a session core started is entered by the first agent in its terminal, and by no other process after it", async t => {
  const f = fixture(t), coordinator = f.project(), worker = f.thread(coordinator, "Worker");
  const terminal = f.io.terminal(f.started(worker.id));
  assert.equal(await f.state(worker.id), "starting");

  const { session } = await f.enter(terminal, "first", { pid: OTHER });
  assert.deepEqual([session.id, session.kind, await f.state(worker.id)], [worker.id, "thread", "running"]);
  assert.equal(f.record(worker.id).conversation.id, "first");

  await assert.rejects(f.enter(terminal, "nested"), /t1 already runs the session Worker/);
  assert.equal(f.record(worker.id).conversation.id, "first");
});

test("a replaced conversation keeps the session; another conversation is another session", async t => {
  const f = fixture(t), project = f.project({ conversation: { id: "one" } }), other = f.save({ title: "Other", conversation: { id: "elsewhere", saved: true } });
  const terminal = f.io.terminal({});

  assert.equal((await f.enter(terminal, "one")).session.id, project.id);
  assert.equal((await f.enter(terminal, "two", { replaced: true })).session.id, project.id);
  assert.equal(f.record(project.id).conversation.id, "two");

  assert.equal((await f.enter(terminal, "elsewhere", { conversation: other.conversation })).session.id, other.id);
  assert.deepEqual([await f.state(project.id), await f.state(other.id)], ["stopped", "running"]);

  const fresh = (await f.enter(terminal, "unknown")).session;
  assert.deepEqual([fresh.kind, await f.state(other.id), terminal.labels["projects.session"]], ["plain", "stopped", fresh.id]);

  assert.equal((await f.enter(terminal, "two")).session.id, project.id);
  assert.equal(f.record(fresh.id), undefined, "a plain session nothing was said in goes when its terminal runs another session");
});

test("a session is open in one terminal", async t => {
  const f = fixture(t), project = f.project({ conversation: { id: "one" } });
  await f.enter(f.io.terminal({}), "one");
  const second = f.io.terminal({});
  await assert.rejects(f.enter(second, "one"), /already open in terminal t1/);
  assert.deepEqual(second.labels, {});
  assert.equal(await f.state(project.id), "running");
});

test("/projects new makes a plain session a coordinator, once, and a thread never", async t => {
  const f = fixture(t), plain = f.save({ title: "New session", titleSource: "placeholder" }), named = f.save({ title: "Parser" });
  const worker = f.thread(f.project(), "Worker");

  const untitled = (await f.extension.project({ id: plain.id })).session;
  assert.deepEqual([untitled.kind, untitled.project, untitled.title, untitled.titleSource], ["coordinator", plain.id, "New project", "placeholder"]);
  assert.equal((await f.extension.project({ id: named.id })).session.title, "Parser");
  await assert.rejects(f.extension.project({ id: plain.id, title: "Again" }), /already a project/);
  await assert.rejects(f.extension.project({ id: worker.id }), /thread cannot become a project/);

  const mine = f.save();
  assert.deepEqual((({ title, titleSource }) => [title, titleSource])((await f.extension.project({ id: mine.id, title: "Mine" })).session), ["Mine", "user"]);
});

test("a name the user gives inside the agent is the title, under the one rule for titles", async t => {
  const f = fixture(t), plain = f.save({ title: "New session", titleSource: "placeholder" });
  await assert.rejects(f.extension.named({ id: plain.id, title: "x".repeat(81) }), /1 to 80/);
  await assert.rejects(f.extension.named({ id: plain.id, title: "User" }), /cannot be called user/);
  await assert.rejects(f.extension.named({ id: plain.id, title: "ｕser" }), /cannot be called user/);
  for (const hidden of ["user\u200b", "u\u00adser", "\u200b", "\u202eresu"]) await assert.rejects(f.extension.named({ id: plain.id, title: hidden }), /printable/);
  const { session } = await f.extension.named({ id: plain.id, title: "Parser" });
  assert.deepEqual([session.title, session.titleSource], ["Parser", "user"]);
  await assert.rejects(f.as(plain.id, "title_set", { title: "Theirs" }), /user chose/);
});

test("a terminal waits for the session its agent left, whoever started it", async t => {
  const f = fixture(t), launched = f.project({ conversation: { id: "a", saved: true } }), own = f.save({ title: "Own", conversation: { id: "b", saved: true } });
  const cores = f.io.terminal({ ...f.started(launched.id), "projects.bound": "1" }), users = f.io.terminal(f.bound(own.id));

  await f.extension.leave({ terminal: users.address, pid: OTHER });
  assert.equal(await f.state(own.id), "running");

  await f.extension.leave({ terminal: cores.address, pid: ME });
  await f.extension.leave({ terminal: users.address, pid: ME });
  assert.deepEqual(cores.labels, f.left(launched.id));
  assert.deepEqual(users.labels, f.waiting(own.id));
  assert.deepEqual([await f.state(launched.id), await f.state(own.id)], ["stopped", "stopped"]);
});

test("a plain session with no conversation to come back to and no mail does not outlive its agent", async t => {
  const f = fixture(t), empty = f.io.terminal({}), asked = f.io.terminal({});
  const gone = (await f.enter(empty, "never-saved")).session, kept = (await f.enter(asked, "also-never-saved")).session;
  await f.client.send({ to: kept.id, text: "for later" });

  await f.extension.leave({ terminal: empty.address, pid: ME });
  await f.extension.leave({ terminal: asked.address, pid: ME });
  assert.deepEqual([f.record(gone.id), empty.labels], [undefined, {}]);
  assert.equal((await f.client.list()).sessions.find(view => view.id === kept.id).waiting, 1);
});

test("an agent starts with the environment its adapter named, as last seen, in the session's folder", async t => {
  const f = fixture(t), coordinator = f.project({ conversation: { id: "talk" } }), elsewhere = join(f.folder, "sub");
  mkdirSync(elsewhere);
  await f.enter(f.io.terminal({}), "talk", { env: { PATH: "/bin", TOOL_HOME: "/home", SECRET: "no" } });

  const fresh = await f.client.createThread({ coordinator: coordinator.id, title: "Fresh", folder: "sub" });
  assert.deepEqual(f.io.rows.at(-1).argv, ["env", "PATH=/bin", "TOOL_HOME=/home", `PROJECTS_STATE_DIR=${f.stateDir}`, "tool"]);
  assert.deepEqual([fresh.state, fresh.kind, fresh.project, f.io.rows.at(-1).folder], ["starting", "thread", coordinator.id, elsewhere]);

  const saved = f.thread(coordinator, "Saved", { conversation: { id: "kept", saved: true } });
  await f.client.open({ id: saved.id });
  assert.deepEqual(f.io.rows.at(-1).argv.slice(-3), ["tool", "--resume", "kept"]);

  f.io.missing = "tool";
  const lost = await f.client.createThread({ coordinator: coordinator.id, title: "Lost" });
  assert.deepEqual([lost.state, /tool was not found/.test(lost.error)], ["stopped", true]);
  assert.equal(f.runs().length, 2);
});

test("a thread is started under a coordinator; titles may repeat, and one without a title has a placeholder", async t => {
  const f = fixture(t), coordinator = f.project(), first = f.thread(coordinator, "Parser");
  const second = await f.client.createThread({ coordinator: coordinator.id, title: "Parser" });
  assert.deepEqual([second.title, second.id === first.id], ["Parser", false]);
  const unnamed = await f.client.createThread({ coordinator: coordinator.id });
  assert.deepEqual([unnamed.title, f.record(unnamed.id).titleSource], ["New thread", "placeholder"]);
  assert.equal((await f.client.rename({ id: unnamed.id, title: "Parser" })).title, "Parser");
  await assert.rejects(f.client.createThread({ coordinator: coordinator.id, title: "user" }), /cannot be called user/);
  await assert.rejects(f.client.createThread({ coordinator: first.id }), /under a coordinator/);
});

test("closing a project closes its threads, and entering it again brings the open ones back", async t => {
  const f = fixture(t), project = f.project({ conversation: { id: "talk" } }), bystander = f.io.terminal({});
  const open = f.thread(project, "Open"), done = f.thread(project, "Done", { resolved: true }), idle = f.thread(project, "Idle");
  const terminals = [project, open, done].map(record => f.io.terminal(f.bound(record.id)));
  await f.client.close({ id: project.id });
  assert.deepEqual(terminals.map(row => row.state), ["finished", "finished", "finished"]);
  assert.equal(bystander.state, "live");

  await f.enter(f.io.terminal({}), "talk");
  assert.equal(f.runs().length, 1);
  assert.equal(f.io.rows.at(-1).labels["projects.session"], open.id);
  assert.deepEqual([await f.state(done.id), await f.state(idle.id)], ["stopped", "stopped"]);
});

test("opening a session starts it in its tab, then closes the empty shell hc put there, and no shell the user is in", async t => {
  const f = fixture(t), worker = f.thread(f.project(), "Worker");
  const empty = f.io.terminal(f.waiting(worker.id), null), busy = f.io.terminal(f.left(worker.id), null);
  const restored = f.io.terminal({ ...f.started(worker.id), "projects.bound": "1" }, null), own = f.io.terminal(f.waiting(worker.id), null);
  for (const row of [empty, busy, restored]) row.pid = ME + 1;
  for (const row of [empty, restored, own]) row.foreground = { pid: row.pid };
  busy.foreground = { pid: 4242 };
  assert.equal(await f.state(worker.id), "stopped");

  await f.client.open({ id: worker.id });
  const order = f.io.calls.map(args => `${args[0]} ${args[1]}`);
  assert.ok(order.indexOf("run --bg") < order.indexOf(`kill ${empty.address}`));
  assert.deepEqual([empty.state, restored.state, busy.state, busy.labels, own.state, own.labels], ["finished", "finished", "live", {}, "live", {}]);
  assert.equal(f.io.rows.at(-1).labels["projects.launched"], "1");
});

test("the list says which sessions are interrupted: stopped, their tab back as an empty shell", async t => {
  const f = fixture(t), restored = f.save({ title: "Restored", rank: 3 }), closed = f.save({ title: "Closed", rank: 2 }), running = f.save({ title: "Running", rank: 1 });
  const shell = f.io.terminal(f.left(restored.id), null);
  shell.pid = ME + 1;
  shell.foreground = { pid: shell.pid };
  f.io.terminal(f.waiting(closed.id), null);
  f.io.terminal(f.bound(running.id));

  assert.deepEqual((await f.client.list()).sessions.map(view => [view.title, view.interrupted, view.terminal]),
    [["Restored", true, shell.address], ["Closed", false, undefined], ["Running", false, "t3"]]);
});

test("the list has each project with its threads under it, unresolved first, then plain sessions, highest rank first", async t => {
  const f = fixture(t), low = f.project({ title: "Low", rank: 1 }), high = f.project({ title: "High", rank: 2 });
  f.save({ title: "Plain 1", rank: 5 });
  f.save({ title: "Plain 9", rank: 9 });
  f.thread(low, "Low a", { rank: 1 });
  f.thread(high, "High resolved", { rank: 9, resolved: true });
  f.thread(high, "High a", { rank: 1 });
  f.thread(high, "High b", { rank: 2 });
  f.thread({ id: randomUUID() }, "Orphan");
  assert.deepEqual((await f.client.list()).sessions.map(view => view.title),
    ["High", "High b", "High a", "High resolved", "Low", "Low a", "Orphan", "Plain 9", "Plain 1"]);
});

test("a session whose folder is gone opens only after its new folder is recorded", async t => {
  const f = fixture(t), moved = f.save({ folder: join(f.folder, "old") }), target = join(f.folder, "new");
  assert.match((await f.client.open({ id: moved.id })).error, /folder .*old is gone/);
  assert.equal(f.runs().length, 0);

  await assert.rejects(f.client.move({ id: moved.id, folder: target }), /not a folder/);
  await assert.rejects(f.client.move({ id: moved.id, folder: "new" }), /absolute/);
  mkdirSync(target);
  assert.equal((await f.client.move({ id: moved.id, folder: target })).folder, target);
  assert.deepEqual([(await f.client.open({ id: moved.id })).state, f.io.rows.at(-1).folder], ["starting", target]);
  await assert.rejects(f.client.move({ id: moved.id, folder: f.folder }), /Close the session/);
});

test("a terminal holds a session only while its agent is alive", async t => {
  const f = fixture(t), project = f.project();
  f.io.terminal(f.bound(project.id, DEAD));
  assert.equal(await f.state(project.id), "stopped");
});

test("resolving closes a session of any kind; an agent waits for a thread that is still working", async t => {
  const f = fixture(t), project = f.project(), worker = f.thread(project, "Worker"), plain = f.save();
  const terminal = f.io.terminal(f.bound(worker.id), "working");
  await assert.rejects(f.as(project.id, "thread_resolve", { thread: worker.id }), /still working/);
  terminal.status.state = "idle";
  assert.deepEqual((({ resolved, state }) => [resolved, state])(await f.as(project.id, "thread_resolve", { thread: worker.id })), [true, "stopped"]);
  assert.equal((await f.client.unresolve({ id: worker.id })).resolved, false);
  assert.equal((await f.client.resolve({ id: project.id })).resolved, true);
  assert.equal((await f.client.resolve({ id: plain.id })).resolved, true);
});

test("delete removes the sessions, their conversations, mail and project log, and nothing else", async t => {
  const f = fixture(t), project = f.project({ conversation: { id: "a" } }), other = f.project({ title: "Other", conversation: { id: "c" } });
  const worker = f.thread(project, "Worker", { conversation: { id: "b" } }), unstarted = f.thread(project, "Unstarted");
  const running = f.io.terminal(f.bound(worker.id));
  const { id } = (await f.extension.typed({ id: project.id, text: "remember this" }));
  await f.client.send({ to: unstarted.id, text: "waiting" });
  await f.client.send({ to: other.id, text: "stays" });

  const { deleted } = await f.client.delete({ id: project.id });
  assert.deepEqual(deleted.sort(), [project.id, worker.id, unstarted.id].sort());
  assert.deepEqual([running.state, f.removed.sort(), f.record(project.id)], ["finished", ["a", "b"], undefined]);
  assert.throws(() => f.extension.mail({ id: unstarted.id }), /No session/);
  await assert.rejects(f.as(other.id, "message_read", { id }), /No message/);
  assert.deepEqual([Boolean(f.record(other.id)), f.extension.mail({ id: other.id }).items.length], [true, 1]);
});

test("deleting a plain session nothing was said in, which its own agent removes as it leaves, is no error", async t => {
  const f = fixture(t), terminal = f.io.terminal({}), { session } = await f.enter(terminal, "never-saved"), command = f.io.command;
  f.io.command = async (program, args) => {
    const result = await command(program, args);
    if (args[0] === "kill") await f.extension.leave({ terminal: terminal.address, pid: ME });
    return result;
  };
  assert.deepEqual(await f.client.delete({ id: session.id }), { deleted: [session.id] });
  assert.equal(f.record(session.id), undefined);
});

test("without hc, the list still answers and says why the states are unknown", async t => {
  const f = fixture(t), project = f.project();
  f.io.down = true;
  const { sessions } = await f.client.list();
  assert.deepEqual([sessions[0].id, sessions[0].state], [project.id, "stopped"]);
  assert.match(sessions[0].error, /no server/);
});

test("a lock whose owner died is taken over", async t => {
  const f = fixture(t), project = f.project();
  mkdirSync(join(f.stateDir, "locks"));
  writeFileSync(join(f.stateDir, "locks", project.id), String(DEAD));
  assert.equal((await f.client.order({ id: project.id, rank: 5 })).rank, 5);
});
