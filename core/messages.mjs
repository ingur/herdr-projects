export const MESSAGE_TYPE = "projects.message";

export function deliveryState(attempt, visibleEntry, persistedEntry) {
  if (persistedEntry) return { version: 1, state: "recorded", entry: persistedEntry, execution: "unknown" };
  if (visibleEntry) return { version: 1, state: "visible-not-durable", entry: visibleEntry, execution: "unknown" };
  if (attempt?.state === "retry-authorized" || attempt?.state === "pending") return { version: 1, state: "pending", execution: "unknown" };
  if (attempt) return { ...attempt, version: 1, state: "uncertain", execution: "unknown" };
  return { version: 1, state: "pending", execution: "not-requested" };
}

export function shouldReopen(record, settlingSession) {
  if (record?.resolved !== true) return false;
  if (settlingSession === undefined) return true;
  return record.role === "thread" && record.resolvedBy?.kind === "agent" &&
    typeof record.resolvedBy.session === "string" && record.resolvedBy.session !== settlingSession;
}
