# Projects contract

The workflow is projects: a coordinator, its threads, and messages between them and the user.

| Part | Its responsibility |
|---|---|
| hc | Runs terminals, types text in, reports the agent's status |
| core | Keeps the records and enforces the rules |
| adapter | Starts, continues and deletes one tool's conversations |
| integration | Inside a session: binds it, gives the agent its actions, keeps it in its project |
| client | How the user acts (the sidebar, `control`, a front end); core treats every client as the user |

| Word | What it is | Owner |
|---|---|---|
| Terminal | Where a program runs and text is typed | hc |
| Status | hc's word for what the agent is doing (`idle`, `working`, `done`, `blocked`, `error`) | hc |
| Session | A coordinator or a thread: core's record with id, role, title and waiting mail | core |
| Project | A coordinator and its threads | core |
| State | Whether a terminal holds the session (`running`, `starting`, `stopped`) | core |
| Message | Text sent through core from a session or the user to another; hc types it in | core |
| Title | The session's name | core |
| Conversation | The tool's own saved history, with the tool's own id | the tool, through its adapter |
| Agent process | The tool running in a terminal | the tool |
| What the user types | Direct input to the agent; never a message | the tool |

## What a tool must support

A coding agent tool supports the workflow when all six hold. How it meets each is its own: every
integration is built from its tool's native means, and none is the model for another.

1. **Core can start a new conversation of the tool in a terminal, continue an existing one, and
   delete one.** hc starts a program with the hc core's environment, not that of the user's shell
   or of the client that asked. Whatever the tool needs beyond that to start on this machine is
   its adapter's to supply. A tool that cannot be started is an error the user sees.
2. **The terminal reports the agent's status to hc** (OSC 7501, hc's Program Status Protocol). hc
   never guesses it from the screen. Without a status the session stays `starting` and no mail is
   delivered.
3. **Core knows which session, if any, the agent in a terminal is running, from when it can take
   input until it leaves.** That covers: the user makes the current conversation a project; the
   user resumes a project's conversation by the tool's own means; the conversation is replaced
   while the project is kept; the user switches to a conversation outside the project.
4. **The agent knows its role and what a message is, for as long as it is in the project.** A
   coordinator starts threads and carries on while they work; a thread sends its result to the
   coordinator when it is done. A `<message>` tag names who sent it through the project, and only
   `from="user"` is the user. What the user types is answered on the screen; a message from the
   user is answered, once complete, by a message to the user, and so is a question back. A session
   that never received a message from the user never writes to the user.
5. **The agent can perform the actions of its role, inside its own project, and no others.** A
   coordinator: start a thread, list, send, rename, resolve a thread. A thread: list, send,
   rename itself. Send goes to a session of its project or to the user.
6. **What the user types into a resolved session unresolves it.**

Not required, so each integration's own choice: how the user makes a project, which commands
exist, how the agent is given its actions, a command that opens a stopped project, a name handed
over as the title of a new project, showing the title in the tool's own session name.

## Calling core

`node core/control.mjs ACTION 'JSON'` prints one JSON object; an error prints `projects: message`
on stderr and exits 1. The same functions are `actions[name](options)` in `core/control.mjs`.
Core keeps its records in `$PROJECTS_STATE_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/herdr-projects`;
how it stores them is its own business. A session's `id` is core's own, never the tool's.

Most actions return the session's view:

```
id, role: "coordinator" | "thread", coordinator, title, titleSource: "placeholder" | "agent" | "user",
cwd, agent, resolved, rank, created, space, tab, terminal (while running or starting),
state: "running" | "starting" | "stopped", status (hc's word, only when running),
waiting (count of messages not yet typed in), error?
```

### What an integration says

An integration says what happened in its terminal. Core decides which session that is.
`terminal` is `$HC_TERMINAL_ID`, `pid` is the agent process, `agent` names the tool,
`conversation` is `{id, …}`: the tool's own id for the conversation plus whatever its adapter
needs to continue or delete it. `env` is the agent's environment; core keeps the variables its
adapter names.

