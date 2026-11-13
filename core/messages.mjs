export const MESSAGE_TYPE = "projects.message";

export function deliveryState(attempt, visibleEntry, persistedEntry) {
  const repeated = attempt?.redelivered ? { redelivered: true } : {};
  if (persistedEntry) return { version: 1, state: "recorded", entry: persistedEntry, execution: "unknown", ...repeated };
  if (visibleEntry) return { version: 1, state: "visible-not-durable", entry: visibleEntry, execution: "unknown", ...repeated };
  if (attempt?.state === "pending") return { ...attempt, version: 1 };
  if (attempt) return { ...attempt, version: 1, state: "uncertain", execution: "unknown" };
  return { version: 1, state: "pending", execution: "not-requested" };
}

export function waitingDelivery(delivery) {
  return delivery.state === "pending" || delivery.state === "uncertain" && !delivery.redelivered;
}

export function deliveryAttempt(delivery, execution) {
  return { state: "attempting", attempted: new Date().toISOString(), execution,
    ...(delivery.redelivered || delivery.state === "uncertain" ? { redelivered: true } : {}) };
}

export function shouldReopen(record, settlingSession) {
  if (record?.resolved !== true) return false;
  if (settlingSession === undefined) return true;
  return record.role === "thread" && record.resolvedBy?.kind === "agent" &&
    typeof record.resolvedBy.session === "string" && record.resolvedBy.session !== settlingSession;
}
