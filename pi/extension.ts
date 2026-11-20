import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as agent from "../core/agent.mjs";
import * as core from "../core/extension.mjs";
import * as adapter from "./adapter.mjs";

type Session = { id: string; kind: "plain" | "coordinator" | "thread"; title: string; titleSource: string };
type Attached = { id: string; text: string };
type Mail = { id: string; type: "message" | "copy"; from: string; fromTitle?: string; text: string; attached?: Attached[]; content: string };
type Shown = Pick<Mail, "id" | "from" | "fromTitle" | "text" | "attached">;
type Args = { to?: string; text?: string; title?: string; thread?: string; instruction?: string; attach?: string[] };
type Sent = { who: string; text: string; attach: string[] };
type Row = { title: string; state: string; status?: string; resolved: boolean };
type Details = { sessions?: Row[]; from?: string; fromTitle?: string; to?: string; toTitle?: string; text?: string; attached?: Attached[] };
type Result = { content: { type: string; text?: string }[]; details: Details };

const MESSAGE = "projects-message", COPY = "projects-copy", TYPED = "projects-typed";
// cod-mail, from the Nerd Font symbols that herdr's terminal has built in.
const ENVELOPE = "\uEB1C";
const ATTACHED = "attached, your words:";
const usage = "Use /projects new [name] to make this session a project.";
const io = { adapter };

