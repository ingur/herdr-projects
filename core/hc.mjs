import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { alive } from "./store.mjs";

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

export function hc(io, args) {
  return (io.command ?? command)("hc", args);
}

// hc 0.1.18 `ls` reports status as a word, 0.1.20 `get` as {app, state}.
export function statusWord(status) {
  return typeof status === "string" ? status : status?.state;
}

// projects.pid is `<agent pid>@<terminal pid>`. A terminal holds the session while that agent is alive
// and the terminal still runs the program it ran then: one hc brought back after a restart has a new pid.
export function holds(row, id) {
  const [agent, terminal] = (row.labels?.["projects.pid"] ?? "").split("@");
  return row.state === "live" && row.labels?.["projects.session"] === id && Number(terminal) === row.pid && alive(Number(agent));
}

// `running` once the agent reports a status, `starting` while it is alive without one, else `stopped`.
// `labelled` also lists terminals left behind by an agent that died.
export function classify(rows, id) {
  const labelled = rows.filter(row => row.state === "live" && row.labels?.["projects.session"] === id);
  const agents = labelled.filter(row => holds(row, id));
  const running = agents.find(row => statusWord(row.status));
  if (running) return { state: "running", status: statusWord(running.status), terminal: running, labelled };
  if (agents.length) return { state: "starting", terminal: agents[0], labelled };
  return { state: "stopped", labelled };
}

// `hc ls` rows are short; `hc get` gives labels, pid and status.
export async function details(io, label) {
  const { terminals } = await hc(io, ["ls", "--json", "--label", label]);
  return Promise.all(terminals.filter(row => row.state === "live" && !row.address.includes("/"))
    .map(row => hc(io, ["get", row.address, "--json"])));
}

export async function observe(io, id) {
  return classify(await details(io, `projects.session=${id}`), id);
}
