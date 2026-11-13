import { getSelectListTheme, keyHint, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, SelectList, Text } from "@earendil-works/pi-tui";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";
import { actions, readRecord, stateDirectory } from "../core/control.mjs";

type Project = { id: string; title: string; cwd: string; resolved: boolean };

function displayFolder(folder: string, home = homedir()) {
  return folder === home ? "~" : folder.startsWith(`${home}${sep}`) ? `~${folder.slice(home.length)}` : folder;
}

function matchProject(candidates: Project[], text: string) {
  const query = text.trim().toLowerCase();
  if (!query) return undefined;
  const exact = candidates.filter(row => row.title.toLowerCase() === query);
  const matches = exact.length ? exact : candidates.filter(row => row.title.toLowerCase().includes(query));
  return matches.length === 1 ? matches[0] : undefined;
}

function pickProject(ctx: ExtensionCommandContext, candidates: Project[], query: string) {
  return ctx.ui.custom<Project | undefined>((tui, theme, _kb, done) => {
    const container = new Container();
    const input = new Input();
    const items = candidates.map(row => ({ value: row.title, label: `${row.title}${row.resolved ? " (resolved)" : ""}`, description: displayFolder(row.cwd) }));
    const list = new SelectList(items, 8, getSelectListTheme());
    input.setValue(query);
    list.setFilter(query);
    list.onSelect = item => done(candidates[items.indexOf(item)]);
    list.onCancel = () => done(undefined);
    container.addChild(new Text(theme.fg("accent", "Resume project — type to filter"), 1, 0));
    container.addChild(input);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", `${keyHint("tui.select.confirm", "resume")} ${keyHint("tui.select.cancel", "cancel")}`), 1, 0));
    return {
      capturesViewportInput: true,
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        const kb = getKeybindings();
        if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel"] as const).some(key => kb.matches(data, key))) list.handleInput(data);
        else {
          input.handleInput(data);
          list.setFilter(input.getValue());
        }
        tui.requestRender();
      },
    };
  });
}

// Switching starts a fresh Pi session; its session_start registers the project in this terminal.
// Returns the id of a project that has no saved conversation, for the caller to bind here.
export async function resumeProject(ctx: ExtensionCommandContext, query: string): Promise<string | undefined> {
  let file: string;
  try {
    const { sessions } = await actions.list({});
    const candidates: Project[] = sessions.filter(view => view.agent === "pi" && view.role === "coordinator" && view.state === "stopped")
      .sort((a, b) => Number(a.resolved) - Number(b.resolved));
    if (!candidates.length) { ctx.ui.notify("No projects to resume.", "info"); return; }
    const selected = matchProject(candidates, query) ?? await pickProject(ctx, candidates, query);
    if (!selected) return;
    file = readRecord(stateDirectory(), selected.id)?.adapter?.sessionFile;
    if (!file || !existsSync(file)) {
      if (existsSync(selected.cwd) && realpathSync(ctx.cwd) === realpathSync(selected.cwd)) return selected.id;
      throw new Error(`This project has no saved conversation yet. Start Pi in ${displayFolder(selected.cwd)} and resume it there.`);
    }
  } catch (error) {
    ctx.ui.notify(`Projects: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  // Replacement invalidates this ctx; only the fresh one may touch Pi.
  await ctx.switchSession(file, { withSession: async fresh => {
    const folder = realpathSync(fresh.cwd);
    if (folder !== process.cwd()) fresh.ui.notify(`This project is now working in ${displayFolder(folder)}.`, "info");
  } });
}
