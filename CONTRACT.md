# Projects contract

hc runs terminals and types text in. `core/` keeps the records and decides who may send what to
whom, with no agent-specific code. An adapter starts, resumes and deletes one tool's conversations.
An integration inside each session binds it and gives the agent its tools.

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
cwd, agent: "pi", resolved, rank, created
space?, tab?                           Herdr placement, taken from the terminal's labels
reopenWithProject?: true               threads closed together with their project
waiting: [{from, title?, id?, text, created}]   mail not yet typed in
adapter: {}                            owned by the adapter
```

Writes go to a dot-file in the same directory, then rename. Updates are read-modify-write under
the session's lock file, which holds the owner's pid; a lock whose owner died is taken over.

## Running

A terminal holds a session while it is live, carries `projects.session=<id>`, and the process in
its `projects.pid` is alive. `running`: it reports an agent status (`idle`, `working`, `done`,
`blocked`, `error`). `starting`: no status yet, however long that takes. `stopped`: nothing holds
it; a labelled terminal whose agent died is left behind, and the next launch clears its
`projects.*` labels. Right before every `hc send` core checks that the terminal still holds the
session and reports a status other than `blocked`.

## Messages

```
<message from="coordinator|thread" title="TITLE" id="SESSION-ID">
TEXT
</message>
```

From the user it is `<message from="user">`. `&`, `"`, `<`, `>` in attribute values are escaped.
Text is 1 to 100000 characters. `send {to, from?, text}` (`from` absent means the user):

1. A resolved thread is reopened when its coordinator or the user sends; others are refused.
2. The message joins `waiting`, behind any older mail.
3. `running`: waiting mail goes out now. `blocked` keeps it stored until the next delivery.
4. `starting`: it stays stored and goes out at the session's `register`.
5. A stopped thread is launched and its mail goes out; a stopped coordinator keeps it for the user.

Delivery types waiting mail in order and removes each message once hc took it. After a launch
and at `register` it waits up to 60 s for the session to run. `sent` is true only when this
message was typed; when the recipient was `idle` or `done` and no turn started, the note says so.

## Actions

`node core/control.mjs ACTION 'JSON'` (also `<stateDir>/bin/control`) prints one JSON object;
errors print `projects: message` on stderr and exit 1. The same functions are `actions[name](options, io)` in `core/control.mjs`, next to `stateDirectory()`,
`readRecord(stateDir, id)` and `findRecord(stateDir, predicate)`. `by` is `"user"` or `"agent"`.

| Action | Options | Does |
|---|---|---|
| `list` | `{}` | `{sessions: [view], errors?}`: coordinators by rank, highest first, each followed by its threads, unresolved first, by rank |
| `register` | `{id?, title?, cwd, agent, adapter, terminal, pid}` | Binds the conversation in an hc terminal; `pid` is the agent's own process. Without `id` creates a coordinator (`title` gives `user`, none gives `New project`, `placeholder`). Refused while another terminal holds the session. Labels the terminal, saves `adapter`, `cwd` and placement, reopens unresolved `reopenWithProject` threads, delivers waiting mail |
| `release` | `{id}` | The session leaves its terminal: `projects.*` labels go; a coordinator's running threads are closed and flagged `reopenWithProject` |
| `create-thread` | `{coordinator, title?, cwd?, by, text?}` | New launched thread; `cwd` absolute or relative to the coordinator's. Titles unique per coordinator (ignoring case, also on rename), at most 80 characters, not `coordinator`; none gives `New thread`, `placeholder`. An existing title returns that thread with `existing: true` to an agent and sends nothing; the user is refused. `text` is the first message, from the coordinator |
| `open` | `{id, space?}` | Launches when stopped; returns once the terminal exists |
| `send` | `{to, from?, text}` | As above; adds `sent` and `note?` |
| `rename` | `{id, title, by}` | An agent cannot change a `user` title |
| `order` | `{id, rank}` | |
| `place` | `{id, space}` | Only when stopped |
| `resolve` | `{id, by, from?}` | An agent: only a thread, only from its coordinator, not while `working` (waits up to 20 s for a finishing turn). Then as `close` |
| `reopen` | `{id}` | Clears `resolved` |
| `close` | `{id}` | Kills the terminal carrying the label, read again right before the kill; a coordinator first closes its running threads and flags them `reopenWithProject` |
| `delete` | `{id}` | Closes, removes the conversation through the adapter and the record; a coordinator takes its threads. Prints `{deleted: [ids]}` |

