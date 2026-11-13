import { MESSAGE_TYPE } from "../core/messages.mjs";

export function receiptEntries(entries, recipient) {
  /** @type {Map<string, string>} */
  const result = new Map();
  for (const entry of entries) {
    const message = entry?.details?.envelope;
    if (entry?.type === "custom_message" && entry.customType === MESSAGE_TYPE && typeof entry.id === "string" &&
        message?.recipient === recipient && typeof message.id === "string") result.set(message.id, entry.id);
  }
  return result;
}

function exactText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some(part => part.type !== "text" || typeof part.text !== "string")) {
    throw new Error("Forwarding supports text-only entries; attachments are not silently dropped");
  }
  return content.map(part => part.text).join("");
}

export function forwardEntry(entry, id, title) {
  if (!entry) throw new Error("Source entry does not exist in this session");
  const ref = { session: id, entry: entry.id };
  if (entry.type === "message" && entry.message?.role === "user") {
    return { text: exactText(entry.message.content), author: { kind: "human", session: id, title }, source: ref, via: [] };
  }
  if (entry.type === "custom_message") {
    if (entry.customType === MESSAGE_TYPE && entry.details?.envelope) {
      const message = entry.details.envelope;
      return { text: message.text, author: message.author, source: message.source, via: [...(message.via || []), { ...ref, sender: message.sender, note: message.note }] };
    }
    return { text: exactText(entry.content), author: { kind: "custom", type: entry.customType, session: id, title }, source: ref, via: [] };
  }
  throw new Error("Only existing user or custom-message entries can be forwarded");
}

export function sourceReferences(entries) {
  return entries.filter(entry => (entry.type === "message" && entry.message?.role === "user") || entry.type === "custom_message")
    .filter(entry => entry.customType !== "projects.wake" && entry.customType !== "projects.command")
    .slice(-20).map(entry => ({ entry: entry.id, kind: entry.type === "message" ? "human" : "custom", customType: entry.customType,
      preview: typeof (entry.content ?? entry.message?.content) === "string" ? (entry.content ?? entry.message.content).slice(0, 180) : "[content blocks]" }));
}
