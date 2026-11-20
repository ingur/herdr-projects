# herdr-projects

Sessions, projects and mail for [pi](https://pi.dev) in [herdr](https://herdr.dev) terminals.

Every pi you run in a herdr terminal is a session: it has a title, can be closed and opened again in its place, and can be sent a message without typing into its terminal. A session you turn into a project coordinates: it starts threads, which are other sessions that keep running on their own, that you can open and talk to, and that report back.

## What you need

Linux or macOS, herdr with `hc` (herdr-core) 0.1.20 or newer, Node 22.19 or newer on `PATH`, and pi. The sidebar that shows sessions and projects in herdr is [herdr-project-spaces](https://github.com/ingur/herdr-project-spaces); install this package first.

```sh
pi install git:github.com/ingur/herdr-projects
pi update --extensions
pi remove git:github.com/ingur/herdr-projects
```

## How it works

- In pi, `/projects new [name]` makes the session a project. There is no way back to a plain session, and a thread cannot become a project.
- Every session has `message_send` and `title_set`. In a project they also have `thread_list`. A coordinator also has `thread_start`, `thread_resolve` and `message_read`.
- A message is never typed into a terminal. It waits in the recipient's mailbox and its own pi takes it: an idle agent starts with it, a working agent gets it when the step it is on is done.
- Esc stops the agent as always. Mail that was still waiting then starts it again, as mail does for any idle agent.
- A message shows as one line, an envelope and `from …` or `to …`. Expand it to read all of it.
- The coordinator is shown what is said in its threads as short copies. A copy never wakes it; only a message does.
- A client (the sidebar, your avatar, `control`) lists sessions, sends your words and collects the replies. The agent answers a message from you with a message to you.
- Closing a project closes its threads. Opening it again brings back the ones that were open.
- After a herdr restart or a reboot, sessions stay stopped until you open them.
- Write in a resolved session, or send it a message, to reopen it.
- The title is shown as pi's session name. Rename from the sidebar, or with `/name` in pi.
- Only you can delete.
- State lives in `~/.local/state/herdr-projects`, per machine. Nothing is written into your repo.

[CONTRACT.md](CONTRACT.md) lists everything core can be asked, and by whom.

## Folders

| Folder or file | Holds | May use |
|---|---|---|
| `core` | Records, mailboxes, project logs, every rule, the tools and the instructions' wording. | `herdr` |
| `herdr` | Every call to `hc`. | Nothing of ours |
| `pi` | The extension and the adapter. | `core` |
| `control.mjs` | The command that clients run. | `core`, and the adapter from `pi` |
| `tests` | The tests. One of them fails when a folder uses what it may not. | Everything |

## Develop

```sh
dev/try-pi          # pi with this checkout, on its own folders under .state/
dev/smoke           # one project and one thread on a separate hc core, with your pi login
dev/mail            # the mail cases on real pi and hc with a scripted model: no login, no cost
npm test
```

## Known limits

- A session starts with herdr's environment plus the few variables pi needs, as pi last ran here; not with variables exported only in one shell.
- A pi that asks a question at startup (a login, how to open a session whose folder moved) takes no mail until you answer it.
- A session whose folder was moved opens only after Move folder; pi then asks at every open how to continue it.
- An agent that is killed in the middle of a run does not take the run up again when its session is opened. It has what it was sent, and waits for the next message or prompt.
- Everything is per machine. Sessions on a remote machine reached through herdr are that machine's own.
