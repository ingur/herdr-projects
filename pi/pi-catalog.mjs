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
    guarantee: "recorded means a custom entry is observed in Pi's file, not successful model processing. An uncertain attempt is redelivered once with a visible repeat warning; another interruption leaves it possibly undelivered. Exactly-once execution is not claimed.",
  };
}

// What `/projects` prints: the project, its threads and what is waiting, in a few lines.
export function statusText(summary, waitingMessages = 0, possiblyUndelivered = 0) {
  const state = session => session.resolved ? "resolved" : session.availability.registration === "registered" ? (session.availability.paused ? "paused" : "running") : "stopped";
  const project = summary.sessions.find(session => session.id === summary.coordinator);
  const threads = summary.sessions.filter(session => session.role === "thread" && session.coordinator === summary.coordinator);
  const width = Math.max(0, ...threads.map(thread => thread.title.length));
  return [
    `${project?.title ?? "Project"}  ${summary.projectRoot}`,
    ...threads.map(thread => `  ${thread.title.padEnd(width)}  ${state(thread)}${thread.id === summary.current ? "  (this session)" : ""}`),
    ...(threads.length ? [] : ["  no threads yet"]),
    ...(summary.paused ? ["Incoming messages wait until your next prompt."] : []),
    ...(waitingMessages ? [`${waitingMessages} message${waitingMessages > 1 ? "s" : ""} waiting for this session.`] : []),
    ...(possiblyUndelivered ? [`${possiblyUndelivered} message${possiblyUndelivered > 1 ? "s" : ""} may not have arrived.`] : []),
    ...(summary.statusErrors ? [`Some sessions could not be read: ${summary.statusErrors.map(item => item.error).join("; ")}`] : []),
  ].join("\n");
}
