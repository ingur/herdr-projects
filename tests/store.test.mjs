import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.mjs";
import { acquireLock, atomicJSON } from "../core/lib/state.mjs";
import { mayDeliver } from "../core/lib/delivery.mjs";
import { ownerState, processIdentity } from "../core/lib/process.mjs";
import { MESSAGE_TYPE, deliveryState } from "../core/messages.mjs";
import { forwardEntry, receiptEntries } from "../pi/messages.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "projects-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const store = new Store(state, root);
  const id = randomUUID();
  store.save({ id, projectRoot: root, title: "worker", titleSource: "agent", role: "thread", coordinator: randomUUID(), registration: "awaiting-extension" });
  const message = { version: 1, id: randomUUID(), projectRoot: root, recipient: id, created: "2026-11-12T00:00:00.000Z",
    text: "exact text\n", author: { kind: "human", session: randomUUID(), title: "coordinator" }, source: { session: randomUUID(), entry: "abc" }, via: [], sender: { kind: "human", session: randomUUID(), title: "coordinator" } };
  return { root, state, store, id, message };
}

test("registry contention waits for the prior commit before merging another update", t => {
  const { store, id } = fixture(t);
  const held = acquireLock(join(store.directory, "locks", "registry"));
  t.mock.method(Atomics, "wait", () => {
    store.save({ ...store.record(id), title: "concurrent rename" });
    held.release();
    return "ok";
  });
  try {
    store.patch(id, { registration: "registered" });
    assert.equal(store.record(id).title, "concurrent rename");
    assert.equal(store.record(id).registration, "registered");
  } finally { held.release(); }
});

test("durable publication is idempotent, distinct from delivery and isolated by recipient", t => {
  const { root, state, store, id, message } = fixture(t);
  store.publish(message);
  store.publish(message);
  const reopened = new Store(state, root);
  assert.deepEqual(reopened.messages(id), [message]);
  assert.equal(reopened.delivery(id, message.id), undefined);
  assert.throws(() => store.publish({ ...message, text: "replacement" }), /collision/);
  assert.throws(() => store.publish({ ...message, recipient: randomUUID() }), /recipient/);
  assert.throws(() => store.publish({ ...message, projectRoot: "/elsewhere" }), /recipient/);
  assert.equal(readdirSync(store.inbox(id)).filter(name => name.endsWith(".tmp")).length, 0);
});

test("initial instruction requires actual live registration, and reload cannot duplicate it", t => {
  const { store, id, message } = fixture(t);
  store.patch(id, { initial: message });
  assert.throws(() => store.publishInitial(id), /registration/);
  assert.deepEqual(store.messages(id), []);
  store.patch(id, { registration: "registered", owner: { ...processIdentity(), token: randomUUID() } });
  store.publishInitial(id);
  store.publishInitial(id);
  assert.deepEqual(store.messages(id), [message]);
  store.patch(id, { initial: { ...message, recipient: randomUUID() } });
  assert.throws(() => store.publishInitial(id), /recipient/);
});

test("wrong mailbox identity is rejected rather than delivered to the current writer", t => {
  const { store, id, message } = fixture(t);
  atomicJSON(store.inbox(id), `${message.id}.json`, { ...message, recipient: randomUUID() });
  assert.throws(() => store.messages(id), /identity/);
  const record = store.record(id);
  atomicJSON(join(store.directory, "records"), `${id}.json`, { ...record, id: randomUUID() });
  assert.throws(() => store.record(id), /identity/);
});

test("uncertain attempts never auto-replay and explicit retry remains pending until attempted", () => {
  assert.equal(deliveryState(undefined).state, "pending");
  assert.equal(deliveryState({ state: "attempting" }).state, "uncertain");
  assert.equal(deliveryState({ state: "recorded", entry: "lost-on-disk" }).state, "uncertain");
  const allowed = deliveryState({ state: "retry-authorized" });
  assert.equal(allowed.state, "pending");
  assert.equal(allowed.execution, "unknown");
  assert.equal(deliveryState(allowed).state, "pending");
  assert.equal(deliveryState({ state: "retry-authorized" }, "visible").state, "visible-not-durable");
  assert.equal(deliveryState({ state: "attempting" }, "visible", "disk").state, "recorded");
});

