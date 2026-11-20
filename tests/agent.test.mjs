import assert from "node:assert/strict";
import test from "node:test";
import { instructions, tools } from "../core/agent.mjs";
import { fixture } from "./fixture.mjs";

const names = kind => tools.filter(tool => tool.kinds.includes(kind)).map(tool => tool.name);

test("a session has the tools of its kind", () => {
  assert.deepEqual(names("plain"), ["message_send", "title_set"]);
  assert.deepEqual(names("thread"), ["message_send", "title_set", "thread_list"]);
  assert.deepEqual(names("coordinator"), ["message_send", "title_set", "thread_list", "thread_start", "thread_resolve", "message_read"]);
});

test("core refuses a tool that is not of the session's kind, whoever asks", async t => {
  const f = fixture(t), plain = f.save(), worker = f.thread(f.project(), "Worker");
  await assert.rejects(f.as(plain.id, "thread_list", {}), /not a tool of a plain session/);
  await assert.rejects(f.as(worker.id, "thread_resolve", { thread: worker.id }), /not a tool of a thread session/);
  await assert.rejects(f.as(worker.id, "delete", {}), /No tool/);
  await assert.rejects(f.as(undefined, "message_send", { to: "user", text: "hi" }), /named by its id/);
});

test("an agent sets its own title, a coordinator also a thread's by its id, and never one the user chose", async t => {
  const f = fixture(t), coordinator = f.project(), worker = f.thread(coordinator, "Worker", { titleSource: "placeholder" }), peer = f.thread(coordinator, "Peer", { titleSource: "agent" });
  assert.deepEqual([(await f.as(worker.id, "title_set", { title: "Parser" })).title, f.record(worker.id).titleSource], ["Parser", "agent"]);
  await assert.rejects(f.as(worker.id, "title_set", { title: "Mine", thread: peer.id }), /Only a coordinator/);
  assert.deepEqual((({ id, title }) => [id, title])(await f.as(coordinator.id, "title_set", { title: "Parser", thread: peer.id })), [peer.id, "Parser"]);
  await assert.rejects(f.as(coordinator.id, "title_set", { title: "Lexer", thread: "Parser" }), /No session/);
  await assert.rejects(f.as(coordinator.id, "title_set", { title: "Theirs" }), /user chose/);
});

test("thread_list shows the sessions of the asker's project and no other", async t => {
  const f = fixture(t), coordinator = f.project(), worker = f.thread(coordinator, "Worker"), peer = f.thread(coordinator, "Peer");
  f.thread(f.project({ title: "Other" }), "Stranger");
  f.save();
  const listed = await f.as(worker.id, "thread_list", {});
  assert.equal(listed.you, worker.id);
  assert.deepEqual(listed.sessions.map(view => view.id).sort(), [coordinator.id, worker.id, peer.id].sort());
  assert.deepEqual(Object.keys(listed.sessions[0]), ["id", "kind", "title", "state", "resolved", "waiting"]);
});

test("the instructions follow the session's kind, and ask for a title only while it has none", () => {
  const told = (kind, titleSource = "user") => instructions({ kind, titleSource });
  for (const kind of ["plain", "coordinator", "thread"]) {
    assert.match(told(kind), /message_send to "user"/);
    assert.match(told(kind), /Only three things are the user's words/);
    assert.match(told(kind, "placeholder"), /title_set once/);
    assert.doesNotMatch(told(kind), /title_set/);
  }
  assert.doesNotMatch(told("plain"), /thread|coordinator|attach`/);
  assert.match(told("coordinator"), /thread_start/);
  assert.match(told("thread"), /message_send to "coordinator"/);
});
