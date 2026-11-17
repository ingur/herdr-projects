import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { role, tools } from "../core/roles.mjs";

type Session = { id: string; role: "coordinator" | "thread"; title: string; titleSource: string; resolved: boolean };

const usage = "Use /projects new [name] to make this conversation a project.";
const control = fileURLToPath(new URL("../core/control.mjs", import.meta.url));

function core(action: string, options: object): Promise<any> {
  const { promise, resolve, reject } = Promise.withResolvers<any>();
  const child = execFile("node", [control, action], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim().replace(/^projects: /, "") || error.message));
    else resolve(JSON.parse(stdout));
  });
  child.stdin?.end(JSON.stringify(options));
  return promise;
}

export default function projects(pi: ExtensionAPI) {
  const terminal = process.env.HC_TERMINAL_ID, pid = process.pid;
  let id: string | undefined;

  const inTerminal = (ctx: ExtensionContext) => Boolean(terminal) && ctx.mode === "tui" && ctx.agent?.kind !== "sub";
  const arrival = (ctx: ExtensionContext) => ({
    terminal, pid, agent: "omp", env: process.env,
    conversation: { id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() },
  });

  async function show(session?: Session) {
    id = session?.id;
    const mine = tools.filter(tool => session && tool.roles.includes(session.role)).map(tool => tool.name);
    const others = pi.getActiveTools().filter(name => !tools.some(tool => tool.name === name));
    await pi.setActiveTools([...others, ...mine]);
    if (session && session.title !== pi.getSessionName()) await pi.setSessionName(session.title);
  }

  async function current() {
    const { session } = await core("session", { terminal, pid });
    await show(session);
    return session as Session | undefined;
  }

  const reporting = <Event>(handle: (event: Event, ctx: ExtensionContext) => Promise<unknown>) =>
    async (event: Event, ctx: ExtensionContext) => {
      try { return await handle(event, ctx); }
      catch (error) { ctx.ui.notify(`Projects: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    };

  async function enter(ctx: ExtensionContext, replaced: boolean) {
    if (!inTerminal(ctx)) return;
    const { session } = await core("enter", { ...arrival(ctx), replaced });
    await show(session);
  }

  pi.on("session_start", reporting((_event, ctx) => enter(ctx, false)));
  pi.on("session_switch", reporting((event, ctx) => enter(ctx, event.reason !== "resume")));
  pi.on("session_branch", reporting((_event, ctx) => enter(ctx, true)));

  pi.on("session_shutdown", reporting(async () => {
    if (id) await core("leave", { terminal, pid });
  }));

  pi.on("input", reporting(async event => {
    if (!id || event.source !== "interactive") return;
    const session = await current();
    if (session?.resolved) await core("unresolve", { id: session.id });
  }));

  pi.on("before_agent_start", reporting(async event => {
    const session = id && await current();
    if (session) return { systemPrompt: [...event.systemPrompt, role(session)] };
  }));

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
      defaultInactive: true, loadMode: "essential",
      async execute(_call, args) {
        const value = await core("act", { as: id, tool: tool.name, args });
        return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
      },
    });
  }

  pi.registerCommand("projects", {
    description: "new [name] makes this conversation a project",
    handler: reporting(async (args: string, ctx) => {
      const [verb, ...name] = args.trim().split(/\s+/);
      if (verb !== "new") return ctx.ui.notify(usage, "info");
      if (!inTerminal(ctx)) throw new Error("this needs interactive omp in a herdr terminal");
      if (!ctx.sessionManager.getSessionFile()) throw new Error("this needs a saved omp session; do not use --no-session");
      const { session } = await core("create", { ...arrival(ctx), cwd: ctx.cwd, title: name.join(" ") || pi.getSessionName() });
      await show(session);
      ctx.ui.notify(`Project ${session.title} uses this conversation.`, "info");
    }),
  });
}