| Action | Options | Does |
|---|---|---|
| `enter` | `{terminal, pid, agent, conversation, env, replaced?}` | The agent now runs this conversation. The session is, in this order: the one core started in this terminal that no agent has entered yet; the one this process has entered, when the conversation is the same or `replaced` (the tool swapped the conversation and the project stays); the one whose conversation this is. Returns `{session: view}`, or `{}` when it is in no project. A session the process had entered and no longer runs is left, and the terminal loses its labels |
| `create` | `{terminal, pid, agent, conversation, env, cwd, title?}` | Makes the conversation a project in the folder `cwd` and enters it. `title` is the user's; none gives `New project` as a placeholder. Refused when the conversation is already in a project |
| `leave` | `{terminal, pid}` | The agent exits. Its terminal keeps the session's label and waits for it. A coordinator's open threads are closed and come back with it |
| `session` | `{terminal, pid}` | `{session: view}` for the session this process has entered, or `{}` |

All four return at once. After `enter` and `create` core itself starts the project's threads that
were open and types the session's waiting mail.

### What an agent may do

`core/roles.mjs` has what an integration offers its agent, as data: `tools` (name, label,
description, parameters as JSON Schema, the roles that get it) and `role(session, call)`, the text
of need 4, where `call(name)` is how this tool's agent sees a tool. An integration passes a tool
call on with `act {as, tool, args}`: `as` is the acting session's id, from `enter`, `create` or
`session`. Core enforces the role and the project, and a session is named by its id, its title,
or `"coordinator"`.

| Tool | Arguments | Rule |
|---|---|---|
| `thread_start` | `{title, instruction, cwd?, agent?}` | Coordinator only. An existing title returns that thread with `existing: true` and sends nothing |
| `thread_list` | `{}` | `{you, sessions: [view]}` of its own project |
| `thread_send` | `{target, text}` | To a session of its project or to `"user"`; not to itself |
| `thread_rename` | `{target?, title}` | Itself when `target` is absent; a coordinator also its threads; never a title the user chose |
| `thread_resolve` | `{target}` | A coordinator, one of its threads, not while it is `working` (waits up to 20 s for a finishing turn) |

### What a client may do

A client is the user: no `as`, sessions by id.

| Action | Options | Does |
|---|---|---|
| `list` | `{}` | `{sessions: [view], errors?}`: coordinators by rank, highest first, each followed by its threads, unresolved first, by rank |
| `create-thread` | `{coordinator, title?, cwd?, agent?, text?}` | New thread, started at once. `cwd` absolute or relative to the coordinator's; `agent` defaults to the coordinator's. Titles are unique per coordinator ignoring case, at most 80 characters, not `coordinator` or `user`; none gives `New thread` as a placeholder. `text` is its first message, from the coordinator |
| `open` | `{id, space?}` | Starts a stopped session; returns once its terminal exists |
| `send` | `{to, text}` | A message from the user; adds `sent` and `note?` |
| `collect` | `{taken?: [key]}` | Removes the user's mail named in `taken`, then returns `{messages: [{key, from, title, id, text, created}], errors?}`, oldest first. A client names what it handed over in its next call, so after a crash it gets it again |
| `rename` | `{id, title}` | The title becomes the user's |
| `order` | `{id, rank}` | |
| `place` | `{id, space}` | Only when stopped |
| `resolve` | `{id}` | Marks it resolved and closes it |
| `unresolve` | `{id}` | |
| `close` | `{id}` | Ends its terminal; a coordinator's open threads are closed first and come back with it |
| `delete` | `{id}` | Closes it, deletes its conversation through the adapter, removes the session; a coordinator takes its threads. Returns `{deleted: [ids]}` |

## State

A terminal holds a session while it is live, carries the session's labels, still runs the program
it ran when it was labelled, and the agent process is alive. `starting`: core started the agent
there, or it entered, and it is not yet both entered and reporting a status. `running`: entered and
reporting a status. `stopped`: nothing holds it. A session whose tool has no integration installed
never enters and stays `starting`.

## Messages

```
<message from="coordinator|thread" title="TITLE" id="SESSION-ID">
TEXT
</message>
```

