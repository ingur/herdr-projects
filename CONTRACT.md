# Projects contract

hc runs terminals and types text in. `core/` keeps the records and enforces the rules below, with
no agent-specific code. An adapter starts, resumes and deletes one tool's conversations. An
integration inside each session binds it, gives the agent its tools and keeps it inside its project.
Sessions and the user send each other messages. A client (the sidebar, `control`, a front end) is
how the user acts, and core treats every client as the user. What the user types in a session's
terminal reaches its agent directly and is never a message.

## Records

`stateDir` is `options.stateDir`, else `$PROJECTS_STATE_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/herdr-projects`.

```
<stateDir>/sessions/<id>.json   one record per session
<stateDir>/locks/<id>           held while launching, registering, delivering or updating it
<stateDir>/bin/control          written by register: runs core/control.mjs with node
version: 2
id, role: "coordinator" | "thread"     id is core's own UUID, never the agent tool's
coordinator                            its coordinator's id (its own for a coordinator)
title, titleSource: "placeholder" | "agent" | "user"
cwd, agent, resolved, rank, created    agent is a key of core/adapters.mjs
space?, tab?                           Herdr placement, taken from the terminal's labels
reopenWithProject?: true               threads closed together with their project
waiting: [{from, title?, id?, text, created}]   mail not yet typed in
adapter: {}                            owned by the adapter
```

Writes go to a dot-file in the same directory, then rename. Updates are read-modify-write under
the session's lock file, which holds the owner's pid; a lock whose owner died, or older than 10
minutes, is taken over.

## Running

A terminal holds a session while it is live, carries `projects.session=<id>`, still runs the
program named in its `projects.pid`, and the agent process named there is alive. `running`: it
reports an agent status (`idle`, `working`, `done`,
`blocked`, `error`). `starting`: no status yet, however long that takes. `stopped`: nothing holds
it; a terminal core started keeps the session's labels until the next launch, which starts the
session in its tab again and closes it when it is an empty shell. Right before every `hc send`
core checks that the terminal still holds the session and reports a status other than `blocked`.

## Messages

```
<message from="coordinator|thread" title="TITLE" id="SESSION-ID">
TEXT
</message>
```

From the user it is `<message from="user">`. `&`, `"`, `<`, `>` in attribute values are escaped.
Text is 1 to 100000 characters. `send {to, from?, text}` (`from` absent means the user):

1. A resolved thread is unresolved when its coordinator or the user sends; others are refused.
2. The message joins `waiting`, behind any older mail.
3. `running`: waiting mail goes out now. `blocked` keeps it stored until the next delivery.
4. `starting`: it stays stored and goes out at the session's `register`.
5. A stopped thread is launched and its mail goes out; a stopped coordinator keeps it for the user.

Delivery types waiting mail in order and removes each message once hc took it. After a launch
and at `register` it waits up to 60 s for the session to run. `sent` is true only when this
message was typed; when the recipient was `idle` or `done` and no turn started, the note says so.

`to` may be `"user"`, with a session as `from`. Nothing is typed: the message is stored as
`<stateDir>/user/<key>.json`, `{from, title, id, text, created}`, keys sorting by time, and `send`
returns the sender's view with `sent: false` and a note. A client takes it with `collect`. To start
a thread with an instruction, a client calls `create-thread` without `text`, then `send`: `text` is
from the coordinator, so the thread would report to a coordinator that never asked.

## Actions

`node core/control.mjs ACTION 'JSON'` (also `<stateDir>/bin/control`) prints one JSON object;
errors print `projects: message` on stderr and exit 1. The same functions are `actions[name](options)` in `core/control.mjs`, next to `stateDirectory()`,
`readRecord(stateDir, id)` and `findRecord(stateDir, predicate)`. `by` is `"user"` or `"agent"`.

