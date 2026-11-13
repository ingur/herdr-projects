import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { descendsFrom } from "./lib/process.mjs";

export const LOCAL_TERMINAL = /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/;
const runFile = promisify(execFile);

export async function command(program, args, timeout = 8000) {
  const { stdout } = await runFile(program, args, { timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
  const value = JSON.parse(stdout);
  if (!value || typeof value !== "object" || Array.isArray(value) || "error" in value) throw new Error(`${program}: invalid/error response ${JSON.stringify(value)}`);
  return value;
}
export function rejectedLaunch(error) {
  if (error.killed || error.signal || ![2, 6].includes(error.code)) return false;
  try {
    const kind = JSON.parse(error.stderr).error?.kind;
    // hc's usage/invalid_params precede SPAWN; spawn_failed also covers lost replies.
    return error.code === 2 && kind === "usage" || error.code === 6 && kind === "invalid_params";
  } catch { return false; }
}
export function terminal(value) {
  if (!value || !LOCAL_TERMINAL.test(value.address) || typeof value.state !== "string") throw new Error("hc did not return an unambiguous local terminal");
  return value;
}
export async function terminals(io, selected, liveOnly = false, session) {
  const call = io.command ?? command;
  const value = await call("hc", ["ls", "--all", "--json", ...(session ? ["--label", `projects.session=${session}`] : [])]);
  if (!Array.isArray(value.terminals)) throw new Error("hc returned an invalid terminal list");
  // Catalogs need detail only for live terminals; recovery still inspects historical launch labels.
  const rows = value.terminals.filter(row => typeof row.address === "string" && !row.address.includes("/") && (!selected || selected.has(row.address)));
  return Promise.all(rows.map(async row => {
    if (liveOnly && row.state !== "live") return terminal(row);
    const detail = terminal(await call("hc", ["get", row.address, "--json"]));
    if (detail.address !== row.address) throw new Error("hc returned a different terminal identity");
    return detail;
  }));
}
export function localPlacement(value, name) {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be nonempty printable text`);
  if (value.includes("/")) throw new Error(`${name} must be a local Herdr identity`);
  return value;
}
export function terminalPlacement(row) {
  terminal(row);
  return {
    space: row.labels?.["herdr.space"] === undefined ? undefined : localPlacement(row.labels["herdr.space"], "space"),
    tab: row.labels?.["herdr.tab"] === undefined ? undefined : localPlacement(row.labels["herdr.tab"], "tab"),
  };
}
export function ownership(stateDir, directory, record, row, snapshot) {
  if (row.address !== record.terminal || row.state !== "live") return undefined;
  const labels = row.labels ?? {};
  if ((labels["projects.session"] && labels["projects.session"] !== record.id) ||
      (labels["projects.project"] && labels["projects.project"] !== directory.split("/").pop())) return undefined;
  if (record.registration === "registered" && descendsFrom(record.owner, row.pid, snapshot)) return "registered";
  return record.registration === "awaiting-extension" && record.launchToken && labels["projects.launch"] === record.launchToken &&
    labels["projects.session"] === record.id ? "starting" : undefined;
}
