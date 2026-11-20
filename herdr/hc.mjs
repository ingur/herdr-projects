import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function command(program, args) {
  try {
    const { stdout } = await run(program, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    let message;
    try { message = JSON.parse(error.stderr).error.message; } catch {}
    throw new Error(`${program} ${args[0]}: ${message ?? error.message}`);
  }
}

const hc = (io, args) => (io.command ?? command)("hc", args);
const pairs = labels => Object.entries(labels).map(([key, value]) => `${key}=${value ?? ""}`);

export const terminal = (io, address) => hc(io, ["get", address, "--json"]);

// `hc ls` rows are short; `hc get` gives labels, pid and status. Terminals of other machines are left out.
export async function terminals(io, label) {
  const { terminals } = await hc(io, ["ls", "--json", "--label", label]);
  return Promise.all(terminals.filter(row => row.state === "live" && !row.address.includes("/")).map(row => terminal(io, row.address)));
}

// An empty value takes the label off.
export const label = (io, address, labels) => hc(io, ["label", address, "--json", ...pairs(labels)]);

export async function found(io, env, program) {
  const { code } = await hc(io, ["exec", "--json", ...pairs(env).flatMap(pair => ["--env", pair]), "--", "sh", "-c", 'command -v "$1"', "sh", program]);
  return code === 0;
}

// With `env … program`, env execs the program, so the pid hc reports for the terminal is the program's.
export async function start(io, { folder, labels, env, argv }) {
  const { address } = await hc(io, ["run", "--bg", "--json", "--no-parent", "--cwd", folder,
    ...pairs(labels).flatMap(pair => ["--label", pair]), "--", "env", ...pairs(env), ...argv]);
  return address;
}

export const stop = (io, address) => hc(io, ["kill", address, "--json"]);