test("visible memory is not durable evidence and receipt identity includes recipient", () => {
  const id = randomUUID(), message = randomUUID();
  const entries = [
    { type: "custom_message", id: "visible", customType: MESSAGE_TYPE, details: { envelope: { id: message, recipient: id } } },
    { type: "custom_message", id: "wrong", customType: MESSAGE_TYPE, details: { envelope: { id: message, recipient: randomUUID() } } },
    { type: "custom_message", id: "wake", customType: "projects.wake", details: { envelope: { id: message, recipient: id } } },
  ];
  const visible = receiptEntries(entries, id);
  assert.deepEqual([...visible], [[message, "visible"]]);
  assert.equal(deliveryState(undefined, visible.get(message)).state, "visible-not-durable");
  assert.equal(deliveryState({ state: "visible-not-durable" }).state, "uncertain");
});

test("every human-first gate blocks wake; only a quiet idle boundary allows it", () => {
  const safe = { modelSelected: true, idle: true, focused: true, pending: false, draft: "", lastInteraction: 0, paused: false, promptOpen: 0, inFlight: false, now: 2000 };
  assert.equal(mayDeliver(safe), true);
  for (const change of [{ modelSelected: false }, { idle: false }, { focused: false }, { pending: true }, { draft: " " }, { paused: true }, { promptOpen: 1 }, { inFlight: true }, { lastInteraction: 1000 }]) {
    assert.equal(mayDeliver({ ...safe, ...change }), false, JSON.stringify(change));
  }
});

test("abort suppression and attempted delivery survive reload", t => {
  const { root, state, store, id, message } = fixture(t);
  store.publish(message);
  store.control(id, { paused: true, reason: "human abort" });
  store.mark(id, message.id, { state: "attempting" });
  const reopened = new Store(state, root);
  assert.equal(reopened.control(id).paused, true);
  assert.equal(deliveryState(reopened.delivery(id, message.id)).state, "uncertain");
  reopened.control(id, { paused: false, reason: "human submitted" });
  assert.equal(store.control(id).paused, false);
});

test("forwarding preserves exact human bytes and author through multiple hops", () => {
  const sourceSession = randomUUID();
  const original = "  Do NOT edit.\r\nKeep café / 雪 exactly.\n\n";
  const first = forwardEntry({ id: "human-entry", type: "message", message: { role: "user", content: original } }, sourceSession, "A");
  const sender = { kind: "agent", session: randomUUID(), title: "A" };
  const inbound = { id: "received-A", type: "custom_message", customType: MESSAGE_TYPE, details: { envelope: { ...first, id: randomUUID(), sender, note: "Separately authored" } } };
  const second = forwardEntry(inbound, sender.session, "Coordinator");
  const third = forwardEntry({ ...inbound, id: "received-B", details: { envelope: { ...second, sender, note: "Another separate note" } } }, randomUUID(), "B");
  assert.equal(third.text, original);
  assert.deepEqual(third.author, first.author);
  assert.deepEqual(third.source, { session: sourceSession, entry: "human-entry" });
  assert.equal(third.via[0].note, "Separately authored");
  assert.equal(third.via[1].note, "Another separate note");
});

