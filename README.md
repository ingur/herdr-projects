# herdr-projects

Long-running projects for coding agents in [herdr](https://herdr.dev) terminals. A project is one agent session that coordinates: it starts threads, which are other sessions that keep running on their own, that you can open and talk to, and that report back.

Works with [Pi](https://pi.dev), [omp](https://omp.sh) and [Claude Code](https://code.claude.com), also mixed in one project. Another agent plugs in by meeting [CONTRACT.md](CONTRACT.md).

## What you need

Linux or macOS, herdr with `hc` (herdr-core) 0.1.20 or newer, Node 22.19 or newer on `PATH`, and at least one of the agents below. The sidebar that shows projects in herdr is [herdr-project-spaces](https://github.com/ingur/herdr-project-spaces); install this package first.

## How it works

- Start your agent in a herdr terminal and make the conversation a project with the agent's command below.
- The coordinator gets five tools: `thread_start`, `thread_list`, `thread_send`, `thread_rename`, `thread_resolve`. A thread gets `thread_list`, `thread_send` and `thread_rename`.
- A thread can run on any installed agent; the coordinator names it when it starts the thread.
- Your typing always comes first. Messages from other sessions wait.
- Closing a project closes its threads. Opening it again, from the sidebar or by resuming its conversation in the agent, brings back the ones that were open.
- After a reboot, projects stay stopped until you open them.
- A report to a closed project waits until you open it.
- Write in a resolved thread to reopen it.
- The project's title is shown as the agent's session name. Rename from the sidebar.
- Only you can delete.
- State lives in `~/.local/state/herdr-projects`, per machine. Nothing is written into your repo.

## Pi

```sh
pi install git:github.com/ingur/herdr-projects
```

In Pi: `/projects new [name]`.

```sh
pi update --extensions
pi remove git:github.com/ingur/herdr-projects
```

## omp

```sh
omp plugin install github:ingur/herdr-projects
```

In omp: `/projects new [name]`.

```sh
omp plugin upgrade @ingur/herdr-projects
omp plugin uninstall @ingur/herdr-projects
```

## Claude Code

```sh
claude plugin marketplace add ingur/herdr-projects
claude plugin install projects@herdr-projects
```

In Claude Code: `/projects:new [name]`. Claude Code asks once before a project's tool is first used in a session you started; sessions a project starts have them allowed.

```sh
claude plugin update projects@herdr-projects
claude plugin uninstall projects@herdr-projects
```

## Develop

```sh
dev/try-pi          # the agent with this checkout, on its own folders under .state/
dev/try-omp
dev/try-claude
dev/smoke pi        # one project and one thread of that agent on a separate hc core
npm test
```

## Known limits

- Messages wait while you type, but a draft left alone for a minute no longer holds them.
- A picker open in the agent swallows a message.
- A session starts with herdr's environment plus the few variables its agent needs, as that agent last ran here; not with variables exported only in one shell.
- An agent that asks a question at startup (a login, a folder trust) gets no messages until you answer it.
