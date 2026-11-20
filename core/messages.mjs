import { randomUUID } from "node:crypto";
import * as log from "./log.mjs";
import * as mailbox from "./mailbox.mjs";
import { changed, launch, member } from "./sessions.mjs";
import { session, update } from "./state.mjs";

const COPY_LENGTH = 2000;

// Only core writes these tags in what an agent reads. In every text of `value`, their `<` is shown as `&lt;`.
export function inert(value) {
  if (typeof value === "string") return value.replace(/<(?=\/?(?:message|copy|attached|typed)\b)/gi, "&lt;");
  if (Array.isArray(value)) return value.map(inert);
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, part]) => [key, inert(part)])) : value;
}

const escape = value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const attributes = values => Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => ` ${key}="${escape(value)}"`).join("");

export function wrap(item) {
  if (item.type === "copy") return `<copy${attributes({ id: item.id, from: item.from, "from-title": item.fromTitle, to: item.to, "to-title": item.toTitle, cut: item.cut })}>\n${inert(item.text)}\n</copy>`;
  const attached = (item.attached ?? []).map(part => `<attached${attributes({ from: "user", id: part.id })}>\n${inert(part.text)}\n</attached>\n`).join("");
  return `<message${attributes({ id: item.id, from: item.from, "from-title": item.fromTitle })}>\n${attached}${inert(item.text)}\n</message>`;
}

// A party on the `from` or `to` side of an item: its address, and with a session's id its title.
function party(side, record) {
  if (!record) return { [side]: "user" };
  if (record.kind === "coordinator") return { [side]: "coordinator" };
  return { [side]: record.id, [`${side}Title`]: record.title };
}

function copy(stateDir, project, entry) {
  const cut = entry.text.length > COPY_LENGTH;
  mailbox.put(stateDir, project, {
    type: "copy", id: entry.id, from: entry.from, fromTitle: entry.fromTitle, to: entry.to, toTitle: entry.toTitle, text: cut ? entry.text.slice(0, COPY_LENGTH) : entry.text,
    ...(cut ? { cut: `${COPY_LENGTH} of ${entry.text.length}` } : {}), created: entry.created,
  });
}

function attachments(stateDir, sender, ids = []) {
  if (!Array.isArray(ids)) throw new Error("attach must be a list of ids");
  if (ids.length && !sender?.project) throw new Error("Only a session in a project can attach the user's words");
  return ids.map(id => {
    const entry = log.read(stateDir, sender.project, id);
    if (entry?.from !== "user") throw new Error(`${id} is not something the user said in this project`);
    return { id, text: entry.text };
  });
}

// What a sender may send: its text, and the user's words it carries along.
export function draft(stateDir, sender, value, attach) {
  if (typeof value !== "string" || !value.length || value.length > 100000) throw new Error("A message is 1 to 100000 characters");
  return { text: value, attached: attachments(stateDir, sender, attach) };
}

function recipient(stateDir, sender, to) {
  if (!sender) return session(stateDir, to);
  if (sender.kind === "plain") throw new Error("A session outside a project can send only to the user");
  const found = member(stateDir, sender, to);
  if (found.id === sender.id) throw new Error("Send to another session, not yourself");
  return found;
}

export function save(stateDir, sender, receiver, { text, attached }) {
  const item = {
    type: "message", id: randomUUID(), ...party("from", sender), ...(sender ? { session: sender.id } : {}), ...party("to", receiver),
    text, ...(attached.length ? { attached } : {}), created: new Date().toISOString(),
  };
  const project = sender?.project ?? receiver?.project;
  if (project) log.record(stateDir, project, item);
  mailbox.put(stateDir, receiver?.id ?? "user", item);
  const thread = [sender, receiver].find(record => record?.kind === "thread");
  if (thread && sender?.kind !== "coordinator" && receiver?.kind !== "coordinator") copy(stateDir, thread.project, item);
  return item;
}

export async function send(stateDir, sender, to, value, attach, io) {
  const checked = draft(stateDir, sender, value, attach);
  if (to === "user") {
    if (!sender) throw new Error("A message to the user comes from a session");
    save(stateDir, sender, undefined, checked);
    return {};
  }
  const receiver = recipient(stateDir, sender, to);
  if (receiver.resolved) {
    if (sender?.kind === "thread" && receiver.kind === "thread") throw new Error("This thread is resolved; only its coordinator or the user can reopen it");
    await update(stateDir, receiver.id, () => ({ resolved: false }), io);
  }
  save(stateDir, sender, receiver, checked);
  return changed(stateDir, receiver.id, io, receiver.kind === "thread" ? await launch(stateDir, receiver.id, io) : {});
}

export function typed(stateDir, record, value) {
  if (!record.project || typeof value !== "string" || !value.trim()) return {};
  const entry = log.record(stateDir, record.project, { type: "typed", id: randomUUID(), from: "user", ...party("to", record), text: value, created: new Date().toISOString() });
  if (record.kind === "thread") copy(stateDir, record.project, entry);
  const [line] = value.trim().split("\n");
  return { id: entry.id, content: `<typed${attributes({ id: entry.id })}>${inert(line.slice(0, 80))}</typed>` };
}

export function answered(stateDir, record, value) {
  if (record.kind !== "thread" || typeof value !== "string" || !value.trim()) return;
  copy(stateDir, record.project, log.record(stateDir, record.project, {
    type: "answer", id: randomUUID(), ...party("from", record), session: record.id, to: "user", text: value, created: new Date().toISOString(),
  }));
}

export function read(stateDir, reader, id) {
  const entry = log.read(stateDir, reader.project, id);
  if (!entry) throw new Error(`No message ${JSON.stringify(id)} in this project`);
  return entry;
}
