import { mkdirSync, rmSync, watch as watchFolder } from "node:fs";
import { join } from "node:path";
import { fileNames, readJson, UUID, writeJson } from "./state.mjs";

// One file per item. Its name starts with the time it was saved, so names sort oldest first and no lock is needed.
const NAME = /^(\d{13})-([0-9a-f-]{36})\.(message|copy)\.json$/;
const folder = (stateDir, owner) => join(stateDir, "mailboxes", owner);
let last = 0;

export function put(stateDir, owner, item) {
  // Strictly increasing, so one sender's items keep their order within a millisecond.
  last = Math.max(Date.now(), last + 1);
  writeJson(join(folder(stateDir, owner), `${last}-${item.id}.${item.type}.json`), item);
  return item;
}

function names(stateDir, owner) {
  return fileNames(folder(stateDir, owner)).filter(name => NAME.test(name));
}

export function read(stateDir, owner) {
  const items = [], errors = [];
  for (const name of names(stateDir, owner)) {
    try {
      const item = readJson(join(folder(stateDir, owner), name));
      if (item) items.push(item);
    } catch (error) { errors.push({ id: name.match(NAME)[2], error: error.message }); }
  }
  return { items, ...(errors.length ? { errors } : {}) };
}

// The number of messages that wait. Copies do not count: nobody waits for an answer to one.
export const waiting = (stateDir, owner) => names(stateDir, owner).filter(name => name.match(NAME)[3] === "message").length;

export function remove(stateDir, owner, ids) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !UUID.test(id))) throw new Error("Items are named by a list of their ids");
  const taken = new Set(ids);
  for (const name of names(stateDir, owner)) {
    if (taken.has(name.match(NAME)[2])) rmSync(join(folder(stateDir, owner), name), { force: true });
  }
}

export const discard = (stateDir, owner) => rmSync(folder(stateDir, owner), { recursive: true, force: true });

export function watch(stateDir, owner, changed) {
  mkdirSync(folder(stateDir, owner), { recursive: true, mode: 0o700 });
  const watcher = watchFolder(folder(stateDir, owner), () => changed());
  watcher.on("error", error => { watcher.close(); changed(error); });
  return () => watcher.close();
}

// Resolves once something waits, or after `seconds`.
export function arrival(stateDir, owner, seconds) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); stop(); resolve(); };
    const stop = watch(stateDir, owner, error => (error || names(stateDir, owner).length) && done());
    const timer = setTimeout(done, seconds * 1000);
    if (names(stateDir, owner).length) done();
  });
}
