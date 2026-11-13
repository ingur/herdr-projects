import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Store } from "./store.mjs";

const text = Type.String({ minLength: 1, maxLength: 100000 });
export const startSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  instruction: text,
  cwd: Type.Optional(Type.String()),
}, { additionalProperties: false });
export const sendSchema = Type.Object({
  target: Type.String(),
  text: Type.Optional(text),
  forward: Type.Optional(Type.String()),
  note: Type.Optional(text),
}, { additionalProperties: false });
export const targetSchema = Type.Object({
  target: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export const renameSchema = Type.Object({
  target: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  title: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const authorSchema = Type.Object({ kind: Type.String(), session: Type.Optional(Type.String()), title: Type.String(), role: Type.Optional(Type.String()), type: Type.Optional(Type.String()) });
const sourceSchema = Type.Object({ session: Type.String(), entry: Type.Optional(Type.Union([Type.String(), Type.Null()])), toolCall: Type.Optional(Type.String()) });
export const forwardedSchema = Type.Object({
  text: Type.String(), author: authorSchema, source: Type.Optional(sourceSchema),
  via: Type.Array(Type.Intersect([sourceSchema, Type.Object({ sender: Type.Optional(authorSchema), note: Type.Optional(Type.String()) })])),
});
export const messageSchema = Type.Intersect([forwardedSchema, Type.Object({
  version: Type.Literal(1), id: Type.String(), projectRoot: Type.String(), recipient: Type.String(),
  created: Type.String(), sender: authorSchema, note: Type.Optional(Type.String()), informational: Type.Optional(Type.Boolean()),
})]);
const ownerSchema = Type.Object({ pid: Type.Integer(), start: Type.String(), boot: Type.String(), state: Type.String(), token: Type.String() });
export const recordSchema = Type.Object({
  version: Type.Literal(1), id: Type.String(), projectRoot: Type.String(), title: Type.String(),
  titleSource: Type.Union([Type.Literal("placeholder"), Type.Literal("agent"), Type.Literal("human")]),
  agent: Type.String({ minLength: 1 }),
  role: Type.Union([Type.Literal("coordinator"), Type.Literal("thread")]), coordinator: Type.String(),
  cwd: Type.String(), space: Type.Optional(Type.String()), tab: Type.Optional(Type.String()), terminal: Type.Optional(Type.String()),
  sessionFile: Type.Optional(Type.String()), sessionDir: Type.Optional(Type.String()),
  registration: Type.String(), owner: Type.Optional(ownerSchema), initial: Type.Optional(messageSchema),
  launchState: Type.Optional(Type.String()), launchError: Type.Optional(Type.String()), created: Type.Optional(Type.String()),
  resolved: Type.Optional(Type.Boolean()), rank: Type.Optional(Type.Number()),
  resolvedBy: Type.Optional(Type.Object({ kind: Type.Union([Type.Literal("human"), Type.Literal("agent")]), session: Type.Optional(Type.String()) })),
  transcriptState: Type.Optional(Type.Union([Type.Literal("expected"), Type.Literal("unwritten")])),
});
export const terminalSchema = Type.Object({
  address: Type.String(), state: Type.String(), parent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  labels: Type.Optional(Type.Record(Type.String(), Type.String())), status: Type.Optional(Type.Unknown()),
});

export type ThreadRecord = Static<typeof recordSchema>;
export type Message = Static<typeof messageSchema>;
export type Forwarded = Static<typeof forwardedSchema>;
export type Terminal = Static<typeof terminalSchema>;
export type Owner = Static<typeof ownerSchema>;
export interface DeliveryView {
  message: Message;
  delivery: { state: string; execution: string; entry?: string; attempted?: string };
}

export function parse<T extends TSchema>(schema: T, value: unknown, label: string): Static<T> {
  if (!Value.Check(schema, value)) throw new Error(`Invalid ${label}: ${Value.Errors(schema, value)[0]?.message}`);
  return value;
}
export function records(store: Store): ThreadRecord[] {
  return store.records().map((value: unknown) => parse(recordSchema, value, "project record"));
}
export function getRecord(store: Store, id: string): ThreadRecord | undefined {
  const value: unknown = store.record(id);
  return value === undefined ? undefined : parse(recordSchema, value, "project record");
}
export function messages(store: Store, id: string, recorded: ReadonlyMap<string, DeliveryView>): Message[] {
  return store.messages(id, recorded).map((value: unknown) => parse(messageSchema, value, "inbox message"));
}
export function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
