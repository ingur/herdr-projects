import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeError, renameSchema, sendSchema, startSchema, targetSchema } from "../core/contracts.ts";
import { toolDescriptions } from "./prompts.mjs";
import { createSessionRuntime } from "./session.ts";
import { sessionId } from "../core/lib/state.mjs";
import { renameThread, reopenThread, resolveThread, sendThread, startThread } from "./threads.ts";
import { listThreads } from "./pi-catalog.mjs";
import { dormantHint } from "./registration.mjs";

const help = [
  "/projects init [name] (promote this plugin-enabled Pi conversation to a project)",
  "/projects (project and thread status)",
  "/projects resume (resume inbox delivery, not terminal lifetime)",
  "/projects retry MESSAGE_UUID (explicitly retries an uncertain injection; may duplicate work)",
].join("\n");

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

  pi.registerCommand("projects", {
    description: "Projects: status, init, resume, retry",
    handler: async (args, ctx) => {
      const [verb = ""] = args.trim().split(/\s+/);
      const body = args.trim().slice(verb.length).trim();
      try {
        if (verb === "init") {
          const current = await session.init(ctx, body || undefined);
          if (current) ctx.ui.notify(`Project ${current.title} uses this conversation (${current.id}).`, "info");
          return;
        }
        if (session.independent()) { ctx.ui.notify(dormantHint, "info"); return; }
        const r = session.bound(ctx);
        r.lastInteraction = Date.now();
        let value: unknown;
        if (!verb) value = await listThreads(r);
        else if (verb === "resume" && !body) {
          session.pause(r, false, "Human /projects resume");
          value = { paused: r.paused };
        } else if (verb === "retry") {
          sessionId(body);
          const state = session.reconcileDelivery(r).find(item => item.message.id === body);
          if (!state || state.delivery.state !== "uncertain") throw new Error("Only an uncertain attempt may be retried; visible/recorded messages are never replayed");
          r.store.mark(r.id, body, { state: "retry-authorized", execution: "unknown" });
          session.pause(r, false, "Human explicitly authorized retry (possible duplicate work)");
          value = { message: body, retry: "authorized", warning: "Previous processing is unknown; retry may duplicate work" };
        } else throw new Error(help);
        ctx.ui.notify(JSON.stringify(value, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(`Projects: ${describeError(error)}`, !verb && session.independent() ? "info" : "error");
      }
    },
  });
}
