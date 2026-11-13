import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { actions, readRecord, wrap } from "../core/control.mjs";
import { writeRecord } from "../core/store.mjs";
import { remove } from "../pi/adapter.mjs";

const control = fileURLToPath(new URL("../core/control.mjs", import.meta.url));

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-projects-")));
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
  return { root, stateDir, cwd, agentDir, adapter, save, transcript, options: { stateDir } };
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
      const row = { address: `t${rows.length + 1}`, state: "live", labels, status: status ? { app: "pi", state: status } : null, created_ms: Date.now() - age, typed: [] };
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

test("a bin link to control.mjs runs the command line", t => {
  const f = fixture(t), link = join(f.root, "pi-projects");
  symlinkSync(control, link);
  assert.deepEqual(JSON.parse(execFileSync(link, ["list", JSON.stringify({ stateDir: f.stateDir })], { encoding: "utf8" })), { sessions: [] });
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
  const running = io.terminal({ "projects.session": thread.id });
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
  const row = io.terminal({ "projects.session": thread.id });
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

test("a shell left behind the label is never typed into", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save(), thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker" });
  const coordinatorShell = io.terminal({ "projects.session": coordinator.id }, null, 120_000);
  const threadShell = io.terminal({ "projects.session": thread.id }, null, 120_000);
  const stored = await actions.send({ ...f.options, to: coordinator.id, from: thread.id, text: "result" }, io);
  assert.equal(stored.sent, false);
  assert.equal(stored.waiting, 1);
  io.onRun = row => { row.status = { app: "pi", state: "idle" }; };
  const sent = await actions.send({ ...f.options, to: thread.id, from: coordinator.id, text: "work" }, io);
  assert.equal(sent.sent, true);
  assert.deepEqual(coordinatorShell.typed, []);
  assert.deepEqual(threadShell.typed, []);
  assert.equal(threadShell.labels["projects.session"], undefined, "launching cleared the stale label");
  const launched = io.rows.at(-1);
  assert.deepEqual(launched.typed, [wrap({ from: "coordinator", title: coordinator.title, id: coordinator.id, text: "work" })]);
  assert.equal(launched.labels["projects.session"], thread.id);

  launched.status = { app: "pi", state: "blocked" };
  const blocked = await actions.send({ ...f.options, to: thread.id, text: "more" }, io);
  assert.equal(blocked.sent, false);
  assert.equal(blocked.waiting, 0);
  assert.equal(launched.typed.length, 1);
});

test("double launch is refused", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save({ adapter: { ...f.adapter, sessionId: randomUUID() } });
  const first = io.terminal({}), second = io.terminal({});
  const register = terminal => actions.register({ ...f.options, id: coordinator.id, cwd: f.cwd, agent: "pi", adapter: coordinator.adapter, terminal }, io);
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
  const register = () => actions.register({ ...f.options, id: coordinator.id, cwd: f.cwd, agent: "pi", adapter: coordinator.adapter, terminal: terminal.address }, io);
  const first = await register();
  assert.equal(first.waiting, 1);
  assert.match(first.error, /lost/);
  io.onSend = () => new Promise(resolve => setImmediate(resolve));
  await Promise.all([register(), register()]);
  const message = text => wrap({ from: "thread", title: "Worker", id: thread.id, text });
  assert.deepEqual(terminal.typed, [message("one"), message("two"), message("three")]);
  assert.deepEqual(readRecord(f.stateDir, coordinator.id).waiting, []);
});

test("only its coordinator or the user reopens a resolved thread by sending", async t => {
  const f = fixture(t), io = hc(), coordinator = f.save();
  const thread = f.save({ role: "thread", coordinator: coordinator.id, title: "Worker", resolved: true });
  const peer = f.save({ role: "thread", coordinator: coordinator.id, title: "Peer" });
  const row = io.terminal({ "projects.session": thread.id });
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
