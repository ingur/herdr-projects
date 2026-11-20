import { rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, UUID, writeJson } from "./state.mjs";

const folder = (stateDir, project) => join(stateDir, "logs", project);

export function record(stateDir, project, entry) {
  writeJson(join(folder(stateDir, project), `${entry.id}.json`), entry);
  return entry;
}

export function read(stateDir, project, id) {
  if (typeof id !== "string" || !UUID.test(id)) return undefined;
  return readJson(join(folder(stateDir, project), `${id}.json`));
}

export const discard = (stateDir, project) => rmSync(folder(stateDir, project), { recursive: true, force: true });