function firstWords(text: string) {
  const [line] = text.trim().split("\n");
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function mailLine(theme: Theme, who: string, text: string, notes: string[], expanded: boolean, pad = 0) {
  // The envelope is drawn two columns wide: the first space is under it, the second is the gap.
  const head = `${theme.fg("accent", ENVELOPE)}  ${theme.bold(who)}`;
  if (!expanded) return new Text(`${head}${theme.fg("dim", ` · ${firstWords(text)}`)}`, pad, 0);
  return new Text([head, ...notes, text].join("\n\n"), pad, 0);
}

function toolLine(theme: Theme, name: string, object = "") {
  return new Text(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", object)}`, 0, 0);
}

function under(theme: Theme, tool: string, result: Result, expanded: boolean, refused: boolean) {
  if (refused) return new Text(theme.fg("error", result.content.map(part => part.text ?? "").join("\n")), 0, 0);
  const output = outputs[tool]?.(result.details, expanded) ?? "";
  return new Text(output && output.split("\n").map(line => theme.fg("toolOutput", line)).join("\n"), 0, 0);
}

const party = (name = "") => name === "user" ? "you" : name;
const who = (address?: string, title?: string) => title ?? party(address);
const titleOf = (name = "") => core.current({ id: name }).session?.title ?? name;
const quoted = (attached: Attached[] = [], label = ATTACHED) => attached.map(part => `${label}\n${part.text}`);

const sent: Record<string, (args: Args) => Sent> = {
  message_send: args => ({ who: `to ${party(titleOf(args.to))}`, text: args.text ?? "", attach: args.attach ?? [] }),
  thread_start: args => ({ who: `to ${args.title ?? ""}, new thread`, text: args.instruction ?? "", attach: args.attach ?? [] }),
};

const objects: Record<string, (args: Args) => string> = {
  title_set: args => args.thread === undefined ? args.title ?? "" : `${args.title ?? ""} for ${titleOf(args.thread)}`,
  thread_resolve: args => titleOf(args.thread),
};

const outputs: Record<string, (details: Details, expanded: boolean) => string | undefined> = {
  thread_list: (details, expanded) => expanded ? (details.sessions ?? []).map(row => [row.title, row.state, row.status, row.resolved && "resolved"].filter(Boolean).join(" · ")).join("\n") : undefined,
  message_read(details, expanded) {
    const sides = `from ${who(details.from, details.fromTitle)} to ${who(details.to, details.toTitle)}`;
    return expanded ? [sides, ...quoted(details.attached), details.text].join("\n\n") : `${sides} · ${firstWords(details.text ?? "")}`;
  },
};

export default function projects(pi: ExtensionAPI) {
  const terminal = process.env.HC_TERMINAL_ID, pid = process.pid;
  let me: Session | undefined;
  let stopWatching = () => {};
  let typing = false;
  // The message pi was given to start a run with, until that run is over.
  let starting: string | undefined;
  let again: ReturnType<typeof setTimeout> | undefined;
  const unreadable = new Set<string>();

  function show(session?: Session) {
    me = session;
    const mine = agent.tools.filter(tool => session && tool.kinds.includes(session.kind)).map(tool => tool.name);
    const others = pi.getActiveTools().filter(name => !agent.tools.some(tool => tool.name === name));
    pi.setActiveTools([...others, ...mine]);
    if (session && session.titleSource !== "placeholder" && session.title !== pi.getSessionName()) pi.setSessionName(session.title);
  }

  const notify = (ctx: ExtensionContext, error: unknown) => ctx.ui.notify(`Projects: ${error instanceof Error ? error.message : String(error)}`, "error");

  // A name the user gives the session in pi is its title. One that core refuses is taken back in pi.
  async function named(session: Session, title: string, ctx: ExtensionContext) {
    try { show((await core.named({ id: session.id, title }, io)).session); }
    catch (error) { show(session); notify(ctx, error); }
  }

  function entryOf(item: Mail) {
    if (item.type === "copy") return { type: "custom_message" as const, customType: COPY, content: item.content, display: false, details: { id: item.id } };
    const details: Shown = { id: item.id, from: item.from, fromTitle: item.fromTitle, text: item.text, attached: item.attached };
    return { type: "custom_message" as const, customType: MESSAGE, content: item.content, display: true, details };
  }

  function read(session: Session, ctx: ExtensionContext) {
    const { items, errors } = core.mail({ id: session.id }) as { items: Mail[]; errors?: { id: string; error: string }[] };
    for (const { id, error } of errors ?? []) {
      if (!unreadable.has(id)) notify(ctx, `mail ${id} cannot be read: ${error}`);
      unreadable.add(id);
    }
    return items;
  }

  function held(items: Mail[], ctx: ExtensionContext) {
    const ids = new Set<string>();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom_message" && (entry.customType === MESSAGE || entry.customType === COPY)) ids.add((entry.details as { id: string }).id);
    }
    return items.filter(item => ids.has(item.id));
  }

  // Mail that is neither in the conversation nor with pi.
  function due(items: Mail[], ctx: ExtensionContext) {
    const kept = held(items, ctx);
    return items.filter(item => !kept.includes(item) && item.id !== starting);
  }

  // One message starts a run. Mail behind it is for the end of a turn.
  function give(items: Mail[], ctx: ExtensionContext) {
    for (const item of due(items, ctx)) {
      if (item.type === "copy") {
        pi.sendMessage(entryOf(item), { triggerTurn: false });
        continue;
      }
      starting = item.id;
      pi.sendMessage(entryOf(item), { triggerTurn: true });
      return;
    }
  }

  // pi writes a new conversation to its file with the first prompt or answer; until then nothing is safe on disk.
  async function settle(session: Session, items: Mail[], ctx: ExtensionContext) {
    const ids = held(items, ctx).map(item => item.id);
    if (ids.length && existsSync(ctx.sessionManager.getSessionFile()!)) await core.stored({ id: session.id, ids }, io);
  }

  // Looks again in a second: pi does not tell an extension when a compaction or a move in its tree is over,
  // and what pi ended a run for, such as /new, goes first.
  function later(ctx: ExtensionContext) {
    clearTimeout(again);
    again = setTimeout(() => look(ctx).catch(error => notify(ctx, error)), 1000);
  }

  async function look(ctx: ExtensionContext) {
    clearTimeout(again);
    if (!me) return;
    const items = read(me, ctx);
    if (ctx.isIdle() && !starting) give(items, ctx);
    if (due(items, ctx).length) later(ctx);
    await settle(me, items, ctx);
  }

  function lastAnswer(ctx: ExtensionContext) {
    const answer = ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant");
    if (answer?.type !== "message" || answer.message.role !== "assistant" || answer.message.stopReason === "error") return undefined;
    return answer.message.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
  }

  const reporting = <Event, Result>(handle: (event: Event, ctx: ExtensionContext) => Promise<Result>) =>
    async (event: Event, ctx: ExtensionContext) => {
      try { return await handle(event, ctx); }
      catch (error) { notify(ctx, error); }
    };

  pi.on("session_start", reporting(async (event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (!terminal || ctx.mode !== "tui" || !file) return show();
    const { session, error } = await core.enter({
      terminal, pid, folder: ctx.cwd, env: process.env, replaced: event.reason === "new" || event.reason === "fork",
      conversation: { id: ctx.sessionManager.getSessionId(), file },
    }, io);
    const name = pi.getSessionName();
    if (session.titleSource === "placeholder" && name) await named(session, name, ctx);
    else show(session);
    stopWatching = core.watch({ id: session.id }, (failed?: Error) => failed ? notify(ctx, failed) : look(ctx).catch(error => notify(ctx, error)));
    await look(ctx);
    if (error) notify(ctx, error);
  }));

  pi.on("session_shutdown", reporting(async event => {
    stopWatching();
    clearTimeout(again);
    const leaving = me;
    me = undefined;
    if (leaving && event.reason === "quit") await core.leave({ terminal, pid }, io);
  }));

  pi.on("session_info_changed", reporting(async (event, ctx) => {
    if (!me || event.name === me.title) return;
    if (event.name) await named(me, event.name, ctx);
    else show(me);
  }));

  pi.on("input", reporting(async event => {
    if (!me || event.source !== "interactive") return;
    typing = true;
    const { content } = await core.typed({ id: me.id, text: event.text }, io);
    if (content) pi.sendMessage({ customType: TYPED, content, display: false }, { triggerTurn: false });
  }));

  pi.on("before_agent_start", reporting(async event => {
    if (!me) return;
    const { session } = core.current({ id: me.id });
    show(session);
    if (session) event.systemPromptOptions.sections.projects = agent.instructions(session);
  }));

  pi.on("turn_start", reporting((_event, ctx) => look(ctx)));

  // A run that is stopping takes no mail. Esc during a tool still ends the turn as completed, with the run's signal aborted.
  pi.on("turn_end", reporting(async (event, ctx) => {
    if (!me || event.outcome !== "completed" || ctx.signal?.aborted) return;
    const mail = due(read(me, ctx), ctx);
    if (!mail.length) return;
    return { entries: [...event.entries, ...mail.map(entryOf)], continue: event.continue || mail.some(item => item.type === "message") };
  }));

  pi.on("agent_settled", reporting(async (event, ctx) => {
    if (!me) return;
    starting = undefined;
    const answer = typing && !event.aborted ? lastAnswer(ctx) : undefined;
    typing = false;
    if (answer) core.answered({ id: me.id, text: answer });
    later(ctx);
  }));

  pi.registerMessageRenderer<Shown>(MESSAGE, (message, options, theme) => {
    const { from, fromTitle, text, attached } = message.details!;
    return mailLine(theme, `from ${who(from, fromTitle)}`, text, quoted(attached, theme.fg("dim", ATTACHED)), options.expanded, options.outputPad);
  });

  for (const tool of agent.tools) {
    pi.registerTool({
      name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, defaultActive: false,
      async execute(_call, args) {
        const value = await agent.act({ id: me?.id, tool: tool.name, args }, io);
        if (me) show(core.current({ id: me.id }).session);
        return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
      },
      renderCall(args: Args, theme: Theme, context: { expanded: boolean }) {
        const send = sent[tool.name]?.(args);
        if (!send) return toolLine(theme, tool.name, objects[tool.name]?.(args));
        const notes = send.attach.length ? [theme.fg("dim", `${send.attach.length} of your messages attached`)] : [];
        return mailLine(theme, send.who, send.text, notes, context.expanded);
      },
      renderResult: (result: Result, options: { expanded: boolean }, theme: Theme, context: { isError: boolean }) =>
        under(theme, tool.name, result, options.expanded, context.isError),
    });
  }

  pi.registerCommand("projects", {
    description: "new [name] makes this session a project",
    handler: reporting(async (args: string, ctx) => {
      const [verb, ...name] = args.trim().split(/\s+/);
      if (verb !== "new") return ctx.ui.notify(usage, "info");
      if (!me) throw new Error("this needs interactive pi in a herdr terminal, with a saved conversation");
      const { session } = await core.project({ id: me.id, title: name.join(" ") || undefined }, io);
      show(session);
      ctx.ui.notify(`${session.title} is now a project.`, "info");
    }),
  });
}