From the user it is `<message from="user">`. `&`, `"`, `<`, `>` in attribute values are escaped.
Text is 1 to 100000 characters.

1. A resolved thread is unresolved when its coordinator or the user sends; others are refused.
2. The message joins the session's waiting mail, behind any older mail.
3. `running`: waiting mail is typed now, in order. `blocked` keeps it until the next delivery.
4. `starting`: it stays waiting and is typed once the session has entered and reports a status.
5. `stopped`: a thread is started; a coordinator keeps it until the user opens the project.

`sent` is true only when this message was typed; `note` says why not, or that no turn started.
Right before typing, core checks that the terminal still holds the session.

A message to `"user"` is never typed: core stores it and a client takes it with `collect`. To start
a thread with an instruction of the user's, a client calls `create-thread` without `text`, then
`send`: `text` is from the coordinator, so the thread would report to a coordinator that never asked.

## Adapters

`adapters.mjs` lists the adapters, one per tool. An adapter exports:

| Export | Is |
|---|---|
| `variables` | The names of the environment variables the tool needs to start |
| `start(session, tool)` | argv for a new conversation; `session` has `title` and `cwd` |
| `resume(conversation, tool)` | argv to continue the conversation, or nothing when it cannot be continued |
| `remove(conversation, tool)` | Deletes the conversation |

`tool` is `{env}`: the values of `variables` as the tool's integration last passed them. Core keeps
them per tool and starts every session of that tool with them on top of the hc core's environment,
plus `PROJECTS_STATE_DIR`.

## Terminals and labels

Core starts a session with `hc run --bg --no-parent --cwd CWD`, in its coordinator's space while
that runs, else in its recorded space, else unplaced. Labels are how core and clients see which
terminal is whose:

- `projects.session=<id>`: the terminal running that session, or waiting for it while it is stopped.
- `projects.pid=<agent pid>@<terminal pid>`: the agent process, and the program hc ran in the
  terminal when it was labelled; the agent part is empty once the agent left. A terminal hc brings
  back after a restart runs another program, so it holds nothing.
- `projects.bound=1`: the agent has entered.
- `projects.launched=1`: core started this terminal.
- `projects.control={"version":2,"command":["<state>/bin/control"],"stateDir":"…"}`: how a client
  calls core.
- `projects.changed=<ms>`: set after a change, on the session's terminal or its coordinator's.
- `projects.rank=<n>`: the sidebar's; core never touches it.

A terminal keeps the session's label while the session is stopped, and the session starts in its
tab again. A terminal that carries the label, whose `pid` is no longer the terminal part of
`projects.pid`, that reports no status and has nothing but itself in the foreground is an empty
shell hc put in place of the program that ran there: it stands for its session. When a start or
an `enter` finds terminals still labelled with the session that do not hold it, such a shell is
closed; any other, like a shell the user is still in, only loses its `projects.*` labels. A thread
comes back with its project when it was closed with it or left a terminal of core's behind (a
reboot takes everything down at once).

## Known limits

- Messages are typed text by convention, not a security boundary. If one ever reached a shell,
  its first line fails, but later lines of a multi-line message would run.
- After a hard kill without a restart, another process that gets the agent's pid makes the terminal look alive.
- The pid check needs core, hc and the agents in one process namespace: same machine, no
  container or sandbox between them.
- A picker open in the agent swallows a message; when the agent was working this is silent.
- A draft left untouched for 60 s stops holding messages (hc's `draft_wait`).
- A tool that asks a question at startup reports no status until it is answered; mail waits.
- Delivery is at least once: if `hc send` fails after hc typed a message, it stays waiting and is
  typed again.
- An agent that prints its answer instead of sending it leaves a message from the user unanswered;
  core cannot tell.
- A client's text carries the user's authority, also when it rephrased him.
- Mail to the user is written by agents. A client that is itself a model hands it to the user and
  sends only what the user said, or an agent's text becomes the user's instruction to any session.
- A reboot (or an hc restart) brings a session's tab back as a shell: the session shows `stopped`
  until it is opened again, which starts it in that tab and closes the empty shell.
- Requires hc 0.1.20 or newer.
