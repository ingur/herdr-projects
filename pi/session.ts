import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { describeError, getRecord, messages, parse, recordSchema, terminalSchema, type DeliveryView } from "../core/contracts.ts";
import type { Runtime } from "./types.ts";
import { MESSAGE_TYPE, deliveryState, shouldReopen } from "../core/messages.mjs";
import { receiptEntries } from "./messages.mjs";
import { mayDeliver } from "../core/lib/delivery.mjs";
import { formatEnvelope, roleInstructions, wakeInstruction } from "./prompts.mjs";
import { Store, stateDirectory } from "../core/store.mjs";
import { canonicalPath, sessionId } from "../core/lib/state.mjs";
import { LOCAL_TERMINAL, terminalPlacement } from "../core/hc.mjs";
import { command } from "./threads.ts";
import { publishControlDescriptor, renameSession, reopenSession } from "../core/control.mjs";
import { observeEditor } from "./interaction.ts";
import { PROJECT_TOOLS, acquireSessionLocks, dormantHint, findSessionRecord, isWriterConflict, messageNeedsTurn, observeTranscript, registerCurrentSession, sessionSwitchDecision, unregisterCurrentSession } from "./registration.mjs";
import { writeLaunchShims } from "./pi-launch.mjs";

export function createSessionRuntime(pi: ExtensionAPI) {
  let runtime: Runtime | undefined;
  let failure = dormantHint;
  let poll: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;

  function bound(ctx: ExtensionContext): Runtime {
    if (!runtime || runtime.id !== ctx.sessionManager.getSessionId()) throw new Error(failure);
    return runtime;
  }

  function updateStatus(r: Runtime, message: string) {
    if (r.lastStatus !== message) {
      r.ctx.ui.setStatus("projects", `projects: ${message}`);
      r.lastStatus = message;
    }
  }

  function pause(r: Runtime, paused: boolean, reason: string): void {
    r.store.control(r.id, { paused, reason, at: new Date().toISOString() });
    r.paused = paused;
  }

  // Undo a saved registration: editor observation, an honest offline record, then the writer locks.
  function unregister(r: Runtime) {
    r.editor?.release();
    try {
      unregisterCurrentSession(r.store, { id: r.id, sessionFile: r.sessionFile });
    } finally { for (const lock of r.locks.reverse()) lock.release(); }
  }

  function cleanup() {
    generation++;
    pi.setActiveTools(pi.getActiveTools().filter(name => !PROJECT_TOOLS.includes(name)));
    humanTurn = false;
    clearInterval(poll);
    poll = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    const r = runtime;
    runtime = undefined;
    if (!r) return;
    r.ctx.ui.setStatus("projects", undefined);
    unregister(r);
  }

  function receipts(r: Runtime) {
    const visible = receiptEntries(r.ctx.sessionManager.getEntries(), r.id);
    // Pi appends synchronously and rolls memory back on write failure; setup-only sessions have no file.
    return { visible, persisted: existsSync(r.sessionFile) ? visible : new Map<string, string>() };
  }

  function reconcileDelivery(r: Runtime): DeliveryView[] {
    const inbox = messages(r.store, r.id, r.recorded);
    if (!inbox.length) return [...r.recorded.values()];
    const { visible, persisted } = receipts(r);
    const recorded = [...r.recorded.values()];
    const states = inbox.map(message => {
      if (message.projectRoot !== r.projectRoot || message.recipient !== r.id) throw new Error("Inbox message project/session mismatch; refusing injection");
      const previous = r.store.delivery(r.id, message.id);
      const state = deliveryState(previous, visible.get(message.id), persisted.get(message.id));
      if (previous && JSON.stringify(previous) !== JSON.stringify(state)) r.store.mark(r.id, message.id, state);
      if (state.state === "recorded") r.recorded.set(message.id, { message, delivery: state });
      return { message, delivery: state };
    });
    return recorded.concat(states);
  }
  function setSessionName(r: Runtime, title: string) {
    r.pendingTitle = title;
    pi.setSessionName(title);
  }

  function deliverInformational(r: Runtime, pending: DeliveryView[]) {
    if (!mayDeliver({ modelSelected: true, idle: r.ctx.isIdle(), focused: r.editor?.focused === true,
      pending: r.ctx.hasPendingMessages(), draft: r.ctx.ui.getEditorText(), lastInteraction: r.lastInteraction,
      paused: r.paused, promptOpen: r.promptOpen, inFlight: r.inFlight })) return false;
    const message = pending.find(item => !messageNeedsTurn(item.message))?.message;
    if (!message) return false;
    r.store.mark(r.id, message.id, { state: "attempting", attempted: new Date().toISOString(), execution: "not-requested" });
    pi.sendMessage({ customType: MESSAGE_TYPE, content: formatEnvelope(message), display: true, details: { envelope: message } }, { triggerTurn: false });
    return true;
  }

  function tick(r: Runtime) {
    if (runtime !== r) return;
    try {
      bound(r.ctx);
      if (!r.transcriptObserved) r.transcriptObserved = observeTranscript(r.store, r);
      const title = getRecord(r.store, r.id)?.title;
      if (title && title !== r.title) {
        r.title = title;
        setSessionName(r, title);
      }
      const states = reconcileDelivery(r);
      const uncertain = states.filter(item => item.delivery.state === "uncertain").length;
      const pending = states.filter(item => item.delivery.state === "pending");
      if (r.inFlight && r.ctx.isIdle() && Date.now() - r.wakeAt > 3000) {
        // sendMessage has no promise/error return; a failed preflight may emit no settled event.
        r.inFlight = false;
        pause(r, true, "Wake ended without an observed settlement; inspect Pi error, then /projects resume");
      }
      const model = r.ctx.model;
      const modelSelected = !!model && r.ctx.modelRegistry.find(model.provider, model.id) !== undefined;
      updateStatus(r, `${r.paused ? "paused; " : ""}${pending.length} pending${uncertain ? `; ${uncertain} uncertain (thread_list detail)` : ""}${!modelSelected && pending.length ? "; waiting for model (/login, then /model)" : ""}${r.editor?.focusUnavailable ? "; editor focus unavailable" : ""}`);
      if (deliverInformational(r, pending)) return;
      if (!pending.length || !mayDeliver({ modelSelected, idle: r.ctx.isIdle(), pending: r.ctx.hasPendingMessages(), draft: r.ctx.ui.getEditorText(),
        focused: r.editor?.focused === true, lastInteraction: r.lastInteraction, paused: r.paused, promptOpen: r.promptOpen, inFlight: r.inFlight })) return;
      const message = pending.find(item => messageNeedsTurn(item.message))?.message;
      if (!message) return;
      r.store.mark(r.id, message.id, { state: "attempting", attempted: new Date().toISOString(), execution: "unknown" });
      r.inFlight = true;
      r.wakeAt = Date.now();
      // First make the attributed notice visible even if provider authentication prevents a turn.
      pi.sendMessage({ customType: MESSAGE_TYPE, content: formatEnvelope(message), display: true, details: { envelope: message } }, { triggerTurn: false });
      const receipt = receipts(r).visible.get(message.id);
      if (!receipt) {
        pause(r, true, "Injection uncertain; inspect thread_list with detail");
        r.inFlight = false;
        return;
      }
      pi.sendMessage({ customType: "projects.wake", content: wakeInstruction(message.id), display: false,
        details: { message: message.id } }, { triggerTurn: true });
    } catch (error) {
      updateStatus(r, `error: ${describeError(error)}`);
      if (r.lastError !== describeError(error)) r.ctx.ui.notify(`Projects: ${describeError(error)}`, "error");
      r.lastError = describeError(error);
    }
  }

  async function register(ctx: ExtensionContext, promote = false, requestedTitle?: string) {
    if (promote && runtime) {
      if (runtime.role !== "coordinator") throw new Error("This conversation is already registered as a thread");
      return bound(ctx);
    }
    cleanup();
    const currentGeneration = generation;
    const locks: Runtime["locks"] = [];
    let registered: Runtime | undefined; // saved as registered but not yet live
    try {
      const stateDir = stateDirectory();
      const id = sessionId(ctx.sessionManager.getSessionId());
      const previous = findSessionRecord(stateDir, id);
      if (!previous && !promote) { failure = dormantHint; return; }
      if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Projects requires interactive Pi, not print/RPC mode");
      const terminalId = process.env.HC_TERMINAL_ID;
      if (!terminalId || !LOCAL_TERMINAL.test(terminalId)) throw new Error("Projects needs an hc terminal. Open one with hc, run pi there, then use /projects init.");
      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionDir = ctx.sessionManager.getSessionDir();
      if (!sessionFile) throw new Error("Projects needs a persistent Pi session; do not use --no-session.");
      const projectRoot = previous?.projectRoot ?? canonicalPath(ctx.cwd);
      const store = new Store(stateDir, projectRoot);
      locks.push(...acquireSessionLocks(stateDir, store, id));
      const terminal = await command("hc", ["get", terminalId, "--json"], terminalSchema);
      if (generation !== currentGeneration) { for (const lock of locks.reverse()) lock.release(); return; }
      if (terminal.address !== terminalId || terminal.state !== "live") throw new Error("hc could not confirm this live terminal identity");
      const { space, tab } = terminalPlacement(terminal);
      writeLaunchShims(stateDir);
      const saved = registerCurrentSession(store, { id, agent: "pi", promote,
        title: requestedTitle || ctx.sessionManager.getSessionName() || "coordinator",
        titleSource: requestedTitle || ctx.sessionManager.getSessionName() ? "human" : "placeholder", cwd: canonicalPath(ctx.cwd), terminal: terminalId,
        space, tab, sessionFile, sessionDir, owner: locks[0].owner });
      if (!saved) { for (const lock of locks.reverse()) lock.release(); return; }
      const record = parse(recordSchema, saved, "registered session");
      const { title, role, coordinator } = record;
      const control = store.control(id);
      const r: Runtime = { id, stateDir, projectRoot, role, coordinator, store, sessionFile, terminal: terminalId, space, title, locks, ctx,
        transcriptObserved: record.transcriptState === "expected", paused: control.paused,
        promptOpen: 0, lastInteraction: Date.now(), inFlight: false, wakeAt: 0, recorded: new Map() };
      registered = r;
      await publishControlDescriptor({ stateDir, projectRoot, id });
      if (generation !== currentGeneration) { unregister(r); return; }
      r.editor = observeEditor(ctx);
      runtime = r;
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...PROJECT_TOOLS])]);
      if (ctx.sessionManager.getSessionName() !== record.title) setSessionName(r, record.title);
      failure = "Session changed; use a new terminal for another conversation";
      // A launch claim alone never sends the initial instruction: only this registered recipient can.
      store.publishInitial(id);
      unsubscribe = ctx.ui.onTerminalInput(() => {
        r.lastInteraction = Date.now();
        return undefined;
      });
      poll = setInterval(() => tick(r), 750);
      poll.unref();
      updateStatus(r, `registered ${role} ${id.slice(0, 8)}${r.paused ? "; paused" : ""}`);
      ctx.ui.notify(`Projects registered as ${title} (${id}). /projects for commands.`, "info");
      tick(r);
      return r;
    } catch (error) {
      if (generation !== currentGeneration) {
        if (registered) unregister(registered); else for (const lock of locks.reverse()) lock.release();
        return;
      }
      if (runtime) cleanup(); else if (registered) unregister(registered); else for (const lock of locks.reverse()) lock.release();
      failure = `Projects disabled: ${describeError(error)}`;
      if (isWriterConflict(error)) {
        ctx.ui.notify("Another live or uncertain writer owns this project session. This Pi will close without changing the conversation; use its existing terminal.", "error");
        ctx.shutdown();
        return;
      }
      if (promote) throw error;
      ctx.ui.setStatus("projects", failure);
      ctx.ui.notify(failure, "error");
    }
  }

  pi.on("session_start", async (_event, ctx) => { await register(ctx); });
  pi.on("session_info_changed", async (event, ctx) => {
    const r = runtime;
    if (!r || r.id !== ctx.sessionManager.getSessionId()) return;
    if (r.pendingTitle !== undefined && event.name === r.pendingTitle) { r.pendingTitle = undefined; return; }
    try {
      const renamed = await renameSession({ stateDir: r.stateDir, projectRoot: r.projectRoot, id: r.id, title: event.name, by: "human" });
      if (runtime === r) r.title = renamed.title;
    } catch (error) {
      setSessionName(r, r.title);
      ctx.ui.notify(`Projects: ${describeError(error)}`, "error");
    }
  });

  pi.on("session_shutdown", () => cleanup());
  const denySwitch = (_event: unknown, ctx: ExtensionContext) => {
    const decision = sessionSwitchDecision(!!runtime);
    if (decision) ctx.ui.notify("This conversation is registered with Projects. Use a new terminal for another session; /reload is supported.", "warning");
    return decision;
  };
  pi.on("session_before_switch", denySwitch);
  pi.on("session_before_fork", denySwitch);

  // Only a turn that began with an open thread may undo a different session's agent resolution.
  const reopenForHuman = async (r: Runtime, settled = false) => {
    try {
      if (shouldReopen(getRecord(r.store, r.id), settled ? r.id : undefined)) {
        const reopened = await reopenSession({ stateDir: r.stateDir, projectRoot: r.projectRoot, id: r.id,
          ...(settled ? { afterHumanTurn: r.id } : {}) });
        if (reopened.error) r.ctx.ui.notify(`Projects: ${reopened.error}`, "error");
      }
      return !getRecord(r.store, r.id)?.resolved;
    } catch (error) {
      r.ctx.ui.notify(`Projects could not reopen this session: ${describeError(error)}`, "error");
      return false;
    }
  };
  let humanTurn = false;
  pi.on("input", async (event) => {
    const r = runtime;
    // Pi handles registered slash commands before input; skill/template prompts reach this hook.
    if (r && event.source === "interactive") {
      r.lastInteraction = Date.now();
      pause(r, false, "Human submitted a prompt");
      humanTurn = await reopenForHuman(r);
    }
    return { action: "continue" };
  });
  pi.on("ui_prompt_start", () => { if (runtime) runtime.promptOpen++; });
  pi.on("ui_prompt_end", () => {
    if (runtime) {
      runtime.promptOpen = Math.max(0, runtime.promptOpen - 1);
      runtime.lastInteraction = Date.now();
    }
  });
  pi.on("agent_settled", async (event) => {
    if (!runtime) return;
    runtime.inFlight = false;
    if (!runtime.transcriptObserved) runtime.transcriptObserved = observeTranscript(runtime.store, runtime);
    runtime.lastInteraction = Date.now();
    if (event.aborted) pause(runtime, true, "Agent run aborted; submit a prompt or /projects resume");
    if (humanTurn) {
      humanTurn = false;
      await reopenForHuman(runtime, true);
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!runtime || runtime.id !== ctx.sessionManager.getSessionId()) return;
    if (event.messageType === "custom") humanTurn = false;
    event.systemPromptOptions.sections.projects = roleInstructions(runtime.role, getRecord(runtime.store, runtime.id)?.titleSource);
  });

  return { bound, independent: () => !runtime, reconcileDelivery, pause, init: async (ctx: ExtensionContext, title?: string) => {
    return register(ctx, true, title);
  } };
}
