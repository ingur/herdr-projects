import assert from "node:assert/strict";
import fs, { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { capturePiCommand, checkedSessionFile, piLaunchCommand, piRemoveConversation, writeLaunchShims } from "../pi/pi-launch.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-projects-shims-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function executable(path, content = "#!/bin/sh\nexit 0\n") { writeFileSync(path, content); chmodSync(path, 0o700); }

test("matching Nix PATH wrapper follows profile upgrades; unrelated Pi falls back to exact invocation", t => {
  const root = fixture(t), bin = join(root, "profile"), store = join(root, "store");
  mkdirSync(bin); mkdirSync(store);
  const node = join(store, "node"), cli = join(store, "cli.js"), wrapper = join(store, "pi");
  executable(node); writeFileSync(cli, "// selected Pi entry\n");
  executable(wrapper, `#!/bin/sh\nexport PATH="$PATH"\nexec "${node}"  ${cli} "$@"\n`);
  symlinkSync(wrapper, join(bin, "pi"));
  const options = { execPath: node, execArgv: [], argv: [node, cli, "-e", "./package", "--session-id", randomUUID()], env: { PATH: bin }, cwd: root };
  assert.deepEqual(capturePiCommand(options), ["pi", "-e", join(root, "package")]);
  executable(wrapper, "#!/bin/sh\nexec /another/pi \"$@\"\n");
  assert.deepEqual(capturePiCommand(options), [node, cli, "-e", join(root, "package")]);
  assert.deepEqual(capturePiCommand({ ...options, env: { PATH: bin, PI_PROJECTS_PI_COMMAND: '["/custom/pi", "--offline"]' } }), ["/custom/pi", "--offline", "-e", join(root, "package")]);
  assert.throws(() => capturePiCommand({ ...options, env: { PI_PROJECTS_PI_COMMAND: '["relative"]' } }), /absolute executable/);
});

test("shims use stable paths and atomic executable replacement with captured environment", t => {
  const root = fixture(t), state = join(root, "state with 'quotes'"), bin = join(root, "profile"); mkdirSync(bin);
  executable(join(bin, "node"));
  const env = { PATH: bin, PI_CODING_AGENT_DIR: join(root, "Pi home") }, command = ["pi", "-e", join(root, "package")];
  const shims = writeLaunchShims(state, { env, command });
  const before = readFileSync(shims.pi, "utf8"), control = readFileSync(shims.control, "utf8");
  assert.match(before, /exec 'pi' '-e'/); assert.match(before, /export PI_CODING_AGENT_DIR=/);
  assert.match(before, /export PI_PROJECTS_STATE_DIR=/); assert.match(control, /exec 'node'/);
  const rename = fs.renameSync; let replacements = 0;
  const mocked = t.mock.method(fs, "renameSync", (source, target) => {
    assert.equal(statSync(source).mode & 0o777, 0o700);
    assert.equal(readFileSync(source, "utf8"), target === shims.pi ? before : control);
    assert.equal(readFileSync(target, "utf8"), target === shims.pi ? before : control);
    replacements++; return rename(source, target);
  });
  syncBuiltinESMExports();
  try { assert.deepEqual(writeLaunchShims(state, { env, command }), shims); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(replacements, 2);
  assert.deepEqual(readdirSync(join(state, "bin")).sort(), ["control", "pi"]);
});

test("normal transcript launch and deletion require observed containment and matching header", t => {
  const root = fixture(t), sessionDir = join(root, "normal-pi-sessions"), state = join(root, "project-state");
  mkdirSync(sessionDir);
  const record = { id: randomUUID(), cwd: root, title: "My thread", sessionDir, sessionFile: join(sessionDir, "session.jsonl"), transcriptState: "expected" };
  const content = JSON.stringify({ type: "session", id: record.id, cwd: root }) + "\n";
  writeFileSync(record.sessionFile, content);
  assert.deepEqual(piLaunchCommand(record, state), [join(state, "bin", "pi"), "--session", record.sessionFile]);
  const outside = join(root, "outside.jsonl"); writeFileSync(outside, content);
  assert.throws(() => piRemoveConversation({ ...record, sessionFile: outside }), /inside its observed session directory/);
  const link = join(sessionDir, "link.jsonl"); symlinkSync(outside, link);
  assert.throws(() => piRemoveConversation({ ...record, sessionFile: link }), /inside/);
  writeFileSync(record.sessionFile, JSON.stringify({ type: "session", id: randomUUID(), cwd: root }) + "\n");
  assert.throws(() => piRemoveConversation(record), /identity\/cwd/);
  assert.ok(existsSync(record.sessionFile)); assert.equal(readFileSync(outside, "utf8"), content);
  writeFileSync(record.sessionFile, content); piRemoveConversation(record);
  assert.equal(existsSync(record.sessionFile), false);
  assert.throws(() => checkedSessionFile(record), /transcript is missing/);
  assert.deepEqual(piLaunchCommand({ ...record, transcriptState: "unwritten" }, state), [join(state, "bin", "pi"), "--session-id", record.id, "--name", record.title]);
});

test("core list runs without any Pi adapter files", t => {
  const root = fixture(t);
  cpSync(fileURLToPath(new URL("../core", import.meta.url)), join(root, "core"), { recursive: true });
  const output = execFileSync(process.execPath, [join(root, "core", "control.mjs"), "list", JSON.stringify({ stateDir: join(root, "state") })], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), { sessions: [] });
});