Every other action returns the view, with `error` when part of it failed:
```
id, role, coordinator, title, titleSource, cwd, agent, resolved, rank, created, space, tab,
terminal (while running or starting), state: "running" | "starting" | "stopped",
status (hc's word, only when running), waiting (count), error?
```

## Launching and labels

`hc run --bg --json --no-parent --cwd CWD --name SLUG-ID8 [--label herdr.space=S --label
herdr.tab=T] --label projects.session=ID --label projects.control=… -- env K=V …
PROJECTS_SESSION=ID <adapter argv>`, then `projects.pid` from the pid hc reports (`env` execs the
agent). A thread starts in its coordinator's space while that runs, else in its recorded space,
else unplaced. A failed `hc run` gives an `error`; mail stays.

- `projects.session=<id>`: the terminal running that session.
- `projects.pid=<pid>`: the agent process; the terminal counts only while it is alive.
- `projects.control={"version":2,"command":["<stateDir>/bin/control"],"stateDir":"…"}`.
- `projects.changed=<ms>`: set after a change, on the session's terminal or its coordinator's.

## Adapters

`core/adapters.mjs` maps an agent kind to a module exporting `start(record)` (argv for a new
conversation), `resume(record)` (argv to continue it, or nothing when there is none yet),
`env(record)` (a short allow-list from `record.adapter`), `inherit(record)` (adapter data a new
thread of this coordinator starts with) and `remove(record)` (delete the conversation).

Pi keeps `{sessionId, sessionFile, command, env}`, `env` limited to `ENV` in `pi/adapter.mjs`.
`resume` uses `--session FILE` once it exists, else `--session-id ID`; `start` adds `--name TITLE`;
`inherit` copies only `command` and `env`. `remove` deletes the transcript only when it is a
regular file inside a Pi sessions directory whose header names `sessionId`.

## Inside a session

The adapter is the launch side. What runs inside each session (a plugin, hooks, or the agent
calling `control` from its shell) must do the following; `pi/projects.ts` is the example.

- **Report status to hc.** The agent tells its terminal `idle`, `working`, `done`, `blocked` or
  `error` (OSC 7501, hc's Program Status Protocol). hc never guesses it from the screen, and a
  session without a status stays `starting`, so its mail waits forever.
- **Run in an hc terminal.** `$HC_TERMINAL_ID` is the `terminal` for `register`.
- **Register at start.** A session launched by core finds its record id in `$PROJECTS_SESSION`.
  Call `register {id, cwd, agent, adapter, terminal, pid}` with the agent's own pid and the
  adapter data that lets `resume` find this conversation again. Without `id` it creates a
  project from the current conversation. Do not block start-up on it: it returns once waiting
  mail is typed, which needs the agent running.
- **Register again when the conversation is replaced** in the same terminal (a new or forked
  conversation keeps the project), with the new adapter data.
- **Release on exit:** `release {id}`. A crash skips it; the pid check covers that.
- **Tell the agent its role and what a message is.** A coordinator starts threads and carries
  on while they work; a thread sends its result to the coordinator when it is done (wording in
  `pi/prompts.mjs`). A `<message>` tag names who sent it through the project, and only
  `from="user"` is the user.
- **Give the agent the actions its role may use,** with `by: "agent"` and its own id as
  `from`/`coordinator`: a coordinator gets `create-thread`, `list`, `send`, `rename` and
  `resolve`; a thread gets `list`, `send` and `rename` (itself only). Show `list` for its own
  project only. Never `delete`. Core refuses a thread's `resolve` but not the rest, so the
  integration enforces this.
- **Pass the user's own changes on:** a title the user sets is `rename` with `by: "user"`; input
  the user submits in a resolved session is `reopen`. A title changed elsewhere shows in the
  session's record file.

## Known limits

- Messages are typed text by convention, not a security boundary. If one ever reached a shell,
  its first line fails, but later lines of a multi-line message would run.
- After a hard kill, another process that gets the same pid makes the terminal look alive.
- The pid check needs control, hc and the agents in one process namespace: same machine, no
  container or sandbox between them.
- A picker open in the agent swallows a message; when the agent was working this is silent.
- A draft left untouched for 60 s stops holding messages (hc's `draft_wait`).
- A tool that asks a startup question reports no status until it is answered; mail waits.
- Requires hc 0.1.20 or newer.
