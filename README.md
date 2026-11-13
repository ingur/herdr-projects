# herdr-projects

A [Pi](https://pi.dev) extension for long-running projects in [herdr](https://herdr.dev) terminals.

A project is one Pi session that coordinates. It can start threads: other Pi sessions that keep running on their own, that you can open and talk to directly, and that report back.

## Install

```sh
pi install git:github.com/ingur/herdr-projects
```

Needs `hc` (herdr-core) 0.1.20 or newer. Linux and macOS.

## Use

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
- A report to a closed project waits until you resume it.
- Write in a resolved thread to reopen it.
- Only you can delete.
- State lives in `~/.local/state/herdr-projects`. Nothing is written into your repo.

## Update, remove

```sh
pi update --extensions
pi remove git:github.com/ingur/herdr-projects
```

## Develop

```sh
dev/try-pi          # runs pi with this checkout, separate from your real setup
node --test tests/*.test.mjs
```

Other agent tools can plug into the same projects: see [CONTRACT.md](CONTRACT.md).

## Known limits

- Messages wait while you type, but a draft left alone for a minute no longer holds them.
- A picker open in the agent swallows a message.
- Threads get hc's environment plus Pi's own settings, not variables exported only in the coordinator's shell.
- Needs hc 0.1.20 or newer.
