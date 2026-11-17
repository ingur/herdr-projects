import { createInterface } from "node:readline";
import { actions } from "../core/control.mjs";
import { tools } from "../core/roles.mjs";

const terminal = process.env.HC_TERMINAL_ID, pid = process.ppid;

const methods = {
  initialize: params => ({
    protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "projects", version: "1" },
  }),

  ping: () => ({}),

  "tools/list": () => ({
    tools: tools.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })),
  }),

  async "tools/call"({ name, arguments: args }) {
    try {
      const { session } = terminal ? await actions.session({ terminal, pid }) : {};
      const value = await actions.act({ as: session?.id, tool: name, args });
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  },
};

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const reply = methods[method] ? { result: await methods[method](params ?? {}) } : { error: { code: -32601, message: `No method ${method}` } };
  console.log(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
}
