import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { alive } from "./store.mjs";

const run = promisify(execFile);
const env = { ...process.env };
delete env.HC_TERMINAL_ID;

async function command(program, args) {
  try {
    const { stdout } = await run(program, args, { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
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

export function agentPid(row) {
  return Number((row.labels?.["projects.pid"] ?? "").split("@")[0]);
}

function terminalPid(row) {
  return Number((row.labels?.["projects.pid"] ?? "").split("@")[1]);
}

export function holds(row, id) {
  return row.state === "live" && row.labels?.["projects.session"] === id && terminalPid(row) === row.pid && alive(agentPid(row));
}

export function standIn(row) {
  const program = terminalPid(row);
  return program > 0 && program !== row.pid && !row.status?.state && row.foreground?.pid === row.pid;
}

export function entered(row, id) {
  return holds(row, id) && row.labels["projects.bound"] === "1";
}

export function classify(rows, id) {
  const labelled = rows.filter(row => row.state === "live" && row.labels?.["projects.session"] === id);
  const holding = labelled.filter(row => holds(row, id));
  const running = holding.find(row => entered(row, id) && row.status?.state);
  if (running) return { state: "running", status: running.status.state, terminal: running, labelled };
  if (holding.length) return { state: "starting", terminal: holding[0], labelled };
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
