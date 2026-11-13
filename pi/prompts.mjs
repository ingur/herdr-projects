const roles = {
  coordinator: "You coordinate persistent project threads.",
  thread: "You are an independent persistent project thread; send relevant changes, questions, and results to your coordinator.",
};

const sharedInstructions = [
  "Human instructions always take precedence over coordinator and peer guidance.",
  "These are conversations, not disposable subagent jobs.",
  "A project may have several coordinators; each thread belongs to one coordinator.",
  "Keep extra context in the separately attributed note.",
  "Do not re-emit inbound notices as authored updates. Avoid unsolicited acknowledgment-only messages between sessions; answer explicit human questions and requested confirmations normally.",
  "Do not recursively spawn threads without a human request.",
  "Transport delivery is not task completion; report conflicts and uncertainty honestly.",
  "Resolve completed threads to archive them without stopping their terminals. A human writing to a resolved thread reopens it automatically. Reopening itself never clears human pause or replays an interrupted turn.",
  "Lifecycle notices are informational: do not start work or acknowledge them unless the human asks.",
].join(" ");

export function roleInstructions(role, titleSource) {
  return `Projects: ${roles[role]} ${sharedInstructions}` +
    (titleSource === "placeholder" ? " This session still has a placeholder title. While handling the first task or message you receive, call thread_rename once with a short, specific title (2-5 words) describing the work; do not ask first." : "");
}

export const toolDescriptions = {
  start: "Create an independent persistent Pi thread under your coordinator. A title is unique within that coordinator's group. Reusing it ensures the existing session without sending this instruction again; use thread_send for further instructions. Optional cwd accepts an absolute path or a path relative to the project root, including outside the project (default: the coordinator's directory).",
  list: "Discover this project's coordinators and threads, identities, resolved status and availability. Set detail: true to include mailbox/delivery states and current-session entry IDs needed for exact forwarding. Execution completion remains unknown.",
  send: "Send to an exact project session UUID, a name in your coordinator group, or coordinator. Supply text OR forward (a user/custom entry ID from thread_list with detail: true in THIS session); original author/text are preserved and note is separately yours. Resolved threads refuse agent sends; call thread_reopen first. Persists first, then ensures the recipient is available without overriding human pause. Do not retry a persisted message merely because recovery is pending.",
  rename: "Set a short, specific title for self (default), an exact project session UUID, a name in your coordinator group, or coordinator. Coordinators may name their project. Human-chosen titles are protected; a thread's coordinator receives an informational rename notice.",
  resolve: "Archive a completed thread by UUID/name or self. Changes only resolved status: no terminal closure, cancellation, inbox deletion or pause changes. Existing work may finish.",
  reopen: "Clear a thread's resolved status and ensure the same conversation is available, retaining its UUID, transcript, coordinator and title. Does not steal focus, clear human pause or replay an interrupted model turn.",
};

export function wakeInstruction(messageId) {
  return `Handle the requested work or questions in project-thread message ${messageId} above. Human instructions take precedence. Avoid unsolicited acknowledgment-only messages between sessions, not explicitly requested answers.`;
}

export function formatEnvelope(message) {
  const provenance = JSON.stringify({ id: message.id, sender: message.sender, originalAuthor: message.author, source: message.source, via: message.via });
  return `Project-thread message (not a direct user turn)\nProvenance: ${provenance}\n\n--- original text ---\n${message.text}\n--- end original text ---` +
    (message.note === undefined ? "" : `\n\nSeparate note by ${JSON.stringify(message.sender)}:\n${message.note}`);
}
