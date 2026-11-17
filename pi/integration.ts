import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { actions } from "../core/control.mjs";
import { role, tools } from "../core/roles.mjs";

type Session = { id: string; role: "coordinator" | "thread"; title: string; titleSource: string; resolved: boolean; error?: string };

const usage = "Use /projects new [name] to make this conversation a project.";

export default function projects(pi: ExtensionAPI) {
  const terminal = process.env.HC_TERMINAL_ID, pid = process.pid;
  let id: string | undefined;

  const inTerminal = (ctx: ExtensionContext) => Boolean(terminal) && ctx.mode === "tui";
  const arrival = (ctx: ExtensionContext) => ({
    terminal, pid, agent: "pi", env: process.env,
    conversation: { id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() },
  });

  function show(session?: Session) {
    id = session?.id;
    const mine = tools.filter(tool => session && tool.roles.includes(session.role)).map(tool => tool.name);
    const others = pi.getActiveTools().filter(name => !tools.some(tool => tool.name === name));
    pi.setActiveTools([...others, ...mine]);
    if (session && session.title !== pi.getSessionName()) pi.setSessionName(session.title);
  }

  async function current() {
    const { session } = await actions.session({ terminal, pid });
    show(session);
    return session as Session | undefined;
  }

  const reporting = <Event>(handle: (event: Event, ctx: ExtensionContext) => Promise<unknown>) =>
    async (event: Event, ctx: ExtensionContext) => {
      try { return await handle(event, ctx); }
      catch (error) { ctx.ui.notify(`Projects: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    };

  pi.on("session_start", reporting(async (event, ctx) => {
    if (!inTerminal(ctx)) return show();
    const { session } = await actions.enter({ ...arrival(ctx), replaced: event.reason === "new" || event.reason === "fork" });
    show(session);
  }));

  pi.on("session_shutdown", reporting(async event => {
    if (id && event.reason === "quit") await actions.leave({ terminal, pid });
  }));

  pi.on("input", reporting(async event => {
    if (!id || event.source !== "interactive") return;
    const session = await current();
    if (session?.resolved) await actions.unresolve({ id: session.id });
  }));

  pi.on("before_agent_start", reporting(async event => {
    const session = id && await current();
    if (session) event.systemPromptOptions.sections.projects = role(session);
  }));

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, defaultActive: false,
      async execute(_call, args) {
        const value = await actions.act({ as: id, tool: tool.name, args });
        return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
      },
    });
  }

  pi.registerCommand("projects", {
    description: "new [name] makes this conversation a project",
    handler: reporting(async (args: string, ctx) => {
      const [verb, ...name] = args.trim().split(/\s+/);
      if (verb !== "new") return ctx.ui.notify(usage, "info");
      if (!inTerminal(ctx)) throw new Error("this needs interactive Pi in a herdr terminal");
      if (!ctx.sessionManager.getSessionFile()) throw new Error("this needs a saved Pi session; do not use --no-session");
      const { session } = await actions.create({ ...arrival(ctx), cwd: ctx.cwd, title: name.join(" ") || pi.getSessionName() });
      show(session);
      ctx.ui.notify(`Project ${session.title} uses this conversation.`, "info");
    }),
  });
}
