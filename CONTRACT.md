# The contract

Everything core can be asked, and by whom.

| Part | Its job |
|---|---|
| The agent | The program that runs in a terminal and holds a conversation. pi is the first. |
| The extension | Runs inside the agent. Tells core what happens there, gives the agent its tools and instructions, and hands it its mail. |
| The adapter | Says how to start, resume and remove a conversation of that agent. |
| Core | Keeps the sessions, the mailboxes and the project logs, and enforces every rule. It is code that runs inside whoever calls it, not a running program. |
| Herdr | Runs the terminals. Core asks it which terminal runs what, and to start and end them. |
| A client | Acts for the user from outside an agent: the sidebar, an avatar, a script. Core treats every client as the user. |

| Word | What it means |
|---|---|
| Session | What core keeps for one agent: an id, a kind, a title, a folder, a mailbox and at most one conversation. |
| Kind | `plain`, `coordinator` or `thread`. |
| Project | A coordinator and its threads. A session's `project` is its coordinator's id. |
| State | `stopped`: the session's agent is alive in no terminal. `starting`: it is alive in one, but has not reported in or has no status yet. `running`: it has reported in and Herdr reports a status for it. |
| Open, closed | A session is open while it is `running` or `starting`, and closed while it is `stopped`. When a coordinator opens, its unresolved threads open; when it closes, its threads close. |
| Status | What a running agent is doing, as Herdr reports it: `idle`, `working`, `done`, `blocked`, `error`. |
| Resolved | Finished and kept. A message to a resolved session, or the user typing in it, makes it unresolved. |
| Message | Text from one sender to one recipient, sent through core. Every message has an id. |
| Address | How a sender or recipient is named, in `from` and `to`: `user`, `coordinator`, or a session's id. |
| Attachment | The user's own earlier words, carried inside a message. The sender names them by id; core fills them in. |
| Copy | A notice for a coordinator about something said in one of its threads. |
| Mailbox | Where messages and copies for one recipient wait. Every session has one; the user has one. |
| Project log | Every message of a project, every prompt the user typed in it and each thread's answer to such a prompt, in full. Every entry has an id. |
| Title | 1 to 80 printable characters, never `coordinator` or `user`. It is for people to read; sessions may share one. `titleSource` says who set it: `placeholder` (nobody yet), `agent` or `user`. An agent cannot change a title the user set. |

Rules for every call:

- Core checks every rule on every call. A call that breaks one is refused: it throws with the reason, and nothing is saved.
- No call waits for an agent, except the two whose rows give a time: `collect` and `thread_resolve`.
- A call takes `options` and `io`. `io.adapter` is the adapter, handed in by the caller. `options.stateDir` is optional; the default is `$PROJECTS_STATE_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/herdr-projects`. How core stores things there is its own business.

## Messages

| Sender | May send to |
|---|---|
| The user, through a client | Any session |
| A plain session | The user |
| A coordinator | The user, and its own threads |
| A thread | The user, its coordinator, and unresolved threads of the same project |

- A text is 1 to 100,000 characters.
- A message to a closed thread opens it. A closed coordinator or plain session gets it when it is opened.
- `attach` takes ids of what the user said in the sender's own project. Anything else is refused.
- A coordinator gets a copy of: a prompt the user types into one of its threads, the thread's answer to it, a message between the user and a thread, and a message between two threads. A copy holds the first 2,000 characters.

A message, in `collect` and in a mailbox: `{type: "message", id, from, fromTitle?, session?, to, toTitle?, text, attached?, created}`. `from` and `to` are addresses; a session's id has its title beside it. `session` is the sending session's id.

What an agent reads:

```
<message id="ID" from="SESSION-ID" from-title="Parser">
<attached from="user" id="ID">
the user's exact words
</attached>
the sender's text
</message>

<copy id="ID" from="user" to="SESSION-ID" to-title="Parser" cut="2000 of 5120">
the first 2,000 characters
</copy>

<typed id="ID">the first words of the prompt the user typed next to it</typed>
```

An agent answers a message by sending to its `from`. A copy has the `from` and `to` of what it copies. Only core writes these tags: in every text, tool result and refusal that core gives an agent, their `<` is shown as `&lt;`.

## What a client can ask: `core/client.mjs`

A session's terminal carries labels that a client reads:

| Label | Says |
|---|---|
| `projects.control` | `{version: 3, command, stateDir}`: the command a client runs, and the state folder to give as `stateDir` in every call. |
| `projects.session` | The session this terminal runs, or waits for while that session is closed. |
| `projects.launched` | Core started this terminal. |
| `projects.changed` | The time of the session's last change. A thread without a terminal sets it on its coordinator's; any other session without a terminal sets none. |

A client runs `command ACTION 'JSON'`, or gives the JSON on standard input. It prints one JSON object; an error prints `projects: message` on stderr and exits 1.

An action answers with the session's view, unless its row says otherwise:

```
id, kind, project (not for plain), title, titleSource, folder, resolved, rank, created,
space, tab (where Herdr shows it, or last did),
terminal (where its agent runs; for a closed session, the empty shell Herdr left in its tab),
state, status (only while running), waiting (messages in its mailbox), error?
```

`error` in a view says the call was carried out, but the session could not be opened or Herdr could not be asked about it. `errors`, where an answer lists things, is `[{id, error}]`: the records or mail files that could not be read.

