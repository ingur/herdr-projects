# Projects adapter contract

`@ingur/pi-projects` is an ordinary Pi package. Run plain `pi`; there is no
launcher, alternate profile, argument filter or bundled subagent extension.
The tool-neutral lifecycle, registry and transport live in `core/`; `pi/` owns
Pi registration, launch capture, transcripts, receipts and tools. `core/lib/`
contains private copies of the small state/process/delivery helpers. No other
repository or shared package is needed. Herdr is optional; hc is required for
registered sessions and terminal lifecycle operations.

## State and normal sessions

State defaults to `${XDG_STATE_HOME:-~/.local/state}/pi-projects`.
`PI_PROJECTS_STATE_DIR` selects one absolute directory; control options can select
`stateDir` explicitly. State never defaults beside the installed package.
`Store` uses `stateDir/projects/SHA256(projectRoot)`, with an absolute canonical
project root and full UUID session IDs. Multiple coordinators may share a root;
each thread belongs to one coordinator.

An ordinary session with no record for its Pi UUID is dormant: no footer, notice,
polling, editor observer or active project tools. `/new`, `/resume` and `/fork`
remain untouched. `/projects` gives one init/open hint. `/projects init [name]`
promotes the current persistent conversation, retaining its UUID, transcript,
cwd and terminal. Any local hc terminal works; outside one it explains that an
hc terminal is needed. `herdr.space` and `herdr.tab` are independent optional
presentation labels, not prerequisites. Sessions without placement launch with
no Herdr placement labels and remain reachable with `hc attach`. Core retains
their records; it defines no "Unplaced" UI group.

On every `session_start`, including reload/resume, the adapter looks up the Pi
session ID across all project records. A match supplies root, role and coordinator;
no launch-role environment is used. Registration takes both writer locks inside
the extension. Live or uncertain competing ownership causes a notice and graceful
Pi shutdown before registration or conversation mutation. Session replacement
(`/new`, `/resume`, `/fork`, or `ctx.switchSession`) first awaits the same cleanup
as shutdown: deactivate tools, clear status/editor observation, remove this
session's terminal labels, mark it offline without a process owner, and release
both locks. Herdr placement labels stay on the terminal. Pi then loads a fresh
extension instance, which registers only a matching session UUID. A fork has a
new UUID and is ordinary, never a second project. `/reload` follows the same
cleanup/registration path. No lock is taken by an external launcher or held before
Pi's trust prompt. This is a cooperative local protocol, not an OS security boundary.

`/projects open [name]` lists stopped Pi coordinators across the state directory,
excluding this session and live/uncertain writers. Existing observation,
registration and creation timestamps order most-recently-used first; resolved
projects come last. The native filterable picker shows title and folder. A unique
case-insensitive exact title, otherwise a unique substring, opens directly;
other text pre-filters the picker. Opening switches to the validated recorded
conversation in this terminal and registers its current space/tab (or neither).
Pi rebuilds its runtime and tools in the conversation's own cwd, including across
folders; a fresh replacement context announces that folder when it differs from
the terminal's launch directory. Unwritten conversations are explained with the
UUID/folder needed to start them; no transcript or new identity is fabricated.

## Schema version 1

Records, pause controls, deliveries and message envelopes carry `version: 1`.
There is no migration; incompatible stored versions are rejected, not rewritten.
Required record fields:

- `version`, `id`, `projectRoot`, `title`, `titleSource` (`placeholder`, `agent`, `human`).
- `agent` (currently `pi`), `role` (`coordinator` or `thread`), `coordinator` (self for coordinators).
- `cwd`, `registration` (`awaiting-extension`, `registered`, `offline`).

Optional lifecycle/binding fields:

- `space`, `tab`, `terminal`, `resolved`, `resolvedBy: {kind: "human"|"agent", session?}`.
- `created`, `registered`, `observed`; finite `rank` defaults to creation milliseconds.
- `launchState`: `claimed`, `requested`, `observed`, `registered`, `failed`, `unknown`;
  `launchToken`, `launchBoot`, `launchError`.
- `owner`: PID, platform start time, boot identity, process state and lock token.
- `initial`: message held until its recipient registers.
- Pi's observed `sessionFile`, `sessionDir`, and `transcriptState` (`expected` or `unwritten`).

Transcripts remain in Pi's normal session location and are visible in `/resume`.
Registration records the file and directory reported by Pi. An unwritten UUID
may acquire a new filename after restart; an observed transcript is never reset
to unwritten. Reopen validates header ID/cwd and realpath containment in the
observed directory. A lost expected transcript refuses empty-context recovery.
Delete validates the same header and containment and rejects symlinked transcript
entries; missing files are already removed. It never deletes subagent-package
state or any unrelated conversation.

