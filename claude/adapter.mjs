import { existsSync, rmSync } from "node:fs";

export const variables = ["PATH", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PLUGIN_DIRS", "DISABLE_AUTOUPDATER"];

const tools = ["--allowedTools", "mcp__plugin_projects_projects"];

export function start(session) {
  return ["claude", "--name", session.title, ...tools];
}

export function resume(conversation) {
  if (existsSync(conversation.transcript)) return ["claude", "--resume", conversation.id, ...tools];
}

export function remove(conversation) {
  rmSync(conversation.transcript, { force: true });
  rmSync(conversation.transcript.replace(/\.jsonl$/, ""), { recursive: true, force: true });
}
