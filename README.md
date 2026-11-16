# herdr-projects

Long-running projects for coding agents in [herdr](https://herdr.dev) terminals. A project is one agent session that coordinates: it starts threads, which are other sessions that keep running on their own, that you can open and talk to, and that report back.

Works with [Pi](https://pi.dev) today. Other agents can plug in through [CONTRACT.md](CONTRACT.md).

## Install (Pi)

```sh
pi install git:github.com/ingur/herdr-projects
```

Linux and macOS. Needs herdr, `hc` (herdr-core) 0.1.20 or newer, Pi 1.5 and Node 22.19 or newer.

Install this first, then the sidebar that shows projects in herdr, [herdr-project-spaces](https://github.com/ingur/herdr-project-spaces). [pi-subagents](https://github.com/ingur/pi-subagents) adds background subagents to Pi and works on its own.

## Use (Pi)

Start `pi` in a herdr terminal, then:

```text
/projects new My project
```

Now ask it to start threads, or use the sidebar ([herdr-project-spaces](https://github.com/ingur/herdr-project-spaces)).

| Command | |
| --- | --- |
| `/projects new [name]` | turn this session into a project |
| `/projects resume [name]` | open a stopped project in this terminal |

The agent gets these tools: `thread_start`, `thread_list`, `thread_send`, `thread_rename`, `thread_resolve`.

## Good to know

- Your typing always comes first. Messages from other sessions wait.
- Closing a project closes its threads. Resuming it brings back the ones that were open.
- After a reboot, projects stay stopped until you open one from the sidebar or use `/projects resume`. Its previously open, unresolved threads come back too. A shell you started yourself is kept.
- A report to a closed project waits until you resume it.
- Write in a resolved thread to reopen it.
- Only you can delete.
- State lives in `~/.local/state/herdr-projects`. Nothing is written into your repo.
- State is per machine. Another machine has its own projects.

## Update, remove (Pi)

```sh
pi update --extensions
pi remove git:github.com/ingur/herdr-projects
```

Removing the package leaves `~/.local/state/herdr-projects` behind.

## Develop

```sh
dev/try-pi          # runs pi with this checkout, separate from your real setup
node --test tests/*.test.mjs
```

## Known limits

- Messages wait while you type, but a draft left alone for a minute no longer holds them.
- A picker open in the agent swallows a message.
- Threads get hc's environment plus Pi's own settings, not variables exported only in the coordinator's shell.
