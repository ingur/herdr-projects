# Projects contract

hc runs terminals and types text in. `core/` keeps the records and decides who may send what to
whom, with no agent-specific code. An adapter starts, resumes and deletes one tool's conversations.

## Records

`stateDir` is `options.stateDir`, else `$PI_PROJECTS_STATE_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/pi-projects`.

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

Core asks hc for live terminals labelled `projects.session=<id>`. `running`: one of them reports
an agent status (`idle`, `working`, `done`, `blocked`, `error`). `starting`: none does yet and
one was created less than 60 s ago. `stopped`: anything else; a labelled terminal without a
status after 60 s is a shell left behind, and the next launch removes its `projects.*` labels.
Before every `hc send` core reads the terminal again; it must carry the label and report a
status other than `blocked`, so nothing is ever typed into a shell.

## Messages

```
<message from="coordinator|thread" title="TITLE" id="SESSION-ID">
TEXT
</message>
```

From the user it is `<message from="user">`. `&`, `"`, `<`, `>` in attribute values are escaped.
Text is 1 to 100000 characters. `send {to, from?, text}` (`from` absent means the user):

1. A resolved thread is reopened when its coordinator or the user sends; others are refused.
2. `running`: `blocked` types and stores nothing (`sent: false`). Otherwise hc types it; when the
   recipient was `idle` or `done` and no turn started, the note says so.
3. `starting`: wait up to 30 s for `running`, then as 2, else as 4 or 5.
4. A stopped thread: the message joins `waiting`, the thread is launched, waiting mail goes out.
5. A stopped coordinator: the message joins `waiting`. Only the user resumes a project.

Waiting mail goes out (after `send` launched a thread, after `create-thread`, at every
`register`) once the session reports a status within 60 s: in order, each removed once hc took it.

## Actions

`node core/control.mjs ACTION 'JSON'` (also `<stateDir>/bin/control` and the `pi-projects` bin
link) prints one JSON object; errors print `projects: message` on stderr and exit 1. The same
functions are `actions[name](options, io)` in `core/control.mjs`, next to `stateDirectory()`,
`readRecord(stateDir, id)` and `findRecord(stateDir, predicate)`. `by` is `"user"` or `"agent"`.

| Action | Options | Does |
|---|---|---|
| `list` | `{}` | `{sessions: [view], errors?}`: coordinators by rank, highest first, each followed by its threads, unresolved first, by rank |
| `register` | `{id?, title?, cwd, agent, adapter, terminal}` | Binds the conversation in an hc terminal; without `id` creates a coordinator (`title` gives `user`, none gives `New project`, `placeholder`). Refused while another live terminal with a status carries the label. Labels the terminal, saves `adapter`, `cwd` and placement, reopens unresolved `reopenWithProject` threads, delivers waiting mail |
| `release` | `{id}` | The session leaves its terminal: `projects.*` labels go; a coordinator's running threads are closed and flagged `reopenWithProject` |
| `create-thread` | `{coordinator, title?, cwd?, by, text?}` | New launched thread; `cwd` absolute or relative to the coordinator's. Titles unique per coordinator (ignoring case), at most 80 characters, not `coordinator`; none gives `New thread`, `placeholder`. An existing title returns that thread with `existing: true` to an agent and sends nothing; the user is refused. `text` is the first message, from the coordinator |
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
PROJECTS_SESSION=ID <adapter argv>`. A thread starts in its coordinator's space while that runs,
else in its recorded space, else unplaced. hc has no rename, so `register` cannot name a
terminal. A failed `hc run` gives the result an `error`; waiting mail stays.

- `projects.session=<id>`: the terminal running that session.
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

## Known limits

- Messages are typed text by convention, not a security boundary.
- A picker open in the agent swallows a message; when the agent was working this is silent.
- A draft left untouched for 60 s stops holding messages (hc's `draft_wait`).
- A tool that asks a startup question reports no status until it is answered; mail waits.
- Requires hc 0.1.20 or newer.