| Action | Options | Does |
|---|---|---|
| `list` | `{}` | `{sessions: [view], errors?}`: coordinators by rank, highest first, each followed by its threads, unresolved first, by rank |
| `register` | `{id?, title?, cwd, agent, adapter, terminal, pid}` | Binds the conversation in an hc terminal; `pid` is the agent's own process. Without `id` creates a coordinator (`title` gives `user`, none gives `New project`, `placeholder`). Refused while another terminal holds the session. Labels the terminal, saves `adapter`, `cwd` and placement, clears what the session left elsewhere, launches its unresolved threads that were open, delivers waiting mail |
| `release` | `{id}` | The session leaves its terminal: a terminal core started keeps the session's labels and loses `projects.pid`, a terminal the user started loses every `projects.*` label; a coordinator's open threads are closed and flagged `reopenWithProject` |
| `create-thread` | `{coordinator, title?, cwd?, by, text?}` | New launched thread; `cwd` absolute or relative to the coordinator's. Titles unique per coordinator (ignoring case, also on rename), at most 80 characters, not `coordinator` or `user`; none gives `New thread`, `placeholder`. An existing title returns that thread with `existing: true` to an agent and sends nothing; the user is refused. `text` is the first message, from the coordinator |
| `open` | `{id, space?}` | Launches when stopped; returns once the terminal exists |
| `send` | `{to, from?, text}` | As above; adds `sent` and `note?` |
| `collect` | `{taken?: [key]}` | Removes the user's mail named in `taken`, then returns `{messages: [{key, from, title, id, text, created}]}`, oldest first. A client names what it handed over in its next call, so after a crash it gets it again. Refuses a key not of the form it returns |
| `rename` | `{id, title, by}` | An agent cannot change a `user` title |
| `order` | `{id, rank}` | |
| `place` | `{id, space}` | Only when stopped |
| `resolve` | `{id, by, from?}` | An agent: only a thread, only from its coordinator, not while `working` (waits up to 20 s for a finishing turn). Then as `close` |
| `unresolve` | `{id}` | Clears `resolved` |
| `close` | `{id}` | Kills the terminal carrying the label, read again right before the kill; a coordinator first closes its open threads and flags them `reopenWithProject` |
| `delete` | `{id}` | Closes, removes the conversation through the adapter and the record; a coordinator takes its threads. Prints `{deleted: [ids]}` |

Every other action returns the view, with `error` when part of it failed:
```
id, role, coordinator, title, titleSource, cwd, agent, resolved, rank, created, space, tab,
terminal (while running or starting), state: "running" | "starting" | "stopped",
status (hc's word, only when running), waiting (count), error?
```

## Launching and labels

`hc run --bg --json --no-parent --cwd CWD [--label herdr.space=S --label herdr.tab=T] --label
projects.session=ID --label projects.control=… --label projects.launched=1 -- env K=V …
PROJECTS_SESSION=ID PROJECTS_STATE_DIR=DIR <adapter argv>`, then `projects.pid` from the pid hc
reports (`env` execs the agent); no pid fails the launch. A thread starts in its
coordinator's space while that runs, else in its recorded space, else unplaced. A failed `hc run`
gives an `error`; mail stays.

