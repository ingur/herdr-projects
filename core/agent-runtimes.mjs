export function agentKind(value) {
  if (value !== "pi") throw new Error(`No Projects runtime installed for ${JSON.stringify(value)}`);
  return value;
}

async function runtime(kind) {
  agentKind(kind);
  return import("../pi/pi-launch.mjs");
}

export async function sessionLaunchCommand(record, stateDir) {
  return (await runtime(record.agent)).piLaunchCommand(record, stateDir);
}

export async function conversationRemover(kind) {
  return (await runtime(kind)).piRemoveConversation;
}
