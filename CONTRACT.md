# The contract

Everything core can be asked, and by whom. Core is code that runs inside whoever calls it; it is not a running program.

| Part | Its job |
|---|---|
| pi | Runs the agent. Owns the conversation and the screen. |
| The extension (`pi/extension.ts`) | Runs inside every pi. Tells core what happens there, gives the agent its instructions and tools, takes mail from its own mailbox and hands it to pi. |
| The adapter (`pi/adapter.mjs`) | Knows how to start, continue and delete a pi conversation. |
| Core (`core/`) | Keeps the records, the mailboxes and the project logs. Enforces every rule. Knows nothing about pi. |
| herdr-core (`hc`, called only from `herdr/`) | Starts and stops terminals, says which terminal runs what, and the agent's status. Carries no messages. |
| A client | The sidebar, the user's avatar, the `control` command. Core treats every client as the user. |

| Word | What it means |
|---|---|
| Session | One agent conversation that core knows about, with core's own id, a kind, a title, a folder and a mailbox. |
| Kind | `plain`, `coordinator` or `thread`. |
| Project | A coordinator and its threads. A session's `project` is its coordinator's id. |
| Message | Text from one sender to one recipient, sent through core. Every message has an id. |
| Address | How a sender or recipient is named, in `from` and `to`: `user`, `coordinator`, or a session's id. |
| Attachment | The user's own earlier words, carried inside a message. The sender names them by id; core fills them in. |
| Copy | A notice for a coordinator about something said in one of its threads. It never starts the agent. |
| Mailbox | Where messages and copies for one recipient wait until they are taken. Every session has one; the user has one. |
| Project log | Every message of a project, everything the user typed in it and the threads' answers to that, in full. |
| State | `running`, `starting` or `stopped`: whether a terminal holds the session. |
| Status | herdr-core's word for what the agent does: `idle`, `working`, `done`, `blocked`, `error`. |

Rules for every call:

- Core checks every rule itself, on every call. A call that breaks one throws an error with the reason, and nothing is saved.
- No call waits for an agent. Resolving by an agent waits up to 20 seconds for a turn that is just ending, and `collect` can be asked to wait for mail.
- Every function is `name(options, io)`. `io.adapter` is the adapter, handed in by the caller. `options.stateDir` is optional; the default is `$PROJECTS_STATE_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/herdr-projects`. How core stores things there is its own business.

## What a client can ask: `core/client.mjs`

Clients outside this package run `control ACTION 'JSON'`, or give the JSON on standard input. It prints one JSON object; an error prints `projects: message` on stderr and exits 1. The command's path is in the `projects.control` label of every session's terminal.

Most actions return the session's view:

```
id, kind, project (not for plain), title, titleSource: "placeholder" | "agent" | "user", folder,
resolved, rank, created, space, tab, terminal (where its agent runs),
state, status (only when running), interrupted, waiting (messages in its mailbox), error?
```

`interrupted` says the session is stopped and its tab came back as an empty shell, as after a herdr restart; `terminal` is then that shell.

A call that is refused throws. `error` on a view says that the call was carried out, but the session could not be started or herdr-core could not be asked about it. `errors` in a list is `[{id, error}]`: the records or mail files that could not be read, which the rest does not wait for.

A title is 1 to 80 printable characters, and never `coordinator` or `user`. It is what people read, never an address: sessions may have the same title. `titleSource` says who set the title: nobody yet, the agent, or the user. An agent cannot change a title the user set.

