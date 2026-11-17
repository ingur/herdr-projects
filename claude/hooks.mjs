import { readFileSync } from "node:fs";
import { actions } from "../core/control.mjs";
import { role } from "../core/roles.mjs";

const terminal = process.env.HC_TERMINAL_ID, pid = process.ppid;

function arrival(input) {
  return {
    terminal, pid, agent: "claude", env: process.env,
    conversation: { id: input.session_id, transcript: input.transcript_path },
  };
}

function told(input, session) {
  return { hookEventName: input.hook_event_name, additionalContext: role(session, name => `mcp__plugin_projects_projects__${name}`) };
}

const events = {
  async SessionStart(input) {
    const { session } = await actions.enter({ ...arrival(input), replaced: input.source === "clear" || input.source === "fork" });
    if (!session) return;
    const title = session.title === input.session_title ? {} : { sessionTitle: session.title };
    return { hookSpecificOutput: { ...told(input, session), ...title } };
  },

  async SessionEnd(input) {
    if (input.reason !== "clear" && input.reason !== "resume") await actions.leave({ terminal, pid });
  },

  async UserPromptSubmit(input) {
    const { session } = await actions.session({ terminal, pid });
    if (session?.resolved) await actions.unresolve({ id: session.id });
    if (session && session.title !== input.session_title) {
      return { hookSpecificOutput: { hookEventName: input.hook_event_name, sessionTitle: session.title } };
    }
  },

  async UserPromptExpansion(input) {
    const title = input.command_args?.trim() || undefined;
    const { session } = await actions.create({ ...arrival(input), cwd: process.env.CLAUDE_PROJECT_DIR, title });
    return { hookSpecificOutput: told(input, session) };
  },
};

const input = JSON.parse(readFileSync(0, "utf8"));
try {
  if (!terminal) throw new Error("this needs Claude Code in a herdr terminal");
  const output = await events[input.hook_event_name](input);
  if (output) console.log(JSON.stringify(output));
} catch (error) {
  if (input.hook_event_name === "UserPromptExpansion") console.log(JSON.stringify({ decision: "block", reason: `Projects: ${error.message}` }));
  else if (terminal) console.log(JSON.stringify({ systemMessage: `Projects: ${error.message}` }));
}
