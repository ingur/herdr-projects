import { existsSync, rmSync } from "node:fs";

// A conversation is { id, file }: pi's session id and session file.

export const variables = ["PATH", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"];

export function start() {
  return ["pi"];
}

// pi writes the session file with the first prompt or answer; before that there is nothing to continue.
export function resume(conversation) {
  if (existsSync(conversation.file)) return ["pi", "--session", conversation.file];
}

export function remove(conversation) {
  rmSync(conversation.file, { force: true });
}