| Action | Options | What it does |
|---|---|---|
| `list` | | `{sessions, errors?}`: every session's view. Each coordinator, then its threads with unresolved ones first, then plain sessions; higher rank first. |
| `send` | `to` (a session id), `text` | Sends the text as a message from the user. |
| `collect` | `taken?` (ids), `wait?` (seconds) | `{messages, errors?}`: the mail waiting for the user, oldest first, after removing what `taken` names. With `wait`, it answers when mail is there, or after that time. |
| `open` | `id`, `space?` | Opens a closed session: in `space`, else where it last ran; a thread goes to its coordinator's space while the coordinator is open. |
| `close` | `id` | Closes the session. |
| `rename` | `id`, `title` | Sets the title, as the user's. |
| `order` | `id`, `rank` | Sets its rank. |
| `place` | `id`, `space` | Sets the space a closed session opens in. |
| `move` | `id`, `folder` (absolute) | Sets the folder of a closed session whose folder was moved. |
| `delete` | `id` | `{deleted}`: closes the session and removes it with its conversation and mailbox; for a coordinator also its threads and the project log. |
| `create-thread` | `coordinator`, `title?`, `folder?` (absolute, or from the coordinator's folder, which is the default) | Makes a thread with no first message, and opens it. |
| `resolve` | `id` | Marks the session resolved and closes it. |
| `unresolve` | `id` | Marks it unresolved. |

## What an agent can ask: `core/agent.mjs`

`tools` is the list: `name`, `label`, `description`, `parameters` (JSON Schema) and `kinds`, the kinds of session that have the tool. `act({id, tool, args}, io)` runs one for the session `id`, if its kind has the tool. `instructions(session)` is what the agent is told.

| Tool | Kinds | Takes | Does |
|---|---|---|---|
| `message_send` | all | `to` (an address), `text`, `attach?` | Sends a message. Answers with the recipient session, or nothing for the user. |
| `title_set` | all | `title`, `thread?` | Sets its own title; a coordinator sets a thread's with `thread`. |
| `thread_list` | coordinator, thread | | `{you, sessions}`: the sessions of its project. |
| `thread_start` | coordinator | `title`, `instruction`, `folder?`, `attach?`, `model?`, `thinking?` | Makes a thread, saves the instruction as its first message, and opens it. |
| `thread_resolve` | coordinator | `thread` | Resolves a thread of its project. A thread that is working is given up to 20 seconds to stop; after that the call is refused. |
| `message_read` | coordinator | `id` | One entry of its project's log, in full. |

A session in a tool's answer is `{id, kind, title, state, status?, resolved, waiting, error?}`.

`thinking` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `model` is text to core; the agent's extension says which models it takes. A thread's agent starts on both whenever the thread opens with no conversation to resume.

## What the extension tells core: `core/extension.mjs`

| Function | Options | When, and what core does |
|---|---|---|
| `enter` | `terminal`, `pid`, `conversation`, `folder`, `env`, `replaced?` | The agent started, or changed its conversation. Answers `{session, error?}`: the session this is, and which of a coordinator's threads could not be opened. |
| `leave` | `terminal`, `pid` | The agent quit. The session is closed. |
| `current` | `id` | `{session?}` as it is now. |
| `project` | `id`, `title?` | The user asked for a project. A plain session becomes a coordinator. |
| `named` | `id`, `title` | The user named the session inside the agent. Sets the title, as the user's. |
| `mail` | `id` | `{items, errors?}`: the messages and copies in the mailbox, oldest first. Each has `content`, what the agent reads. |
| `stored` | `id`, `ids` | The conversation holds these. Core removes them from the mailbox. |
| `typed` | `id`, `text` | The user typed a prompt. In a project core logs it and answers `{id, content}`, the `<typed>` line for the conversation. |
| `answered` | `id`, `text` | The agent answered a prompt the user typed. In a thread core logs it. |
| `watch(options, changed)` | `id` | Calls `changed` whenever mail for the session comes or goes, and once with an error if it can no longer tell. Answers a function that stops it. |

`session` is `{id, kind, project?, title, titleSource}`. `terminal` is `$HC_TERMINAL_ID`, `pid` the agent's process, `folder` its working folder and `env` its environment. `conversation` is an object with the agent's own `id` for the conversation, plus whatever its adapter needs. `replaced` says the conversation took the place of the one before in the same session.

Which session an agent is, the first that applies:

1. The session core opened this terminal for.
2. The session this terminal already runs, when the conversation is the same or `replaced`.
3. The session the conversation belongs to.
4. A new plain session.

A session the terminal ran before is closed. A plain session with no conversation to resume and no mail is removed when it closes this way or when its agent quits.

What the extension does with mail:

- It gives an idle agent its mail at once, and a working agent its mail without interrupting it.
- A message makes the agent act on it; a copy does not.
- It tells core `stored` once the conversation holds the mail, and not before.

So a message is never lost and never given twice. Once the conversation holds it, it is the agent's.

## What core asks the adapter

| Part | What it is |
|---|---|
| `variables` | Names of the environment variables the agent needs. Core takes their values from `enter` and opens agents with them. |
| `start(settings)` | The command for a new conversation, on `settings.model` and `settings.thinking` where given. |
| `resume(conversation)` | The command that resumes a conversation, or nothing when it cannot be resumed. |
| `remove(conversation)` | Removes a conversation. |
