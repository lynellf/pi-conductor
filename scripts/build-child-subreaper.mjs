#!/usr/bin/env node
/**
 * Build native/child-subreaper.c into dist/native/child-subreaper.node.
 *
 * Linux-only. Degrades loudly (stderr warning, exit 0) when cc or Node
 * headers are unavailable: without the addon the supervision host keeps the
 * fail-closed lineage behavior of issue #157 and says so, rather than
 * silently changing meaning.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.platform !== "linux") {
  console.warn(`build-child-subreaper: skipping on ${process.platform}; lineage stays fail-closed`);
  process.exit(0);
}

function findHeaders() {
  const candidates = [
    join(homedir(), ".cache", "node-gyp", process.versions.node, "include", "node"),
    join(dirname(process.execPath), "..", "include", "node"),
    "/usr/include/node",
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "node_api.h")));
}

const headers = findHeaders();
if (headers === undefined) {
  console.warn(
    "build-child-subreaper: Node headers not found (looked in node-gyp cache, prefix include, /usr/include/node); lineage stays fail-closed",
  );
  process.exit(0);
}

const cc = ["cc", "gcc"].find((candidate) => {
  const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  return probe.status === 0;
});
if (cc === undefined) {
  console.warn("build-child-subreaper: no C compiler found; lineage stays fail-closed");
  process.exit(0);
}

mkdirSync(join(root, "dist", "native"), { recursive: true });
const output = join(root, "dist", "native", "child-subreaper.node");
const compile = spawnSync(
  cc,
  ["-shared", "-fPIC", `-I${headers}`, "-O2", "-o", output, join(root, "native", "child-subreaper.c")],
  { stdio: "inherit" },
);
if (compile.status !== 0) {
  console.warn("build-child-subreaper: compilation failed; lineage stays fail-closed");
  process.exit(0);
}
console.log(`build-child-subreaper: wrote ${output}`);
