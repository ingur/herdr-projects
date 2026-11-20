import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agent from "../core/agent.mjs";
import * as client from "../core/client.mjs";
import * as extension from "../core/extension.mjs";
import { readRecord, writeRecord } from "../core/state.mjs";
import { control } from "../core/terminals.mjs";

export const DEAD = 2 ** 31 - 1, ME = process.pid, OTHER = process.ppid;

// hc, as far as core uses it: terminals with labels, a pid and a status.
function fakeHc() {
  const rows = [], calls = [];
  const find = address => {
    const row = rows.find(row => row.address === address);
    if (!row) throw new Error(`hc: no terminal ${address}`);
    return row;
  };
  const labels = pairs => Object.fromEntries(pairs.map(pair => pair.split(/=(.*)/s).slice(0, 2)));
  const io = {
    rows, calls,
    delay: () => new Promise(resolve => setImmediate(resolve)),
    terminal(labels = {}, status = "idle") {
      const row = { address: `t${rows.length + 1}`, state: "live", pid: ME, labels, status: status ? { app: "tool", state: status } : null };
      rows.push(row);
      return row;
    },
    async command(program, args) {
      calls.push(args);
      const [verb] = args;
      if (io.down) throw new Error(`hc ${verb}: no server`);
      if (verb === "ls") {
        const [[key, value]] = Object.entries(labels([args[args.indexOf("--label") + 1]]));
        return { terminals: rows.filter(row => row.state === "live" && row.labels[key] === value).map(({ address, state }) => ({ address, state })) };
      }
      if (verb === "get") return structuredClone(find(args[1]));
      if (verb === "label") {
        const row = find(args[1]);
        for (const [key, value] of Object.entries(labels(args.slice(3)))) {
          if (value) row.labels[key] = value; else delete row.labels[key];
        }
        return structuredClone(row);
      }
      if (verb === "run") {
        const row = io.terminal(labels(args.filter((arg, index) => args[index - 1] === "--label")), io.startsWith ?? null);
        row.argv = args.slice(args.indexOf("--") + 1);
        row.folder = args[args.indexOf("--cwd") + 1];
        return { address: row.address, state: "live" };
      }
      if (verb === "exec") return { code: io.missing === args.at(-1) ? 1 : 0 };
      if (verb === "kill") {
        find(args[1]).state = "finished";
        return structuredClone(find(args[1]));
      }
      throw new Error(`unexpected hc ${verb}`);
    },
  };
  return io;
}

export function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-projects-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), folder = join(root, "work"), io = fakeHc(), removed = [];
  mkdirSync(folder);
  io.adapter = {
    variables: ["PATH", "TOOL_HOME"],
    start: () => ["tool"],
    resume: conversation => conversation?.saved ? ["tool", "--resume", conversation.id] : undefined,
    remove: conversation => removed.push(conversation.id),
  };
  const save = (fields = {}) => writeRecord(stateDir, {
    version: 4, id: randomUUID(), kind: "plain", title: "Session", titleSource: "user", folder,
    resolved: false, rank: 1, created: new Date().toISOString(), ...fields,
  });
  const project = (fields = {}) => {
    const id = randomUUID();
    return save({ id, kind: "coordinator", project: id, title: "Project", ...fields });
  };
  const thread = (coordinator, title, fields = {}) => save({ kind: "thread", project: coordinator.id, title, ...fields });
  const descriptor = control(stateDir);
  const waiting = id => ({ "projects.session": id, "projects.control": descriptor, "projects.pid": `@${ME}` });
  const left = id => ({ ...waiting(id), "projects.launched": "1" });
  const started = id => ({ ...left(id), "projects.pid": `${ME}@${ME}` });
  const bound = (id, pid = ME) => ({ "projects.session": id, "projects.control": descriptor, "projects.pid": `${pid}@${ME}`, "projects.bound": "1" });
  // Each side of the contract, with this fixture's state folder and fake hc filled in.
  const call = side => Object.fromEntries(Object.entries(side).map(([name, action]) => [name, (options = {}, last = io) => action({ stateDir, ...options }, last)]));
  const as = (id, tool, args) => agent.act({ stateDir, id, tool, args }, io);
  const enter = (terminal, conversation, extra = {}) => call(extension).enter({ folder, terminal: terminal.address, pid: ME, conversation: { id: conversation }, env: {}, ...extra });
  const state = async id => (await client.list({ stateDir }, io)).sessions.find(view => view.id === id).state;
  const record = id => readRecord(stateDir, id);
  const runs = () => io.calls.filter(args => args[0] === "run");
  return {
    stateDir, folder, io, removed, save, project, thread, waiting, left, started, bound, as, enter, state, record, runs,
    client: call(client), extension: call(extension),
  };
}