Afterwards, and at every `register`, the terminals still labelled with the session that do not hold
it are read again. A terminal no longer live or labelled with this session is left alone. One core
started that is an empty shell (no status, nothing of its own in the foreground) is killed; every
other one loses its `projects.*` labels. A launch starts its new
terminal before that, so the tab and its space stay alive. A thread is launched with its project
when it is flagged `reopenWithProject` or left a terminal of core's behind: a reboot takes
everything down at once, so the flag may never be written. Stopping a session (`close`, `resolve`,
`delete`, and a coordinator's `release` for its threads) also kills an empty shell core started
for it, but leaves every other terminal as it is; only `delete`, which leaves no session to wait
for, takes the `projects.*` labels off one it leaves running.

- `projects.session=<id>`: the terminal running that session, and the one waiting for it while it is stopped.
- `projects.launched=1`: core started this terminal; a terminal the user started never carries it.
- `projects.pid=<agent pid>@<terminal pid>`: the agent process and the program hc ran in the terminal when it was bound (`pid` of `hc get`). A terminal hc brings back after a restart has another, so it never holds.
- `projects.control={"version":2,"command":["<stateDir>/bin/control"],"stateDir":"…"}`.
- `projects.changed=<ms>`: set after a change, on the session's terminal or its coordinator's.
- `projects.rank=<n>`: owned by the sidebar, which orders terminals outside any session by it; core never sets or clears it.

## Adapters

`core/adapters.mjs` maps an agent kind to a module exporting `start(record, coordinator)` (argv for
a new conversation), `resume(record, coordinator)` (argv to continue it, or nothing when there is
none yet), `env(record)` (a short allow-list from `record.adapter`) and `remove(record)` (delete
the conversation). At launch `coordinator` is the coordinator's record as it is now (a
coordinator's own) and `env` is called with it, so a thread starts the way its coordinator last
registered. A new thread's `adapter` is `{}`.

`pi/adapter.mjs` is the example.

## Inside a session

The adapter is the launch side. What runs inside each session (a plugin, hooks, or the agent
calling `control` from its shell) must do the following; `pi/projects.ts` is the example.

- **Report status to hc.** The agent tells its terminal `idle`, `working`, `done`, `blocked` or
  `error` (OSC 7501, hc's Program Status Protocol). hc never guesses it from the screen, and a
  session without a status stays `starting`, so its mail waits forever.
- **Run in an hc terminal.** `$HC_TERMINAL_ID` is the `terminal` for `register`.
- **Register at start.** A session launched by core finds its record as `$PROJECTS_SESSION` in
  `$PROJECTS_STATE_DIR`; a conversation the user starts or resumes finds it with `findRecord` on
  its adapter data.
  Call `register {id, cwd, agent, adapter, terminal, pid}` with the agent's own pid and the
  adapter data that lets `resume` find this conversation again. Without `id` it creates a
  project from the current conversation. Do not block start-up on it: it returns once waiting
  mail is typed, which needs the agent running.
- **Register again when the conversation is replaced** in the same terminal (a new or forked
  conversation keeps the project), with the new adapter data. Switching to another saved
  conversation leaves the project: `release`.
- **Release on exit:** `release {id}`. A crash skips it; the pid check covers that.
- **Tell the agent its role and what a message is.** A coordinator starts threads and carries
  on while they work; a thread sends its result to the coordinator when it is done (wording in
  `pi/prompts.mjs`). A `<message>` tag names who sent it through the project, and only
  `from="user"` is the user. What the user types is answered on the screen; a message from the
  user is answered, once complete, by `send` to `"user"`, and so is a question back. A session
  that never received a message from the user never writes to the user.
- **Give the agent the actions its role may use,** with `by: "agent"` and its own id as
  `from`/`coordinator`: a coordinator gets `create-thread`, `list`, `send`, `rename` and
  `resolve`; a thread gets `list`, `send` and `rename` (itself only). Show `list` for its own
  project only; `send` goes to its sessions or `"user"`. Never `delete`. Core refuses a thread's
  `resolve` but not the rest, so the integration enforces this.
- **Pass the user's own changes on:** a title the user sets is `rename` with `by: "user"`; input
  the user submits in a resolved session is `unresolve`. A title changed elsewhere shows in the
  session's record file.

## Known limits

- Messages are typed text by convention, not a security boundary. If one ever reached a shell,
  its first line fails, but later lines of a multi-line message would run.
- After a hard kill without a restart, another process that gets the agent's pid makes the terminal look alive.
- The pid check needs control, hc and the agents in one process namespace: same machine, no
  container or sandbox between them.
- A picker open in the agent swallows a message; when the agent was working this is silent.
- A draft left untouched for 60 s stops holding messages (hc's `draft_wait`).
- A tool that asks a startup question reports no status until it is answered; mail waits.
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
