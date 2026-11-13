const modules = { pi: "../pi/adapter.mjs" };

export const agents = Object.keys(modules);

export function adapter(agent) {
  if (!Object.hasOwn(modules, agent)) throw new Error(`No adapter for agent ${JSON.stringify(agent)}`);
  return import(modules[agent]);
}
