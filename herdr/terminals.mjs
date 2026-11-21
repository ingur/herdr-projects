import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as hc from "./hc.mjs";

const UNLABEL = {
  "projects.session": "", "projects.pid": "", "projects.bound": "", "projects.control": "", "projects.changed": "", "projects.launched": "",
};

const launcher = stateDir => join(stateDir, "bin", "control");

export const control = stateDir => JSON.stringify({ version: 3, command: [launcher(stateDir)], stateDir });

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const script = fileURLToPath(new URL("../control.mjs", import.meta.url));

// The command a client runs. The recorded node can go with an upgrade; the one on PATH then runs it.
export function writeControl(stateDir) {
  const path = launcher(stateDir), temporary = `${path}.${randomUUID()}`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `#!/bin/sh\nnode=${quote(process.execPath)}\n[ -x "$node" ] || node=node\nexec "$node" ${quote(script)} "$@"\n`, { mode: 0o755 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

export const live = row => row.state === "live";
export const session = row => row.labels?.["projects.session"];
export const reported = row => row.labels?.["projects.bound"] === "1";
export const place = row => ({ space: row.labels?.["herdr.space"], tab: row.labels?.["herdr.tab"] });

export function agentPid(row) {
  return Number((row.labels?.["projects.pid"] ?? "").split("@")[0]);
}

function programPid(row) {
  return Number((row.labels?.["projects.pid"] ?? "").split("@")[1]);
}

export function holds(row, id) {
  return row.state === "live" && row.labels?.["projects.session"] === id && programPid(row) === row.pid && alive(agentPid(row));
}

// The empty shell hc puts in place of a program that was lost, as after a restart.
function standIn(row) {
  const program = programPid(row);
  return program > 0 && program !== row.pid && !row.status?.state && row.foreground?.pid === row.pid;
}

// `terminal` is where the session runs or starts. `shell` is the stand-in that waits in a stopped session's tab.
export function classify(rows, id) {
  const labelled = rows.filter(row => row.state === "live" && row.labels?.["projects.session"] === id);
  const holding = labelled.filter(row => holds(row, id));
  const running = holding.find(row => row.labels["projects.bound"] === "1" && row.status?.state);
  if (running) return { state: "running", status: running.status.state, terminal: running, labelled };
  if (holding.length) return { state: "starting", terminal: holding[0], labelled };
  return { state: "stopped", shell: labelled.find(standIn), labelled };
}

export const read = (io, address) => hc.terminal(io, address);

export const all = (io, stateDir) => hc.terminals(io, `projects.control=${control(stateDir)}`);

export const of = (io, id) => hc.terminals(io, `projects.session=${id}`);

export async function observe(io, id) {
  return classify(await of(io, id), id);
}

// A session is open while an agent sits in its terminal, or a terminal core started still waits for it.
export function isOpen(rows, id) {
  const { terminal, labelled } = classify(rows, id);
  return Boolean(terminal) || labelled.some(row => row.labels["projects.launched"]);
}

// The sidebar refreshes on projects.changed; a terminal that ended meanwhile needs no refresh.
export const mark = (io, address) => hc.label(io, address, { "projects.changed": Date.now() }).catch(() => {});

export async function start(io, stateDir, id, { folder, space, tab, env, argv }) {
  if (!await hc.found(io, env, argv[0])) throw new Error(`${argv[0]} was not found on the PATH herdr starts it with`);
  const placed = space === undefined ? undefined : tab ?? `pt-${id}`;
  const address = await hc.start(io, {
    folder, argv, env: { ...env, PROJECTS_STATE_DIR: stateDir },
    labels: {
      ...(space === undefined ? {} : { "herdr.space": space, "herdr.tab": placed }),
      "projects.session": id, "projects.control": control(stateDir), "projects.launched": 1,
    },
  });
  const { pid } = await hc.terminal(io, address);
  if (!pid) throw new Error("hc reported no pid for the new terminal");
  await hc.label(io, address, { "projects.pid": `${pid}@${pid}` });
  return { address, tab: placed };
}

export const bind = (io, stateDir, id, row, pid) => hc.label(io, row.address, {
  "projects.session": id, "projects.pid": `${pid}@${row.pid}`, "projects.bound": 1, "projects.control": control(stateDir),
});

// The agent left: the terminal keeps the session's label and waits for it.
export const unbind = (io, row) => hc.label(io, row.address, { "projects.bound": "", "projects.pid": `@${row.pid}` });

export const unlabel = (io, row) => hc.label(io, row.address, UNLABEL);

// What a session left behind: terminals other than `address` that still carry its label, read again.
async function left(io, rows, id, address) {
  const labelled = row => row.state === "live" && row.labels?.["projects.session"] === id;
  const others = await Promise.all(rows.filter(row => labelled(row) && row.address !== address).map(row => hc.terminal(io, row.address)));
  return others.filter(labelled);
}

// A session that starts elsewhere or is deleted leaves nothing behind: its stand-in shell is closed, any other terminal loses the labels.
export async function vacate(io, rows, id, address) {
  for (const row of await left(io, rows, id, address)) await (standIn(row) ? hc.stop(io, row.address) : hc.label(io, row.address, UNLABEL));
}

// Ends the session's agent and closes its stand-in shell. hc has no conditional kill: the label is read
// again right before it. Returns the terminal it ended.
export async function stop(io, rows, id) {
  const { terminal, labelled } = classify(rows, id);
  const current = terminal && await hc.terminal(io, terminal.address);
  const held = current && holds(current, id) ? current : undefined;
  if (held && (await hc.stop(io, held.address)).state !== "finished") throw new Error(`hc could not stop terminal ${held.address}`);
  for (const row of await left(io, labelled, id, terminal?.address)) if (standIn(row)) await hc.stop(io, row.address);
  return held;
}
