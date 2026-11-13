import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedWorkingFolder, displayFolder, matchProject, projectCandidates, projectConversation } from "../pi/open.mjs";

const project = (id, extra = {}) => ({ id, agent: "pi", role: "coordinator", writer: "dead", title: id, cwd: "/one", ...extra });

test("open candidates span folders, exclude current/live/uncertain writers and threads, and sort recent before resolved", () => {
  const rows = [project("resolved", { resolved: true, registered: "2026-12-01" }),
    project("older", { registered: "2026-01-01" }), project("recent", { cwd: "/other", registered: "2025-01-01", observed: "2026-02-01" }),
    project("current"), project("live", { writer: "live" }), project("uncertain", { writer: "unknown" }),
    project("thread", { role: "thread" }), project("foreign", { agent: "other" }),
    project("b", { created: "2026-01-01" }), project("a", { created: "2026-01-01" })];
  assert.deepEqual(projectCandidates(rows, "current").map(row => row.id), ["recent", "a", "b", "older", "resolved"]);
  assert.equal(rows[0].id, "resolved", "sorting must not mutate the catalog");
});

test("a unique case-insensitive title wins before substring matching; ambiguous or empty names need the picker", () => {
  const rows = [project("one", { title: "Alpha" }), project("two", { title: "Alpha notes" }), project("three", { title: "Beta notes" })];
  assert.equal(matchProject(rows, " ALPHA "), rows[0]);
  assert.equal(matchProject(rows, "beta"), rows[2]);
  assert.equal(matchProject(rows, "notes"), undefined);
  assert.equal(matchProject(rows, ""), undefined);
  assert.equal(matchProject(rows, "missing"), undefined);
  assert.equal(matchProject([...rows, project("four", { title: "alpha" })], "alpha"), undefined);
});

test("folder display shortens only the home boundary and announces a different working folder without rejecting it", () => {
  assert.equal(displayFolder("/home/me", "/home/me"), "~");
  assert.equal(displayFolder("/home/me/project", "/home/me"), "~/project");
  assert.equal(displayFolder("/home/mean/project", "/home/me"), "/home/mean/project");
  assert.equal(changedWorkingFolder("/one", "/one"), undefined);
  assert.equal(changedWorkingFolder("/other", "/one"), "/other");
});

test("opening uses the retained conversation identity and never invents an unwritten or lost transcript", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-open-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "other-project"), sessionDir = join(root, "sessions");
  mkdirSync(cwd); mkdirSync(sessionDir);
  const record = { id: randomUUID(), cwd, sessionDir, sessionFile: join(sessionDir, "session.jsonl"), transcriptState: "unwritten" };
  assert.throws(() => projectConversation(record), error => error.code === "ENOSESSIONFILE");
  assert.equal(existsSync(record.sessionFile), false);
  writeFileSync(record.sessionFile, JSON.stringify({ type: "session", id: record.id, cwd }) + "\n");
  assert.equal(projectConversation(record), record.sessionFile);
  assert.throws(() => projectConversation({ ...record, id: randomUUID() }), /identity/);
  rmSync(record.sessionFile);
  assert.throws(() => projectConversation({ ...record, transcriptState: "expected" }), /missing/);
});
