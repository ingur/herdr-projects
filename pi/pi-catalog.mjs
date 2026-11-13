import { listSessions } from "../core/control.mjs";
import { sourceReferences } from "./messages.mjs";

export async function listThreads(r, own, io = {}) {
  const snapshot = await listSessions({ stateDir: r.stateDir, projectRoot: r.projectRoot }, io);
  const sessions = snapshot.sessions.map(view => ({
    id: view.id, title: view.title, role: view.role, coordinator: view.coordinator, resolved: view.resolved,
    availability: { registration: view.registration, terminalState: view.terminalState, paused: view.paused,
      ...(view.error ? { error: view.error } : {}) },
  }));
  const summary = { current: r.id, coordinator: r.coordinator, projectRoot: r.projectRoot,
    paused: r.store.control(r.id).paused, sessions, ...(snapshot.errors ? { statusErrors: snapshot.errors } : {}) };
  if (own === undefined) return summary;
  return {
    ...summary,
    sessions: sessions.map(view => {
      const record = r.store.record(view.id);
      const deliveries = r.store.messages(record.id).map(message => ({
        message: message.id, sender: message.sender, state: r.store.delivery(record.id, message.id)?.state || "pending", execution: "unknown",
      }));
      return { ...view, deliveries, initialMessage: record.initial?.id,
        initialState: record.initial && !deliveries.some(message => message.message === record.initial.id) ? "waiting-for-registration" : undefined };
    }),
    sourceMessages: sourceReferences(r.ctx.sessionManager.getEntries()),
    sourceNote: "forward takes an entry ID from this session; original text and attribution are recovered in code.",
    inbox: own.map(item => ({ id: item.message.id, ...item.delivery })),
    guarantee: "recorded means a custom entry is observed in Pi's file, not successful model processing. Uncertain attempts require explicit /projects retry; exactly-once execution is not claimed.",
  };
}
