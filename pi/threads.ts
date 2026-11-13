import type { Static, TSchema } from "typebox";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  forwardedSchema, parse, records,
  renameSchema, sendSchema, startSchema, targetSchema,
  type Forwarded, type Message,
} from "../core/contracts.ts";
import type { Runtime } from "./types.ts";
import { forwardEntry } from "./messages.mjs";
import { createThread, publishMessage, renameSession, reopenSession, resolveSession, sendMessage } from "../core/control.mjs";

const runFile = promisify(execFile);

export async function command<T extends TSchema>(program: string, args: string[], schema: T, timeout = 8000): Promise<Static<T>> {
  const { stdout } = await runFile(program, args, { timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
  const result: unknown = JSON.parse(stdout);
  if (result && typeof result === "object" && "error" in result) throw new Error(`${program}: ${JSON.stringify(result.error)}`);
  return parse(schema, result, `${program} response`);
}

function requiredText(value: unknown, name: string, max = 100000): string {
  if (typeof value !== "string" || !value.length || value.length > max) throw new Error(`${name} must contain 1–${max} characters`);
  return value;
}

function identity(r: Runtime) {
  return { kind: "agent", session: r.id, title: r.title, role: r.role };
}

function envelope(r: Runtime, target: string, content: Forwarded, note?: string): Message {
  return {
    version: 1,
    id: randomUUID(),
    projectRoot: r.projectRoot,
    recipient: target,
    created: new Date().toISOString(),
    sender: identity(r),
    ...content,
    ...(note === undefined ? {} : { note: requiredText(note, "note") }),
  };
}

function resolveTarget(r: Runtime, target: string, allowSelf = false) {
  if (target === "coordinator") target = r.coordinator;
  if (target === "self") target = r.id;
  const sessions = records(r.store);
  const exact = sessions.find(record => record.id === target);
  const matches = exact ? [exact] : sessions.filter(record => record.coordinator === r.coordinator && record.title === target);
  if (matches.length !== 1) throw new Error("Target is missing or ambiguous; use an exact session UUID from thread_list");
  if (!allowSelf && matches[0].id === r.id) throw new Error("Send to another session, not yourself");
  return matches[0];
}

export async function sendThread(r: Runtime, input: unknown) {
  const args = parse(sendSchema, input, "send arguments");
  requiredText(args.target, "target", 200);
  if ((args.text !== undefined) === (args.forward !== undefined)) throw new Error("Supply exactly one of text or forward (an entry ID in this session)");
  const target = resolveTarget(r, args.target);
  const options = { stateDir: r.stateDir, projectRoot: r.projectRoot, id: target.id };
  if (args.text !== undefined) return sendMessage({ ...options, text: args.text, note: args.note, sender: identity(r) });
  const content = parse(forwardedSchema,
    forwardEntry(r.ctx.sessionManager.getEntry(requiredText(args.forward, "forward", 100)), r.id, r.title), "forwarded entry");
  return publishMessage(options, envelope(r, target.id, content, args.note));
}

export async function renameThread(r: Runtime, input: unknown) {
  const args = parse(renameSchema, input, "rename arguments");
  const record = resolveTarget(r, args.target ?? "self", true);
  return renameSession({ stateDir: r.stateDir, projectRoot: r.projectRoot, id: record.id, title: args.title, by: "agent" });
}

export async function resolveThread(r: Runtime, input: unknown) {
  const { target } = parse(targetSchema, input, "resolve arguments");
  const record = resolveTarget(r, target, true);
  return resolveSession({ stateDir: r.stateDir, projectRoot: r.projectRoot, id: record.id, by: "agent", session: r.id });
}

export async function reopenThread(r: Runtime, input: unknown) {
  const { target } = parse(targetSchema, input, "reopen arguments");
  const record = resolveTarget(r, target, true);
  return reopenSession({ stateDir: r.stateDir, projectRoot: r.projectRoot, id: record.id, by: "agent" });
}

export async function startThread(r: Runtime, input: unknown, toolCall?: string) {
  const args = parse(startSchema, input, "start arguments");
  const content = { text: requiredText(args.instruction, "text"), author: identity(r), source: { session: r.id, toolCall }, via: [] };
  const created = await createThread({ stateDir: r.stateDir, projectRoot: r.projectRoot, id: r.coordinator,
    title: args.name, cwd: args.cwd, initial: envelope(r, r.coordinator, content) });
  return {
    ...created,
    note: !created.repeatedName
      ? "Initial instruction is retained until this session registers. Opening the terminal is not model completion."
      : "Existing thread retained; this instruction was not sent again. Use thread_send for further instructions or thread_reopen to clear resolved status.",
  };
}

