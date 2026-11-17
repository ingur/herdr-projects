import { existsSync, rmSync } from "node:fs";

export const variables = ["PATH", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_CODING_AGENT_DIR"];

export function start() {
  return ["omp"];
}

export function resume(conversation) {
  if (existsSync(conversation.file)) return ["omp", "--resume", conversation.file];
}

export function remove(conversation) {
  rmSync(conversation.file, { force: true });
  rmSync(conversation.file.replace(/\.jsonl$/, ""), { recursive: true, force: true });
}