Thread names are unique per coordinator. Unnamed creation reserves `New thread`,
`New thread 2`, etc. Human duplicates receive suffixes; repeated agent names return
the existing thread without replacing its initial instruction. Agent renames
cannot replace human titles. Lifecycle notices go only to a thread's coordinator
and are informational. Order coordinators by descending rank, then their open
threads, then resolved threads, each by descending rank; equal ranks use UUID.
Catalogs retain resolved rows and group different project roots first.

## Adapter obligations and ownership

A new adapter must implement the complete boundary, not just supply a command:

1. Add a known runtime kind and lazy launch/removal selection in
   `core/agent-runtimes.mjs`. `list` must work without loading any adapter files.
   Loading may be asynchronous; the loaded removal operation runs synchronously
   under writer, extension and registry locks. Unknown kinds fail closed.
2. Use `core/lib/state.mjs`'s exact lock protocol. The running adapter holds
   `stateDir/writer-locks/<id>` and `projectDir/locks/extension-<id>` for its
   lifetime, records their process identity, and releases only its own generation.
   Save an offline observation and clear the process owner on shutdown or
   replacement before release. Live/unknown owners block recovery and deletion.
   Incomplete writes get one second of grace; reclamation removes observed
   filenames, never a racing replacement directory.
3. Verify the local live hc address. Registered ownership requires the adapter
   process to descend from hc's terminal PID; project/session labels must not
   conflict. Before registration, a starting terminal is owned only when its
   address equals the record's terminal, it is live, and its `projects.session`
   and `projects.launch` match our launch claim. No pre-registration writer lock
   is required: this permits showing Pi's native trust prompt.
4. Register with explicit runtime, role/coordinator/root/cwd and observed placement;
   missing placement is valid and clears stale labels from the record. Take both
   locks before registration. Persist through `Store`'s atomic registry operations.
5. At each registration atomically replace executable `stateDir/bin/control` and
   `stateDir/bin/pi`, then advertise via `publishControlDescriptor`. It verifies
   ancestry and writes `projects.session`, `projects.project`, `projects.control`.
6. Publish `initial` only after the recipient registers. Persist attempts before
   injection; reconcile receipts honestly. Use `projectDir/inboxes/<id>/<message>.json`,
   `deliveries/<id>/<message>.json`, and `controls/<id>.json`.
   Controls are `{version:1, paused, reason?, at?}`; deliveries contain `version:1`,
   `state`, `execution` and optional attempt time/entry ID.
7. Use the copied process helpers. Linux identity is PID + `/proc` start ticks +
   boot ID. macOS is PID + UTC `ps lstart` second + `kern.bootsessionuuid`; reuse
   within one second cannot be distinguished without native OS access. Unknown
   ownership fails closed. Unsupported platforms refuse state creation. Catalogs
   share one process table per invocation; destructive decisions use fresh reads.

## Stable commands

`projects.control` is exactly
`{version:1, command:["<stateDir>/bin/control"], stateDir:"<stateDir>"}`.
It never embeds a versioned Node path. The shims use the captured PATH, explicit
Pi home/session-dir overrides when present, and `PI_PROJECTS_STATE_DIR`.

Pi capture prefers `pi` on that PATH only when its resolved executable is this
Pi entry, or its recognized Nix wrapper execs this exact Node and entry script.
The profile symlink then follows upgrades without re-registering a stopped
session. An unrelated PATH Pi is never substituted. Otherwise the fallback is
this `process.execPath`, `process.execArgv`, and entry script. Explicit `-e`
extensions are retained with absolute local paths, so local package try-outs
also propagate to threads. `PI_PROJECTS_PI_COMMAND` is the one command override:
a JSON argv array beginning with an absolute executable (for example
`["/absolute/path/to/pi"]`). The control shim uses `node` on the captured PATH,
falling back to this Node executable only if unavailable. Exact-runtime fallback
paths can become unavailable after package garbage collection; re-register with
a working Pi to refresh them.

On the inspected Nix host, `/etc/profiles/per-user/ingur/bin/pi` resolves to the
Pi 1.5.2 wrapper, which only edits PATH for Node/clipboard/ripgrep/fd and execs
its Node 22.23.4 plus `dist/bundle/cli.js`. Capturing the matched profile entry
preserves those wrapper effects and follows later profile upgrades.

New sessions launch as `bin/pi --session-id <uuid> --name <title>`; retained
transcripts use `bin/pi --session <file>`. hc receives `run --bg --json --no-parent
--cwd <cwd>`, optional placement labels, the session/project/launch labels, then
`--` and that argv. Neither hc's PATH nor a Herdr installation supplies Pi or Node
selection. A lost hc reply is uncertain, not proof of failed launch. Recovery
requires dead writers and no live/uncertain terminal carrying the session label.

## Control API and UI boundary

Run `pi-projects ACTION '<JSON options>'`, `node core/control.mjs ACTION ...`,
or the advertised control shim. Success prints one JSON value; failures use
stderr/nonzero exit. Every action accepts `stateDir?`; session actions require
`projectRoot` and exact `id`. These local commands and attribution fields are not
an authentication boundary.

