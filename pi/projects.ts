import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { actions, findRecord, readRecord, stateDirectory } from "../core/control.mjs";
import { ENV } from "./adapter.mjs";
import { section, tools } from "./prompts.mjs";
import { resumeProject } from "./resume.ts";

type Role = "coordinator" | "thread";
type Binding = { id: string; role: Role; stateDir: string; watcher: FSWatcher };

const roleTools: Record<Role, string[]> = {
  coordinator: ["thread_start", "thread_list", "thread_send", "thread_rename", "thread_resolve"],
  thread: ["thread_list", "thread_send", "thread_rename"],
};
const hint = "Use /projects new [name] to make this conversation a project, or /projects resume [name] to resume one here.";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// How this Pi was started, so its threads start the same way.
function piCommand() {
  const override = process.env.PROJECTS_PI_COMMAND;
  const command = override ? JSON.parse(override) : [process.execPath, ...process.execArgv, ...(process.argv[1] ? [resolve(process.argv[1])] : [])];
  if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== "string")) throw new Error("PROJECTS_PI_COMMAND must be a JSON array of strings.");
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] !== "-e" && process.argv[i] !== "--extension") continue;
    const extension = process.argv[++i];
    command.push("-e", existsSync(extension) ? resolve(extension) : extension);
  }
  return command;
}

function adapter(ctx: ExtensionContext, stateDir: string) {
  const env: Record<string, string> = {};
  for (const name of ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.PROJECTS_STATE_DIR = stateDir;
  return { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), command: piCommand(), env };
}

function piRecord(stateDir: string, key: "sessionId" | "sessionFile", value: string) {
  return findRecord(stateDir, record => record.agent === "pi" && record.adapter?.[key] === value);
}

function ownRecord(event: SessionStartEvent, ctx: ExtensionContext, stateDir: string) {
  if (event.reason === "startup" && process.env.PROJECTS_SESSION) return readRecord(stateDir, process.env.PROJECTS_SESSION);
  // /new and /fork take the project along to the new conversation.
  const followed = (event.reason === "new" || event.reason === "fork") && event.previousSessionFile
    && piRecord(stateDir, "sessionFile", event.previousSessionFile);
  return followed || piRecord(stateDir, "sessionId", ctx.sessionManager.getSessionId());
}

const status = view => view.state === "running" ? view.status : view.state;
const brief = view => ({ id: view.id, title: view.title, ...(view.resolved ? { resolved: true } : {}) });

async function project(id: string) {
  const { sessions } = await actions.list({});
  const me = sessions.find(view => view.id === id);
  if (!me) throw new Error("This session is no longer in a project.");
  return { me, sessions: sessions.filter(view => view.coordinator === me.coordinator) };
}

function find(target: string, me, sessions) {
  const view = target === "coordinator" ? sessions.find(view => view.id === me.coordinator)
    : sessions.find(view => view.id === target) ?? sessions.find(view => view.role === "thread" && view.title.toLowerCase() === target.toLowerCase());
  if (!view) throw new Error(`No session "${target}" in this project. Call thread_list for titles and session ids.`);
  return view;
}

