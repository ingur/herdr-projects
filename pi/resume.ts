import { getSelectListTheme, keyHint, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, SelectList, Text } from "@earendil-works/pi-tui";
import { listSessions } from "../core/control.mjs";
import { LOCAL_TERMINAL } from "../core/hc.mjs";
import { canonicalPath } from "../core/lib/state.mjs";
import { stateDirectory } from "../core/store.mjs";
import { describeError, type ThreadRecord } from "../core/contracts.ts";
import { findSessionRecord } from "./registration.mjs";
import { launchCwd } from "./pi-launch.mjs";
import { changedWorkingFolder, displayFolder, matchProject, projectCandidates, projectConversation } from "./resume.mjs";

type Project = Pick<ThreadRecord, "id" | "title" | "cwd" | "resolved">;

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

export async function resumeProject(ctx: ExtensionCommandContext, query: string) {
  let file: string;
  try {
    if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Resuming a project requires interactive Pi.");
    if (!LOCAL_TERMINAL.test(process.env.HC_TERMINAL_ID ?? "")) throw new Error("Open an hc terminal and run /projects resume there.");
    const stateDir = stateDirectory();
    const catalog = await listSessions({ stateDir });
    const candidates = projectCandidates(catalog.sessions, ctx.sessionManager.getSessionId());
    if (!candidates.length) { ctx.ui.notify("No projects to resume.", "info"); return; }
    const selected = matchProject(candidates, query) ?? await pickProject(ctx, candidates, query);
    if (!selected) return;
    const record = findSessionRecord(stateDir, selected.id);
    if (!record) throw new Error("This project no longer exists.");
    file = projectConversation(record);
  } catch (error) {
    ctx.ui.notify(`Projects: ${describeError(error)}`, "error");
    return;
  }
  // Replacement invalidates this closure's ctx and pi; only the fresh callback may touch Pi.
  return ctx.switchSession(file, { withSession: async fresh => {
    const folder = changedWorkingFolder(canonicalPath(fresh.cwd), canonicalPath(launchCwd));
    if (folder) fresh.ui.notify(`This project is now working in ${folder}.`, "info");
  } });
}