test("forwarding refuses nonexistent/assistant/image entries rather than fabricating text", () => {
  assert.throws(() => forwardEntry(undefined, randomUUID(), "A"), /does not exist/);
  assert.throws(() => forwardEntry({ id: "a", type: "message", message: { role: "assistant", content: "not a user" } }, randomUUID(), "A"), /Only existing/);
  assert.throws(() => forwardEntry({ id: "a", type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", data: "x" }] } }, randomUUID(), "A"), /attachments/);
  const value = forwardEntry({ id: "a", type: "message", message: { role: "user", content: [{ type: "text", text: " a" }, { type: "text", text: "\nb " }] } }, randomUUID(), "A");
  assert.equal(value.text, " a\nb ");
});


test("PID reuse is stale; malformed/incomplete ownership fails closed", t => {
  const { root } = fixture(t);
  const directory = join(root, "lock"); mkdirSync(directory);
  assert.throws(() => acquireLock(directory), /unknown/);
  const token = randomUUID();
  const reused = { ...processIdentity(), start: "different-process-start", token };
  assert.equal(ownerState(reused), "dead");
  assert.equal(ownerState({ ...processIdentity(), pid: 2147483647 }), "dead");
  writeFileSync(join(directory, `${token}.json`), JSON.stringify(reused));
  const lock = acquireLock(directory);
  assert.equal(ownerState(lock.owner), "live");
  assert.throws(() => acquireLock(directory), /owner/);
  lock.release(); lock.release();
  assert.equal(ownerState({ pid: process.pid }), "unknown");
});

test("stale-lock reclamation refuses a racing replacement without removing its owner", t => {
  const { root } = fixture(t), directory = join(root, "racing-lock");
  const old = randomUUID(), next = randomUUID(), nextFile = join(directory, `${next}.json`);
  const replacement = JSON.stringify({ ...processIdentity(), token: next });
  atomicJSON(directory, `${old}.json`, { ...processIdentity(), start: "dead-generation", token: old });
  const rmdir = fs.rmdirSync;
  const mock = t.mock.method(fs, "rmdirSync", (path, ...args) => {
    if (path === directory) writeFileSync(nextFile, replacement);
    return rmdir(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => acquireLock(directory), error => error.code === "ELOCKED" && error.cause?.code === "ENOTEMPTY");
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(nextFile, "utf8"), replacement);
});

test("name claims retain uncertain instructions within a coordinator, not across groups", t => {
  const { root, state, store, message } = fixture(t);
  const id = randomUUID();
  const proposed = { id, projectRoot: root, title: "new-worker", titleSource: "agent", role: "thread", coordinator: randomUUID(), initial: { ...message, recipient: id }, launchState: "claimed" };
  assert.equal(store.claimThread(proposed).created, true);
  store.patch(id, { launchState: "unknown", launchError: "hc response timed out" });
  const reopened = new Store(state, root);
  const repeated = reopened.claimThread({ ...proposed, id: randomUUID(), initial: { ...message, text: "A new instruction" } });
  assert.equal(repeated.created, false);
  assert.equal(repeated.record.id, id);
  assert.equal(repeated.record.launchState, "unknown");
  assert.equal(repeated.record.initial.text, message.text);
  assert.equal(reopened.records().filter(record => record.title === "new-worker").length, 1);
  const separate = store.claimThread({ ...proposed, id: randomUUID(), coordinator: randomUUID(), initial: undefined });
  assert.equal(separate.created, true);
  assert.notEqual(separate.record.id, id);
  const coordinator = randomUUID();
  store.save({ id: coordinator, projectRoot: root, role: "coordinator", coordinator, title: "shared-name", titleSource: "agent" });
  assert.equal(store.claimThread({ ...proposed, id: randomUUID(), coordinator, title: "shared-name", initial: undefined }).created, true);
});

test("external envelopes without a session remain forwardable without inventing original provenance", () => {
  const sender = { kind: "human", title: "External operator" };
  const message = { text: "Exact external text", sender, author: sender, via: [] };
  const session = randomUUID();
  const forwarded = forwardEntry({ id: "external-entry", type: "custom_message", customType: MESSAGE_TYPE,
    details: { envelope: message } }, session, "Receiving thread");
  assert.equal(forwarded.text, message.text);
  assert.deepEqual(forwarded.author, sender);
  assert.equal(forwarded.source, undefined);
  assert.deepEqual(forwarded.via, [{ session, entry: "external-entry", sender, note: undefined }]);
});

