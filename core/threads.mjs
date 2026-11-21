import { resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as messages from "./messages.mjs";
import { changed, close, create, isFolder, launch, title } from "./sessions.mjs";
import { update } from "./state.mjs";
import * as terminals from "../herdr/terminals.mjs";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// `by` is "agent" or "user".
export async function start(stateDir, coordinator, { title: wanted, text, folder, attach, model, thinking }, by, io) {
  if (coordinator.kind !== "coordinator") throw new Error("Threads are started under a coordinator");
  const named = wanted === undefined ? { title: "New thread", titleSource: "placeholder" } : { title: title(wanted), titleSource: by };
  const first = text === undefined ? undefined : messages.draft(stateDir, coordinator, text, attach);
  if (folder !== undefined && typeof folder !== "string") throw new Error("folder must be a path");
  if (model !== undefined && (typeof model !== "string" || !model)) throw new Error("model must be text");
  if (thinking !== undefined && !THINKING.includes(thinking)) throw new Error(`thinking is one of ${THINKING.join(", ")}`);
  const path = resolvePath(coordinator.folder, folder ?? ".");
  if (!isFolder(path)) throw new Error(`${path} is not a folder`);
  const record = create(stateDir, { kind: "thread", project: coordinator.id, ...named, folder: path, model, thinking });
  if (first) messages.save(stateDir, coordinator, record, first);
  return changed(stateDir, record.id, io, await launch(stateDir, record.id, io));
}

export async function resolve(stateDir, record, by, io) {
  if (by === "agent") {
    // A thread usually reports just before its turn ends; give that turn a moment to finish.
    for (let second = 0; (await terminals.observe(io, record.id)).status === "working"; second++) {
      if (second >= 20) throw new Error("This thread is still working; wait for its result, then resolve it");
      await (io.delay ?? delay)(1000);
    }
  }
  await update(stateDir, record.id, () => ({ resolved: true }), io);
  await close(stateDir, record, io);
  return changed(stateDir, record.id, io);
}

export async function unresolve(stateDir, record, io) {
  await update(stateDir, record.id, () => ({ resolved: false }), io);
  return changed(stateDir, record.id, io);
}
