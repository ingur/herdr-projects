import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeError, renameSchema, sendSchema, startSchema, targetSchema } from "../core/contracts.ts";
import { toolDescriptions } from "./prompts.mjs";
import { createSessionRuntime } from "./session.ts";
import { renameThread, reopenThread, resolveThread, sendThread, startThread } from "./threads.ts";
import { listThreads, statusText } from "./pi-catalog.mjs";
import { dormantHint } from "./registration.mjs";
import { resumeProject } from "./resume.ts";
import { waitingDelivery } from "../core/messages.mjs";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

export default function projects(pi: ExtensionAPI) {
  const session = createSessionRuntime(pi);

  pi.registerTool({
    defaultActive: false,
    name: "thread_start", label: "Start project thread", description: toolDescriptions.start, parameters: startSchema,
    async execute(id, args, _signal, _update, ctx) {
      return result(await startThread(session.bound(ctx), args, id));
    },
  });
  pi.registerTool({
    defaultActive: false,
    name: "thread_list", label: "List project threads", description: toolDescriptions.list, parameters: Type.Object({ detail: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    async execute(_id, args, _signal, _update, ctx) {
      const r = session.bound(ctx);
      return result(await listThreads(r, args.detail ? session.reconcileDelivery(r) : undefined));
    },
  });
  pi.registerTool({
    defaultActive: false,
    name: "thread_send", label: "Send project message", description: toolDescriptions.send, parameters: sendSchema,
    async execute(_id, args, _signal, _update, ctx) {
      return result(await sendThread(session.bound(ctx), args));
    },
  });
  pi.registerTool({
    defaultActive: false,
    name: "thread_rename", label: "Rename project thread", description: toolDescriptions.rename, parameters: renameSchema,
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      return result(await renameThread(session.bound(ctx), args));
    },
  });
  pi.registerTool({
    defaultActive: false,
    name: "thread_resolve", label: "Resolve project thread", description: toolDescriptions.resolve, parameters: targetSchema,
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      return result(await resolveThread(session.bound(ctx), args));
    },
  });
  pi.registerTool({
    defaultActive: false,
    name: "thread_reopen", label: "Reopen project thread", description: toolDescriptions.reopen, parameters: targetSchema,
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      return result(await reopenThread(session.bound(ctx), args));
    },
  });

  const verbs = {
    new: "make this conversation a project",
    resume: "resume a stopped project in this terminal",
  };
  pi.registerCommand("projects", {
    description: "Project status; new [name] makes this conversation a project; resume [name] resumes a stopped project here",
    getArgumentCompletions: (prefix: string) => {
      const items = Object.entries(verbs).filter(([verb]) => verb.startsWith(prefix)).map(([value, description]) => ({ value, label: value, description }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [verb = ""] = args.trim().split(/\s+/);
      const body = args.trim().slice(verb.length).trim();
      if (verb === "resume") return resumeProject(ctx, body);
      if (verb && verb !== "new") { ctx.ui.notify(dormantHint, "info"); return; }
      try {
        if (verb === "new") {
          const current = await session.promote(ctx, body || undefined);
          if (current) ctx.ui.notify(`Project ${current.title} uses this conversation (${current.id}).`, "info");
          return;
        }
        if (session.independent()) { ctx.ui.notify(dormantHint, "info"); return; }
        const r = session.bound(ctx);
        r.lastInteraction = Date.now();
        const deliveries = session.reconcileDelivery(r);
        const waitingMessages = deliveries.filter(item => waitingDelivery(item.delivery)).length;
        const possiblyUndelivered = deliveries.filter(item => item.delivery.state === "uncertain" && item.delivery.redelivered).length;
        ctx.ui.notify(statusText(await listThreads(r), waitingMessages, possiblyUndelivered), "info");
      } catch (error) {
        ctx.ui.notify(`Projects: ${describeError(error)}`, !verb && session.independent() ? "info" : "error");
      }
    },
  });
}
