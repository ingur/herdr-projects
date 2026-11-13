import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processIdentity } from "../core/lib/process.mjs";
import { atomicJSON } from "../core/lib/state.mjs";
import { acquireSessionLocks, findSessionRecord, isWriterConflict, messageNeedsTurn, observeTranscript, registerCurrentSession, sessionSwitchDecision, unregisterCurrentSession } from "../pi/registration.mjs";
import { checkedSessionFile, piLaunchCommand } from "../pi/pi-launch.mjs";
import { Store, stateDirectory } from "../core/store.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-registration-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project"), stateDir = join(root, "state"), sessionDir = join(root, "normal-pi-sessions");
  mkdirSync(projectRoot); mkdirSync(sessionDir);
  const id = randomUUID(), sessionFile = join(sessionDir, "existing.jsonl");
  const transcript = JSON.stringify({ type: "session", version: 3, id, cwd: projectRoot }) + "\n" +
    JSON.stringify({ type: "message", id: "human", message: { role: "user", content: "Already discussing the project" } }) + "\n";
  writeFileSync(sessionFile, transcript);
  const store = new Store(stateDir, projectRoot);
  const binding = { id, agent: "pi", cwd: projectRoot, title: "Existing conversation", sessionFile, sessionDir,
    terminal: "t1", owner: { ...processIdentity(), token: randomUUID() } };
  return { root, store, binding, stateDir, projectRoot, transcript };
}

test("unregistered sessions remain dormant without creating state or blocking switches", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-dormant-"))), state = join(root, "missing");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(findSessionRecord(state, randomUUID()), undefined);
  assert.equal(existsSync(state), false);
  assert.equal(sessionSwitchDecision(false), undefined);
  assert.deepEqual(sessionSwitchDecision(true), { cancel: true });
  assert.equal(stateDirectory(join(root, "selected")), join(root, "selected"));
  assert.throws(() => stateDirectory("relative"), /absolute/);
});

test("promotion and lookup by session UUID retain conversation, root, role and optional placement", t => {
  const f = fixture(t), locks = acquireSessionLocks(f.stateDir, f.store, f.binding.id);
  let promoted;
  try { promoted = registerCurrentSession(f.store, { ...f.binding, owner: locks[0].owner, promote: true, title: "My project" }); }
  finally { for (const lock of locks.reverse()) lock.release(); }
  for (const key of ["id", "sessionFile", "sessionDir", "terminal", "cwd"]) assert.equal(promoted[key], f.binding[key]);
  assert.equal(promoted.version, 1); assert.equal(promoted.space, undefined); assert.equal(promoted.tab, undefined);
  assert.equal(promoted.role, "coordinator"); assert.equal(promoted.coordinator, f.binding.id);
  assert.equal(findSessionRecord(f.stateDir, f.binding.id).projectRoot, f.projectRoot);
  assert.equal(registerCurrentSession(f.store, { ...f.binding, promote: true, title: "Not a rename" }).title, "My project");
  const otherRoot = join(f.root, "unrelated-project"); mkdirSync(otherRoot); new Store(f.stateDir, otherRoot);
  assert.equal(findSessionRecord(f.stateDir, f.binding.id).id, f.binding.id);
  const id = randomUUID(), file = join(f.binding.sessionDir, "thread.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", id, cwd: f.projectRoot }) + "\n");
  f.store.save({ id, agent: "pi", projectRoot: f.projectRoot, cwd: f.projectRoot, role: "thread", coordinator: promoted.id,
    title: "Retained thread", titleSource: "agent", resolved: true, registration: "awaiting-extension" });
  const thread = registerCurrentSession(f.store, { ...f.binding, id, sessionFile: file });
  assert.equal(thread.role, "thread"); assert.equal(thread.coordinator, promoted.id); assert.equal(thread.resolved, true);
  assert.throws(() => registerCurrentSession(f.store, { ...f.binding, id, promote: true }), /already registered as a thread/);
  assert.deepEqual(piLaunchCommand(promoted, f.stateDir), [join(f.stateDir, "bin", "pi"), "--session", f.binding.sessionFile]);
  assert.equal(readFileSync(f.binding.sessionFile, "utf8"), f.transcript);
});

test("foreign live writer is refused before registration or transcript writes", async t => {
  const f = fixture(t);
  registerCurrentSession(f.store, { ...f.binding, promote: true });
  const recordFile = join(f.store.directory, "records", `${f.binding.id}.json`), saved = readFileSync(recordFile, "utf8");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  try {
    atomicJSON(join(f.stateDir, "writer-locks", f.binding.id), `${randomUUID()}.json`, { ...processIdentity(child.pid), token: randomUUID() });
    assert.throws(() => acquireSessionLocks(f.stateDir, f.store, f.binding.id), error => error.code === "ELOCKED" && isWriterConflict(error));
    assert.equal(isWriterConflict({ code: "ELOCKED" }), false, "unrelated registry contention must not claim another session writer");
    assert.equal(readFileSync(recordFile, "utf8"), saved);
    assert.equal(readFileSync(f.binding.sessionFile, "utf8"), f.transcript);
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited;
  }
});

test("unwritten sessions may rebind once, but observed transcript loss and different identities fail closed", t => {
  const f = fixture(t), never = join(f.binding.sessionDir, "never-written.jsonl");
  registerCurrentSession(f.store, { ...f.binding, promote: true, sessionFile: never });
  assert.equal(checkedSessionFile(f.store.record(f.binding.id)), undefined);
  assert.equal(observeTranscript(f.store, { id: f.binding.id, sessionFile: never }), false);
  const next = join(f.binding.sessionDir, "next.jsonl");
  registerCurrentSession(f.store, { ...f.binding, sessionFile: next });
  writeFileSync(next, f.transcript);
  observeTranscript(f.store, { id: f.binding.id, sessionFile: next });
  assert.throws(() => registerCurrentSession(f.store, f.binding), /differs/);
  rmSync(next);
  assert.equal(unregisterCurrentSession(f.store, { id: f.binding.id, sessionFile: next }).transcriptState, "expected");
  assert.throws(() => checkedSessionFile(f.store.record(f.binding.id)), /expected conversation transcript is missing/);
  f.store.patch(f.binding.id, { agent: "another-agent" });
  assert.throws(() => registerCurrentSession(f.store, { ...f.binding, sessionFile: next }), /another agent runtime/);
});

test("records, controls and delivery attempts write schema version one", t => {
  const f = fixture(t), id = f.binding.id, message = randomUUID();
  registerCurrentSession(f.store, { ...f.binding, promote: true });
  f.store.control(id, { paused: true }); f.store.mark(id, message, { state: "attempting", execution: "unknown" });
  for (const path of [join(f.store.directory, "records", `${id}.json`), join(f.store.directory, "controls", `${id}.json`), join(f.store.directory, "deliveries", id, `${message}.json`)]) {
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);
  }
});

test("initial and queued project messages request turns without a human prompt; notices never wake", () => {
  assert.equal(messageNeedsTurn({ text: "Initial thread instruction" }), true);
  assert.equal(messageNeedsTurn({ text: "Queued before reopen or reload", informational: false }), true);
  assert.equal(messageNeedsTurn({ informational: true }), false);
});