- `list {projectRoot?}` returns sessions and observation errors, without mutation.
- `create {projectRoot,title,space?,agent?}` reserves a coordinator and ensures it.
- `create-thread {projectRoot,id:coordinator,title?,by?,cwd?,initial?}` reserves a
  thread and ensures it. `by` defaults to agent; `cwd` accepts absolute or
  project-relative directories, including outside the project.
- `ensure` and `show {projectRoot,id,space?}` recover only the same conversation.
  Live sessions ignore requested placement. Stopped threads follow their
  coordinator's verified live or current recorded placement, including no space
  after an unplaced registration; others retain their own. A placed session gets
  a tab ID if missing. `show` returns `readyToFocus`; the caller, not core, focuses
  it. Neither operation resumes paused work.
- `place {projectRoot,id,space}` rehomes only a stopped session; uncertain/live
  ownership blocks it. No launch, terminal move or child-record rewrite.
- `rename {projectRoot,id,title,by?}` defaults to human authorship. `order
  {projectRoot,id,rank}` persists a finite numeric rank. Neither launches work.
- `send {projectRoot,id,text,note?,sender:{kind,title,session?}}` publishes durably,
  then ensures availability. Recovery failure does not discard the message.
  Text/note limits are 1–100000 characters. Agent sends to resolved threads
  require explicit reopen; human sends reopen resolved recipients.
- `close {projectRoot,id}` kills only the verified owned terminal, retaining
  transcript, registry, inbox and children. Closing a parent also stops its
  running subagents; unrelated live shells are never killed.
- `delete {projectRoot,id}` is not exposed as an agent tool (not access-controlled).
  It closes verified live terminals, waits for dead writers, takes all locks,
  deletes the validated conversation and transport, then removes the record last.
  Coordinator deletion includes its threads, in UUID order before the coordinator.
  A failed cascade reports already-deleted IDs and retains the failing record.
- `resolve` and `reopen {projectRoot,id,by?,session?}` set/clear organizational
  resolution; `by` defaults to human. Agent calls refuse coordinator targets.
  Reopen ensures availability but does not replay an interrupted turn or clear pause.

Session views include identity/title/role/coordinator/agent/cwd, optional space/tab/
terminal, resolved/rank/registration/writer/paused/terminalState/terminalOwned/
launchState, optional created/registered/observed timestamps, and optional error.
The Herdr sidebar depends only on the descriptor
and actions, not registry files. `projects.project` is the project-root hash;
`projects.launch` is a unique launch token. `projects.rank` is UI-owned for
independent terminals only. Core records no UI grouping for missing placement;
the sidebar lists only sessions belonging to an existing space, retaining all
records, conversations and threads when their space is gone.

## Delivery and Pi composition

Envelopes are `{version:1,id,projectRoot,recipient,created,sender,author,text,
source?,via:[],note?,informational?}`. Authors contain `kind,title,session?,role?,type?`;
source references contain `session,entry?,toolCall?`; forwarding adds attributed
hops while preserving exact text and original authorship. Attachment-bearing
entries cannot be forwarded as if they were text. Publication is idempotent only
for identical ID/content; conflicting content is rejected.

Delivery distinguishes pending, attempting, visible-not-durable, recorded,
uncertain and explicit retry authorization. A receipt is not completed work;
exactly-once execution is not claimed. Uncertain attempts never replay silently.
Pi's synchronous append/rollback semantics let visible entries plus an existing
session file establish durable receipt; the adapter does not reread the transcript
on every tick.

Project messages, including initial instructions and queued inbox messages, wake
normally after start, reopen and reload; no first human prompt is required.
Delivery still requires a selected model and a quiet idle boundary: no draft,
pending input, open prompt, active turn or pause. Opening a session never clears
an existing abort pause. Esc/Ctrl+C while idle pauses nothing; an aborted settled
run pauses delivery, and human input or explicit resume releases that pause.
Informational notices never request turns. Replayed subagent completions follow
the separate subagent extension's wake policy; `/reload` stops its running children.

Tools (`thread_start`, `thread_list`, `thread_send`, `thread_rename`,
`thread_resolve`, `thread_reopen`) register with `defaultActive:false` and activate
only after registration, preserving other tools. `/projects` supports `init`,
`open [name]`, `resume`, `retry MESSAGE_UUID`, and status. Native `/name` is human-authored.
Human prompts reopen resolved sessions; after a human turn, only a thread resolved
by a different identified agent is reopened. Self/human resolution is retained.

Instructions compose through `before_agent_start.systemPromptOptions.sections`.
The editor observer wraps/restores the previous editor and shares
`Symbol.for("pi.extensions.editor-observer")` with pi-subagents. When focus cannot
be observed it reports that limitation; the remaining human-interaction gates
still apply. `typebox` and the Pi host packages are peer dependencies supplied by
Pi's extension loader, not bundled private copies.
