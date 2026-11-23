# herdr-projects

Sessions, projects and mail for [pi](https://pi.dev) in [herdr](https://herdr.dev) terminals.

Every pi in a herdr terminal is a session. You can close it and open it again where it was, and send it a message without typing into its terminal.

Make a session a project and it becomes the project's coordinator. You tell it what needs doing and it starts threads: separate sessions that each do one piece of work and report back to it.

## Install

```sh
pi install git:github.com/ingur/herdr-projects
```

Linux and macOS. Needs herdr with `hc` 0.1.20, pi, and Node 22.19 or newer.

For the sidebar, install [herdr-project-spaces](https://github.com/ingur/herdr-project-spaces) after this.

## Use

`/projects new [name]` makes the session a project. This cannot be undone.

Give the coordinator work as it comes up. It starts a thread for work that needs its own conversation, and answers quick questions itself.

Write in a thread to steer it yourself.

Tools: `message_send`, `title_set`, `thread_list`, `thread_start`, `thread_resolve`, `message_read`.

## Good to know

- A message is never typed into a terminal. An idle agent starts on it. A working agent gets it after its current step.
- Esc stops the agent. Mail that is still waiting starts it again.
- A message shows as one line. Expand it to read all of it.
- The coordinator sees what is said in its threads as short copies, not every step they take. Only a message wakes it.
- A thread runs on pi's default model. Ask the coordinator if you want another model or thinking level for it.
- Closing a project closes its threads. Opening it brings back the unresolved ones.
- After a herdr restart or a reboot, sessions stay stopped until you open them.
- Write in a resolved session, or send it a message, to reopen it.
- Rename a session from the sidebar, or with `/name` in pi.
- Agents cannot delete anything. Only you can.
- State lives in `~/.local/state/herdr-projects`. Nothing is written into your repo.

## Limits

- A session starts with herdr's environment, not with variables you exported in one shell.
- A pi that asks a question at startup takes no mail until you answer it.
- A session whose folder was moved opens only after Move folder. Pi then asks at every open how to continue it.
- An agent killed in the middle of a run does not pick the run up again. It waits for the next message.
- Everything is per machine. Sessions on a remote machine belong to that machine.

## Update, remove

```sh
pi update --extensions
pi remove git:github.com/ingur/herdr-projects
```

## Develop

```sh
dev/try-pi          # pi with this checkout, on its own folders under .state/
dev/smoke           # one project and one thread on a separate hc core, with your pi login
dev/mail            # the mail cases on real pi and hc with a scripted model: no login, no cost
npm test
```

[CONTRACT.md](CONTRACT.md) lists everything core can be asked, and by whom.

| Folder or file | Holds | May use |
|---|---|---|
| `core` | Records, mailboxes, project logs, every rule, the tools and the instructions' wording. | `herdr` |
| `herdr` | Every call to `hc`, which terminal runs which session, and the command a client runs. | Only the path of `control.mjs`; it imports nothing of ours |
| `pi` | The extension and the adapter. | `core` |
| `control.mjs` | The command that clients run. | `core`, and the adapter from `pi` |
| `tests` | The tests. One of them fails when a folder uses what it may not. | Everything |