export default function projects(pi: ExtensionAPI) {
  let bound: Binding | undefined;

  // Pi restores a conversation's tools from its transcript, so set them on every start and tree move.
  function applyTools() {
    const active = pi.getActiveTools();
    const next = [...active.filter(name => !roleTools.coordinator.includes(name)), ...(bound ? roleTools[bound.role] : [])];
    if (next.length !== active.length || next.some(name => !active.includes(name))) pi.setActiveTools(next);
  }

  function syncTitle() {
    const record = bound && readRecord(bound.stateDir, bound.id);
    if (record && record.title !== pi.getSessionName()) pi.setSessionName(record.title);
  }

  function bind(stateDir: string, { id, role }: { id: string; role: Role }) {
    // Core replaces the record file on every write, so watch its directory for that one name.
    const watcher = watch(join(stateDir, "sessions"), (_event, file) => { if (file === `${id}.json`) syncTitle(); });
    bound = { id, role, stateDir, watcher };
    applyTools();
    syncTitle();
  }

  function unbind() {
    bound?.watcher.close();
    bound = undefined;
  }

  // `id` set: a project closed before its first turn has no conversation to switch to, and takes this one.
  async function promote(ctx: ExtensionCommandContext, name: string, id?: string) {
    const stateDir = stateDirectory();
    if (bound || piRecord(stateDir, "sessionId", ctx.sessionManager.getSessionId())) throw new Error("This conversation is already in a project.");
    if (!ctx.sessionManager.getSessionFile()) throw new Error("Projects needs a saved Pi session; do not use --no-session.");
    const view = await actions.register({ ...(id ? { id } : { title: name || pi.getSessionName() }), cwd: ctx.cwd, agent: "pi", adapter: adapter(ctx, stateDir), terminal: process.env.HC_TERMINAL_ID, pid: process.pid });
    bind(stateDir, view);
    ctx.ui.notify(`Project ${view.title} uses this conversation.`, "info");
  }

  pi.on("session_start", async (event, ctx) => {
    const terminal = process.env.HC_TERMINAL_ID;
    const stateDir = ctx.mode === "tui" && terminal ? stateDirectory() : undefined;
    const record = stateDir && ownRecord(event, ctx, stateDir);
    if (!record) return applyTools();
    const data = adapter(ctx, stateDir);
    bind(stateDir, record);
    const binding = bound;
    // register returns once waiting mail is typed, which needs this Pi running, so do not wait for it.
    actions.register({ id: record.id, cwd: ctx.cwd, agent: "pi", adapter: data, terminal, pid: process.pid }).catch(error => {
      if (bound !== binding) return;
      unbind();
      applyTools();
      ctx.ui.notify(`Projects: ${message(error)}`, "error");
    });
  });

  pi.on("session_tree", () => applyTools());

  pi.on("session_shutdown", async event => {
    const id = bound?.id;
    unbind();
    // On /new and /fork the project stays in this terminal; session_start registers the new conversation.
    if (id && (event.reason === "quit" || event.reason === "resume")) await actions.release({ id });
  });

  pi.on("session_info_changed", async (event, ctx) => {
    if (!bound || !event.name) return;
    const record = readRecord(bound.stateDir, bound.id);
    if (!record || record.title === event.name) return;
    try {
      await actions.rename({ id: record.id, title: event.name, by: "user" });
    } catch (error) {
      ctx.ui.notify(`Projects: ${message(error)}`, "error");
      pi.setSessionName(record.title);
    }
  });

  pi.on("input", async (event, ctx) => {
    const b = bound;
    if (!b || event.source !== "interactive" || !readRecord(b.stateDir, b.id)?.resolved) return;
    try { await actions.reopen({ id: b.id }); }
    catch (error) { ctx.ui.notify(`Projects: ${message(error)}`, "error"); }
  });

  pi.on("before_agent_start", event => {
    const record = bound && readRecord(bound.stateDir, bound.id);
    if (record) event.systemPromptOptions.sections.projects = section(record.role, record.titleSource);
  });

  function tool(name: keyof typeof tools, label: string, parameters: TSchema, run: (b: Binding, args) => Promise<object>) {
    pi.registerTool({
      name, label, description: tools[name].description, parameters, defaultActive: false,
      async execute(_id, args) {
        if (!bound) throw new Error(hint);
        const value = await run(bound, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
      },
    });
  }

  tool("thread_start", "Start project thread", Type.Object({
    title: Type.String({ minLength: 1, maxLength: 80, description: tools.thread_start.title }),
    instruction: Type.String({ minLength: 1, maxLength: 100000, description: tools.thread_start.instruction }),
    cwd: Type.Optional(Type.String({ description: tools.thread_start.cwd })),
  }, { additionalProperties: false }), async (b, args) => {
    const view = await actions["create-thread"]({ coordinator: b.id, title: args.title, cwd: args.cwd, by: "agent", text: args.instruction });
    const note = view.existing ? "A thread with this title already exists, so the instruction was not sent. Use thread_send to message it."
      : view.error ? `The thread could not be started: ${view.error}. The instruction is saved and goes out when the thread starts.`
      : view.waiting ? "The thread is starting; the instruction goes out when it is up. Its report will arrive here as a message."
      : "The thread has the instruction. Its report will arrive here as a message.";
    return { id: view.id, title: view.title, cwd: view.cwd, status: status(view), note };
  });

  tool("thread_list", "List project threads", Type.Object({}, { additionalProperties: false }), async b => {
    const { me, sessions } = await project(b.id);
    return { you: me.id, sessions: sessions.map(view => ({ id: view.id, title: view.title, role: view.role, status: status(view), ...(view.resolved ? { resolved: true } : {}) })) };
  });

  tool("thread_send", "Send project message", Type.Object({
    target: Type.String({ minLength: 1, maxLength: 200, description: tools.thread_send.target }),
    text: Type.String({ minLength: 1, maxLength: 100000, description: tools.thread_send.text }),
  }, { additionalProperties: false }), async (b, args) => {
    const { me, sessions } = await project(b.id);
    const target = find(args.target, me, sessions);
    if (target.id === me.id) throw new Error("Send to another session, not yourself.");
    const sent = await actions.send({ to: target.id, from: me.id, text: args.text });
    return { sent: sent.sent, to: target.title, id: target.id, ...(sent.note ? { note: sent.note } : {}) };
  });

  tool("thread_rename", "Rename project thread", Type.Object({
    target: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: tools.thread_rename.target })),
    title: Type.String({ minLength: 1, maxLength: 80, description: tools.thread_rename.title }),
  }, { additionalProperties: false }), async (b, args) => {
    const { me, sessions } = await project(b.id);
    const target = args.target === undefined ? me : find(args.target, me, sessions);
    if (target.id !== me.id && me.role !== "coordinator") throw new Error("A thread can rename only itself. Leave out target.");
    return brief(await actions.rename({ id: target.id, title: args.title, by: "agent" }));
  });

  tool("thread_resolve", "Resolve project thread", Type.Object({
    target: Type.String({ minLength: 1, maxLength: 200, description: tools.thread_resolve.target }),
  }, { additionalProperties: false }), async (b, args) => {
    const { me, sessions } = await project(b.id);
    return brief(await actions.resolve({ id: find(args.target, me, sessions).id, by: "agent", from: me.id }));
  });

  const verbs = {
    new: "make this conversation a project",
    resume: "resume a stopped project in this terminal",
  };
  pi.registerCommand("projects", {
    description: "new [name] makes this conversation a project; resume [name] resumes a stopped project here",
    getArgumentCompletions: (prefix: string) => {
      const items = Object.entries(verbs).filter(([verb]) => verb.startsWith(prefix)).map(([value, description]) => ({ value, label: value, description }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [verb = ""] = args.trim().split(/\s+/);
      const body = args.trim().slice(verb.length).trim();
      if (verb !== "new" && verb !== "resume") return ctx.ui.notify(hint, "info");
      if (ctx.mode !== "tui" || !process.env.HC_TERMINAL_ID) {
        return ctx.ui.notify(`Projects needs interactive Pi in an hc terminal. Open one with hc, run pi there, then use /projects ${verb}.`, "error");
      }
      try {
        if (verb === "resume") {
          const unsaved = await resumeProject(ctx, body);
          if (unsaved) await promote(ctx, "", unsaved);
          return;
        }
        await promote(ctx, body);
      }
      catch (error) { ctx.ui.notify(`Projects: ${message(error)}`, "error"); }
    },
  });
}
