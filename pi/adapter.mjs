import { existsSync, rmSync } from "node:fs";

export const variables = ["PATH", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"];

export function start(session) {
  return ["pi", "--name", session.title];
}

export function resume(conversation) {
  if (existsSync(conversation.file)) return ["pi", "--session", conversation.file];
}

export function remove(conversation) {
  rmSync(conversation.file, { force: true });
}
