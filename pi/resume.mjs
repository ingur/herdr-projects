import { homedir } from "node:os";
import { sep } from "node:path";
import { checkedSessionFile } from "./pi-launch.mjs";

export function projectCandidates(sessions, currentId) {
  const recent = row => Math.max(...[row.observed, row.registered, row.created].map(value => Date.parse(value) || 0));
  return sessions.filter(row => row.agent === "pi" && row.role === "coordinator" && row.writer === "dead" && row.id !== currentId)
    .sort((a, b) => Number(!!a.resolved) - Number(!!b.resolved) || recent(b) - recent(a) || a.id.localeCompare(b.id));
}

export function matchProject(candidates, text) {
  const query = text.trim().toLowerCase();
  if (!query) return undefined;
  const exact = candidates.filter(row => row.title.toLowerCase() === query);
  const matches = exact.length ? exact : candidates.filter(row => row.title.toLowerCase().includes(query));
  return matches.length === 1 ? matches[0] : undefined;
}

export function displayFolder(folder, home = homedir()) {
  return folder === home ? "~" : folder.startsWith(`${home}${sep}`) ? `~${folder.slice(home.length)}` : folder;
}

export function changedWorkingFolder(folder, terminalFolder) {
  return folder === terminalFolder ? undefined : displayFolder(folder);
}

export function projectConversation(record) {
  const file = checkedSessionFile(record);
  if (!file) throw Object.assign(new Error("This project has no saved conversation yet; start Pi with --session-id " + record.id + " in " + displayFolder(record.cwd) + " to resume it."), { code: "ENOSESSIONFILE" });
  return file;
}
