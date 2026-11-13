# pi-projects

Long-running projects for [Pi](https://pi.dev) in [herdr](https://herdr.dev) terminals.

A project is one Pi session that coordinates. It can start threads: other Pi sessions that keep running on their own, that you can open and talk to directly, and that report back.

## Install

```sh
pi install git:github.com/ingur/pi-projects
```

Needs `hc` (herdr-core). Linux and macOS.

## Use

Start `pi` in a herdr terminal, then:

```text
/projects init My project
```

Now ask it to start threads, or use the sidebar ([herdr-project-spaces](https://github.com/ingur/herdr-project-spaces)).

| Command | |
| --- | --- |
| `/projects` | status |
| `/projects init [name]` | turn this session into a project |
| `/projects resume` | let waiting messages in again after you pressed Esc |
| `/projects retry ID` | deliver one uncertain message again |

The agent gets these tools: `thread_start`, `thread_list`, `thread_send`, `thread_rename`, `thread_resolve`, `thread_reopen`.

## Good to know

- Your typing always comes first. Messages from other sessions wait.
- Closing a project does not stop its threads.
- Write in a resolved thread to reopen it.
- Only you can delete.
- State lives in `~/.local/state/pi-projects`. Nothing is written into your repo.

## Update, remove

```sh
pi update --extensions
pi remove git:github.com/ingur/pi-projects
```

## Develop

```sh
dev/try-pi          # runs pi with this checkout, separate from your real setup
node --test tests/*.test.mjs
```

Other agent tools can plug into the same projects: see [CONTRACT.md](CONTRACT.md).
