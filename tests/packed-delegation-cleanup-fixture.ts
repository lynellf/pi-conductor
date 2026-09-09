import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface PackedDelegationFixture {
  readonly sandbox: string;
  readonly packageRoot: string;
  readonly probe: string;
  readonly preload: string;
  readonly worktree: string;
  readonly piRoot: string;
  readonly piAiRoot: string;
}

/** Build an installation-shaped package with only the Pi host owning the SDK. */
export function createPackedDelegationFixture(): PackedDelegationFixture {
  const checkout = fileURLToPath(new URL("../", import.meta.url));
  const sandbox = mkdtempSync(join("/tmp", "pi-conductor-packed-delegation-"));
  const packageRoot = join(sandbox, "pi-user", "node_modules", "pi-conductor");
  const packageNodeModules = join(packageRoot, "node_modules");
  const worktree = join(sandbox, "worktree");
  const probe = join(sandbox, "probe.ts");
  const preload = join(sandbox, "observation-preload.cjs");
  mkdirSync(packageNodeModules, { recursive: true });
  mkdirSync(join(worktree, ".pi", "roles"), { recursive: true });
  writeFileSync(join(worktree, "fixture.txt"), "packed delegation fixture\n");
  writeFileSync(
    join(worktree, ".pi", "conductor.yaml"),
    `version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [fixture:orchestrator]
    system_prompt: .pi/roles/orchestrator.md
    tools: [delegate, end]
    delegation:
      allowed_subagents: [child]
      max_children_per_session: 3
      max_parallel: 3
  - name: worker
    max_visits: 1
    models: [fixture:child]
    system_prompt: .pi/roles/child.md
    tools: [read, ls, find]
subagents:
  - name: child
    models: [fixture:child]
    max_session_cost_usd: 1
    system_prompt: .pi/roles/child.md
    completion_protocol: minimal
`,
  );
  writeFileSync(join(worktree, ".pi", "roles", "orchestrator.md"), "delegate work");
  writeFileSync(join(worktree, ".pi", "roles", "child.md"), "inspect files");
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  execFileSync("git", ["add", "."], { cwd: worktree });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: worktree },
  );
  execFileSync("pnpm", ["pack", "--pack-destination", sandbox], {
    cwd: checkout,
    stdio: "pipe",
    timeout: 120_000,
  });
  const archive = readdirSync(sandbox).find((entry) => entry.endsWith(".tgz"));
  if (archive === undefined) throw new Error("pnpm pack did not produce an archive");
  execFileSync("tar", ["-xzf", join(sandbox, archive), "--strip-components=1", "-C", packageRoot]);
  for (const dependency of ["diff", "yaml"]) {
    symlinkSync(
      resolve(checkout, "node_modules", dependency),
      join(packageNodeModules, dependency),
    );
  }
  writeFileSync(
    preload,
    `const fs = require("node:fs/promises");
const { syncBuiltinESMExports } = require("node:module");
const readdir = fs.readdir;
let injected = false;
if (!process.execArgv.includes("--eval")) {
  fs.readdir = async function patchedReaddir(path, ...rest) {
    if (!injected && path === "/proc") {
      injected = true;
      const error = new Error("fixture observation EACCES");
      error.code = "EACCES";
      throw error;
    }
    return readdir.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
}
`,
  );
  return {
    sandbox,
    packageRoot,
    probe,
    preload,
    worktree,
    piRoot:
      process.env.CONDUCTOR_SMOKE_PI_ROOT ??
      resolve(checkout, "node_modules/@earendil-works/pi-coding-agent"),
    piAiRoot: resolve(checkout, "node_modules/@earendil-works/pi-ai"),
  };
}

export function loaderUrl(fixture: PackedDelegationFixture): string {
  return pathToFileURL(join(fixture.piRoot, "dist/core/extensions/loader.js")).href;
}

/** Load packaged host entry points through Pi's jiti extension loader. */
export function writePackedDelegationProbe(fixture: PackedDelegationFixture): void {
  writeFileSync(
    fixture.probe,
    `import { startRun, resumeRun } from ${JSON.stringify(`${fixture.packageRoot}/src/host/api.ts`)};
import { ProductionHost } from ${JSON.stringify(`${fixture.packageRoot}/src/host/production-host.ts`)};
import { FileRecordLog } from ${JSON.stringify(`${fixture.packageRoot}/src/host/log-file.ts`)};
globalThis.__packedDelegationApi = { startRun, resumeRun, ProductionHost, FileRecordLog };
export default function probe() {}
`,
  );
}

export function disposePackedDelegationFixture(fixture: PackedDelegationFixture): void {
  rmSync(fixture.sandbox, { recursive: true, force: true });
}
