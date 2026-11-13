import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { canonicalPath, checkedStatePath, sessionId } from "../core/lib/state.mjs";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function pathExecutable(name, path) {
  for (const directory of (path ?? "").split(delimiter)) {
    // Relative PATH entries would change meaning in a thread's cwd.
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch {}
  }
}

function matchingPi(path, execPath, entry) {
  const pi = pathExecutable("pi", path);
  if (!pi) return false;
  try {
    const target = realpathSync(pi), program = realpathSync(entry ?? execPath);
    if (target === program) return true;
    // Recognize the installed Nix wrapper without executing it or interpreting arbitrary shell.
    const exec = readFileSync(target, "utf8").match(/^exec\s+"([^"]+)"\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+"\$@"\s*$/m);
    return !!exec && realpathSync(exec[1]) === realpathSync(execPath) && realpathSync(exec[2] ?? exec[3] ?? exec[4]) === program;
  } catch { return false; }
}

export function capturePiCommand({ execPath = process.execPath, execArgv = process.execArgv, argv = process.argv, env = process.env, cwd = process.cwd() } = {}) {
  const override = env.PI_PROJECTS_PI_COMMAND;
  const command = override !== undefined ? JSON.parse(override)
    : !execArgv.length && matchingPi((env.PATH ?? "").split(delimiter).map(path => resolve(cwd, path || ".")).join(delimiter), execPath, argv[1]) ? ["pi"]
    : [execPath, ...execArgv, ...(argv[1] && resolve(argv[1]) !== resolve(execPath) ? [resolve(argv[1])] : [])];
  if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== "string" || !arg || arg.includes("\0")) || override !== undefined && !isAbsolute(command[0])) {
    throw new Error("PI_PROJECTS_PI_COMMAND must be a JSON argv array starting with an absolute executable path");
  }
  // Keep explicit extensions for `pi -e /local/package` (including the isolated try-out).
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--") break;
    if (argv[i] === "-e" || argv[i] === "--extension") {
      const extension = argv[++i];
      if (!extension) throw new Error("Missing Pi extension path");
      command.push("-e", /^(npm:|git:|https?:|git@)/.test(extension) ? extension : resolve(cwd, extension));
    }
  }
  return command;
}

function atomicExecutable(directory, name, source) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o700);
    try { writeFileSync(fd, source); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, join(directory, name));
    const dir = openSync(directory, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { rmSync(temporary, { force: true }); }
}

export function writeLaunchShims(stateDir, { env = process.env, execPath = process.execPath, command = capturePiCommand({ env, execPath }) } = {}) {
  const directory = join(stateDir, "bin");
  const variables = { PATH: (env.PATH ?? "").split(delimiter).map(path => resolve(path || ".")).join(delimiter), PI_PROJECTS_STATE_DIR: stateDir };
  for (const name of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
    if (env[name] !== undefined) variables[name] = env[name];
  }
  const prefix = "#!/bin/sh\n" + Object.entries(variables).map(([key, value]) => `export ${key}=${quote(value)}\n`).join("");
  const script = args => `${prefix}exec ${args.map(quote).join(" ")} "$@"\n`;
  atomicExecutable(directory, "control", script([pathExecutable("node", variables.PATH) ? "node" : execPath, fileURLToPath(new URL("../core/control.mjs", import.meta.url))]));
  atomicExecutable(directory, "pi", script(command));
  return { control: join(directory, "control"), pi: join(directory, "pi") };
}

export function checkedSessionFile(record, { deleting = false } = {}) {
  sessionId(record.id);
  if (!record.sessionFile) {
    if (record.transcriptState === "expected" || record.registered) throw new Error("Registered session has no stored transcript path");
    return undefined;
  }
  if (!isAbsolute(record.sessionDir || "") || !isAbsolute(record.sessionFile)) throw new Error("Stored transcript requires its observed absolute session directory");
  const tail = relative(canonicalPath(record.sessionDir), canonicalPath(record.sessionFile));
  if (!tail || tail === ".." || tail.startsWith("../") || isAbsolute(tail)) throw new Error("Stored session file must be inside its observed session directory");
  // Also reject symlinked entries when removing a transcript, even if their target is contained.
  if (deleting) checkedStatePath(record.sessionDir, record.sessionFile);
  if (!existsSync(record.sessionFile)) {
    if (deleting || record.transcriptState === "unwritten") return undefined;
    throw new Error("The expected conversation transcript is missing; restore it before reopening, or delete this session");
  }
  const fd = openSync(record.sessionFile, "r");
  let header = "";
  try {
    const buffer = Buffer.alloc(4096), decoder = new StringDecoder("utf8");
    for (;;) {
      const count = readSync(fd, buffer);
      if (!count) { header += decoder.end(); break; }
      const chunk = decoder.write(buffer.subarray(0, count)), end = chunk.indexOf("\n");
      header += end < 0 ? chunk : chunk.slice(0, end);
      if (header.length > 1024 * 1024) throw new Error("Stored session header is too large");
      if (end >= 0) break;
    }
  } finally { closeSync(fd); }
  const value = JSON.parse(header);
  if (value.type !== "session" || value.id !== record.id || typeof value.cwd !== "string" || canonicalPath(value.cwd) !== canonicalPath(record.cwd)) {
    throw new Error("Stored transcript identity/cwd differs from the registered session");
  }
  return record.sessionFile;
}

export function piLaunchCommand(record, stateDir) {
  const sessionFile = checkedSessionFile(record);
  return [join(stateDir, "bin", "pi"), ...(sessionFile ? ["--session", sessionFile] : ["--session-id", record.id, "--name", record.title])];
}

// Pi transcripts are outside project state; no subagent or other package data belongs to this adapter.
export function piRemoveConversation(record) {
  const transcript = checkedSessionFile(record, { deleting: true });
  if (transcript) rmSync(transcript);
}