| Action | Options | What it does |
|---|---|---|
| `list` | | `{sessions, errors?}`: every session's view. Projects first, each coordinator followed by its threads, unresolved first; then plain sessions. Higher rank first. |
| `send` | `to` (a session id), `text` | Saves the text as a message from the user. A stopped thread is started; a stopped coordinator or plain session gets it when opened. |
| `collect` | `taken?` (ids), `wait?` (seconds) | `{messages, errors?}`: the mail waiting for the user, oldest first. What `taken` names is removed first. With `wait`, it returns as soon as mail arrives. |
| `open` | `id`, `space?` | Starts a stopped session in its place. |
| `close` | `id` | Ends the session's terminal. A coordinator's open threads close first and come back with it. |
| `rename` | `id`, `title` | Sets the title as the user's. |
| `order` | `id`, `rank` | Sets its place in the list. Higher comes first. |
| `place` | `id`, `space` | The herdr space a stopped session opens in. |
| `move` | `id`, `folder` (absolute) | Records the new folder of a stopped session whose folder was moved. |
| `delete` | `id` | `{deleted}`: removes the session, its conversation, record and mailbox; for a coordinator also its threads and the project log. |
| `create-thread` | `coordinator`, `title?`, `folder?` (absolute, or from the coordinator's folder, which is the default) | Starts a thread with no first message. |
| `resolve`, `unresolve` | `id` | Marks a session finished and closes it, or not finished. |

A message, in `collect` and in a mailbox: `{type: "message", id, from, fromTitle?, session, to, toTitle?, text, attached?, created}`. `from` and `to` are addresses, and a session's id has its title beside it; `session` is the sender's id, and is left out when the user sent it.

## What an agent can ask: `core/agent.mjs`

`tools` is the list: `name`, `label`, `description`, `parameters` (JSON Schema) and `kinds`, the kinds of session that have the tool. `act({id, tool, args}, io)` runs one for the session `id`; core refuses a tool that is not of that session's kind. `instructions(session)` is what the agent is told, from the session's kind and title.

| Tool | Kinds | Takes | Does |
|---|---|---|---|
| `message_send` | all | `to`, `text`, `attach?` | Sends a message. `to` is an address. Returns the recipient session, and nothing for the user. |
| `title_set` | all | `title`, `thread?` | Sets its own title, or for a coordinator that of the thread with this id. Refused when the user chose the title. |
| `thread_list` | coordinator, thread | | The sessions of its project. |
| `thread_start` | coordinator | `title`, `instruction`, `folder?`, `attach?` | Starts a thread and saves the instruction as its first message. |
| `thread_resolve` | coordinator | `thread` | Resolves the thread with this id. Refused while the thread is working. |
| `message_read` | coordinator | `id` | The full text of a message or a copied item of its project. |

A session in a tool's result is `{id, kind, title, state, status?, resolved, waiting, error?}`.

Who may send to whom:

| Sender | May send to |
|---|---|
| The user, through a client | Any session |
| A plain session | The user |
| A coordinator | The user, and its own threads |
| A thread | The user, its coordinator, and threads of the same project |

A text is 1 to 100,000 characters. A resolved session is reopened by a message; one thread cannot reopen another. `attach` takes ids of what the user said in the sender's own project; anything else is refused.

What the agent reads:

```
<message id="ITEM-ID" from="SESSION-ID" from-title="Parser">
<attached from="user" id="ITEM-ID">
the user's exact words
</attached>
the sender's text
</message>

<copy id="ITEM-ID" from="user" to="SESSION-ID" to-title="Parser" cut="2000 of 5120">
the first 2,000 characters
</copy>

<typed id="ITEM-ID">the first words of the prompt the user typed next to it</typed>
```

Only core writes these tags. Where a text or a tool's result holds one, its `<` is shown as `&lt;`, so nothing an agent reads can pass for a message, a copy or the user's words.

`from` and `to` are addresses, the same that `message_send` takes: an agent answers a message by sending to its `from`. A session's id has its title beside it, in `from-title` or `to-title`. A copy has the `from` and `to` of what it copies. A copy is made of: a prompt the user types into a thread, the thread's answer to it, a message between the user and a thread, and a message between two threads.

## What the extension tells core: `core/extension.mjs`

| Function | Options | When, and what core does |
|---|---|---|
| `enter` | `terminal`, `pid`, `conversation`, `folder`, `env`, `replaced?` | The agent started, or its conversation changed. Core decides which session this is: the one it started this terminal for, else the one the conversation belongs to, else a new plain session. A session the terminal ran before is stopped first. Returns `{session, error?}`. |
| `leave` | `terminal`, `pid` | The agent quit. The session is stopped; a coordinator's threads close. |
| `current` | `id` | `{session?}` as it is now, for the instructions and tools of the next run. |
| `project` | `id`, `title?` | The user asked for a project. A plain session becomes a coordinator. |
| `named` | `id`, `title` | The user named the session inside the agent. That is its title, as the user's, under the rule for titles. |
| `mail` | `id` | `{items, errors?}`: the messages and copies in the mailbox, oldest first. Each item has `content`, what the agent reads. |
| `stored` | `id`, `ids` | These items are stored in the conversation. Core removes them from the mailbox. |
| `typed` | `id`, `text` | The user typed a prompt. In a project core logs it and returns `{id, content}`, the `<typed>` line for the conversation. A resolved session is unresolved. |
| `answered` | `id`, `text` | A run that the user's typing started ended with this text. In a thread core logs and copies it. |
| `watch` | `id`, then a function | Calls the function whenever mail for the session comes or goes, and once with an error if it can no longer tell. Returns how to stop. |

`terminal` is `$HC_TERMINAL_ID`, `pid` the agent's process, `conversation` an object with the agent's own `id` for the conversation plus whatever its adapter needs. `replaced` says the conversation took the place of the one before. `session` is `{id, kind, project?, title, titleSource}`.

A plain session that has no conversation to continue and no mail does not outlive its agent: core removes it when the agent quits, or when its terminal starts running another session.

Mail is in the mailbox until the conversation holds it on disk, and nowhere in between. An idle agent is given its mail at once, and a message starts a run. A working agent takes its mail at the end of a turn, and a message there asks for one more turn. A run that is stopping takes none, so its mail starts the next run. A message is never lost and never stored twice. Once the conversation holds it, it is the agent's: a run that is cut off, as when the agent is killed, is not started again.

## What core asks the adapter

| Part | What it is |
|---|---|
| `variables` | Names of the environment variables the agent needs to start. Core keeps their values from the last `enter`. |
| `start()` | The command for a new conversation. |
| `resume(conversation)` | The command that continues a conversation, or nothing when it cannot be continued. |
| `remove(conversation)` | Deletes a conversation. |

## What core asks herdr-core: `herdr/hc.mjs`

Start a program in a terminal, stop it, list the terminals with their labels and status, set a label, and say whether a program is on the path a terminal starts with. Core marks terminals with labels so that it and the sidebar know which terminal belongs to which session:

| Label | Says |
|---|---|
| `projects.session` | Which session this terminal runs, or waits for while that session is stopped. |
| `projects.launched` | Core started this terminal. |
| `projects.control` | `{version: 3, command, stateDir}`: how a client calls `control`. |
| `projects.changed` | When something last changed, set on the session's terminal, or for a thread without one on its coordinator's. The sidebar refreshes on it. A change to a session with no terminal shows at the sidebar's next timed refresh. |

A terminal holds a session while the session's agent is alive in it. The session is `running` when the agent has reported in and reports a status, `starting` when a terminal holds it otherwise, and `stopped` when none does.
