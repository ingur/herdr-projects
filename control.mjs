#!/usr/bin/env node
import { readFileSync } from "node:fs";
import * as client from "./core/client.mjs";
import * as adapter from "./pi/adapter.mjs";

const kebab = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const actions = Object.fromEntries(Object.entries(client).map(([name, action]) => [kebab(name), action]));

async function main([name, json = readFileSync(0, "utf8")]) {
  if (!Object.hasOwn(actions, name)) throw new Error(`usage: control <${Object.keys(actions).join("|")}> ['JSON options', else on stdin]`);
  const options = JSON.parse(json);
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("options must be a JSON object");
  console.log(JSON.stringify(await actions[name](options, { adapter })));
}

main(process.argv.slice(2)).catch(error => {
  console.error(`projects: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
