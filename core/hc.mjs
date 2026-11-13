import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const STARTING = 60_000;

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

export function hc(io, args) {
  return (io.command ?? command)("hc", args);
}

// hc 0.1.18 `ls` reports status as a word, 0.1.20 `get` as {app, state}.
export function statusWord(status) {
  return typeof status === "string" ? status : status?.state;
}

// Live terminals carrying the session's label: `running` once its agent reports a status,
// `starting` for 60 s before that, else `stopped`.
export async function observe(io, id) {
  const { terminals } = await hc(io, ["ls", "--json", "--label", `projects.session=${id}`]);
  const rows = await Promise.all(terminals.filter(row => row.state === "live" && !row.address.includes("/"))
    .map(row => hc(io, ["get", row.address, "--json"])));
  const live = rows.filter(row => row.state === "live" && row.labels?.["projects.session"] === id);
  const running = live.find(row => statusWord(row.status));
  if (running) return { state: "running", status: statusWord(running.status), terminal: running, live };
  const starting = live.find(row => Date.now() - row.created_ms < STARTING);
  if (starting) return { state: "starting", terminal: starting, live };
  return { state: "stopped", live };
}
