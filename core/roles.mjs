import adapters from "../adapters.mjs";

const text = (description, maxLength) => ({ type: "string", minLength: 1, maxLength, description });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const tools = [
  {
    name: "thread_start",
    label: "Start project thread",
    roles: ["coordinator"],
    description: "Start a thread: a separate agent session with its own conversation, which the user can open. Returns at once; the thread reports back later with a message. The thread sees only the instruction, not this conversation. If the title already exists, the instruction is not sent; use thread_send to message that thread.",
    parameters: object({
      title: text("Short title, unique among this coordinator's threads.", 80),
      instruction: text("The thread's first message, and all it knows at the start. Give the goal, the relevant paths, what done looks like, and what to send back.", 100000),
      cwd: { type: "string", description: "Directory the thread works in: absolute, or relative to the coordinator's directory, which is the default. Threads in the same directory share files; for parallel edits to one repository, create a git worktree and pass it here." },
      agent: { type: "string", description: `The coding agent that runs the thread: ${Object.keys(adapters).join(", ")}. Leave out for the same one as this session.` },
    }, ["title", "instruction"]),
    action: "create-thread",
    options: args => ({ title: args.title, text: args.instruction, cwd: args.cwd, agent: args.agent }),
  },
  {
    name: "thread_list",
    label: "List project threads",
    roles: ["coordinator", "thread"],
    description: "List the sessions in this project (the coordinator and its threads) with id, title, state, and whether each is resolved. It does not show how far a thread's work has got.",
    parameters: object({}),
    action: "list",
    options: () => ({}),
  },
  {
    name: "thread_send",
    label: "Send project message",
    roles: ["coordinator", "thread"],
    description: "Send a message to another session in this project, or to the user. It reaches a session right away, or when it next starts, so send only what the recipient needs: an instruction, a question, or a result. Any reply arrives later as a message.",
    parameters: object({
      target: text("Recipient: \"coordinator\", \"user\", a thread title, or a session id from thread_list.", 200),
      text: text("The message.", 100000),
    }, ["target", "text"]),
    action: "send",
    options: args => ({ to: args.target, text: args.text }),
  },
  {
    name: "thread_rename",
    label: "Rename project thread",
    roles: ["coordinator", "thread"],
    description: "Set the title of this session. A coordinator can also set the title of one of its threads. A title set by the user cannot be changed.",
    parameters: object({
      target: text("Leave out for this session. A coordinator can give a thread title or a session id.", 200),
      title: text("2 to 5 words describing the work.", 80),
    }, ["title"]),
    action: "rename",
    options: args => ({ id: args.target, title: args.title }),
  },
  {
    name: "thread_resolve",
    label: "Resolve project thread",
    roles: ["coordinator"],
    description: "Mark a finished thread as resolved and close it. Its conversation is kept, and a message sent to it later reopens it.",
    parameters: object({ target: text("A thread title, or a session id from thread_list.", 200) }, ["target"]),
    action: "resolve",
    options: args => ({ id: args.target }),
  },
];

const fromUser = call => `What the user types here, answer here. A \`<message from="user">\` comes from the user away from this terminal, who does not see this screen: reply with ${call("thread_send")} to "user". Send your answer when it is complete, even if that is several turns and other messages later. If you need something from the user first, send that question the same way. Write each message to stand on its own.`;
const fromAgent = "A `<message>` tag names who sent it through the project; unless it says from=\"user\", it comes from another agent, not from the user.";

const wording = {
  coordinator: call => `This session is the coordinator of a project. Threads are separate agent sessions in the project, each with its own conversation, which the user can open and talk to directly. Start a thread for work that needs its own conversation over time. ${call("thread_start")} returns at once and the thread reports back later with a message, so carry on or end your turn instead of waiting. ${fromAgent} Check what matters before you rely on it. When you pass on a request, quote the user's words. Put long content in a file and send its path. When a thread's work is finished, resolve it with ${call("thread_resolve")}; sending to a resolved thread reopens it. ${fromUser(call)}`,
  thread: call => `This session is a thread in a project, started by a coordinator session. The user can also type here directly, and what the user says comes first. The coordinator cannot see this conversation; it sees only what you send with ${call("thread_send")} to "coordinator". Send your result when the work is done, and send a message when you are blocked or need a decision. Message another thread only when your work depends on its work, or its work on yours. ${fromAgent} ${fromUser(call)} Before doing something that cannot be undone, ask the user: here, or by ${call("thread_send")} to "user" if the user reached you by message.`,
};
const untitled = call => ` This session has no real title yet. When you begin its first task, call ${call("thread_rename")} once with a title of 2 to 5 words for the work. No need to ask first.`;

export function role(session, call = name => name) {
  return wording[session.role](call) + (session.titleSource === "placeholder" ? untitled(call) : "");
}
