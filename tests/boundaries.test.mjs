import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = folder => readdirSync(join(root, folder)).map(name => join(folder, name));

// The folder of every file a file imports from this repository.
function uses(file) {
  const source = readFileSync(join(root, file), "utf8");
  return [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map(([, path]) => relative(root, resolve(root, dirname(file), path)).split("/")[0]);
}

test("core uses only core and herdr; herdr uses nothing of ours", () => {
  for (const file of files("core")) assert.deepEqual(uses(file).filter(folder => !["core", "herdr"].includes(folder)), [], file);
  for (const file of files("herdr")) assert.deepEqual(uses(file), [], file);
});

test("pi uses core and itself; control uses core and the adapter", () => {
  for (const file of files("pi")) assert.deepEqual(uses(file).filter(folder => !["core", "pi"].includes(folder)), [], file);
  assert.deepEqual(uses("control.mjs"), ["core", "pi"]);
});

test("only the herdr folder runs hc, and core never names pi", () => {
  for (const file of [...files("core"), ...files("pi"), "control.mjs"]) assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /child_process/, file);
  for (const file of [...files("core"), ...files("herdr")]) assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /\bpi\b/, file);
});
