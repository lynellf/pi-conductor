import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  findProcessesByOwnerToken,
  processGroupHasLiveMembers,
  readProcessIdentity,
} from "../src/host/execution/supervised-process-identity.js";

export interface PackedBashFixture {
  readonly sandbox: string;
  readonly packageRoot: string;
  readonly probe: string;
  readonly state: string;
  readonly piRoot: string;
}

/** Pack and unpack the package into an installation-shaped directory. */
export function createPackedBashFixture(): PackedBashFixture {
  const checkout = fileURLToPath(new URL("../", import.meta.url));
  const sandbox = mkdtempSync(join("/tmp", "pi-conductor-packed-bash-"));
  const packageRoot = join(sandbox, "pi-user", "node_modules", "pi-conductor");
  const packageNodeModules = join(packageRoot, "node_modules");
  const probe = join(sandbox, "probe.ts");
  const state = join(sandbox, "records.json");
  mkdirSync(packageNodeModules, { recursive: true });
  writeFileSync(state, "[]");

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
  return {
    sandbox,
    packageRoot,
    probe,
    state,
    piRoot:
      process.env.CONDUCTOR_SMOKE_PI_ROOT ??
      realpathSync(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent")),
  };
}

/** Write a loader probe that exercises the packaged extension and source seam. */
export function writePackedBashProbe(fixture: PackedBashFixture): void {
  writeFileSync(
    fixture.probe,
    `import { ToolExecutionController } from ${JSON.stringify(join(fixture.packageRoot, "src/host/execution/tool-execution-controller.ts"))};
import { createSupervisedTools } from ${JSON.stringify(join(fixture.packageRoot, "src/host/execution/supervised-tools.ts"))};
import { resolveToolExecutionPolicy } from ${JSON.stringify(join(fixture.packageRoot, "src/manifest/execution-policy.ts"))};
import { writeFileSync } from "node:fs";
const policy = resolveToolExecutionPolicy({ timeout_seconds: 5, max_recoverable_timeouts: 2, termination_grace_seconds: 1 });
const statePath = process.env.CONDUCTOR_SMOKE_RECORDS;
const allRecords = [];
const makeController = label => new ToolExecutionController({ runId: "packed-bash-" + label, logicalSessionId: "packed-bash:" + label, roleSessionId: "packed-bash:role", policy, persist: record => { allRecords.push(record); writeFileSync(statePath, JSON.stringify(allRecords)); } });
const controller = makeController("probe");
const tools = createSupervisedTools({ cwd: process.cwd(), declaredTools: ["bash"], getController: () => controller, getPolicy: () => policy });
const bash = tools[0];
if (!bash) throw new Error("packaged bash tool was not created");
export default function probe(pi) { for (const tool of tools) pi.registerTool(tool); }
`,
  );
}

/** Kill only descendants whose marker and PID start time were observed by this test. */
export async function killOwnedProcesses(executionId: string): Promise<void> {
  const observed = await ownedProcesses(executionId);
  for (const process of observed) {
    const identity = await readProcessIdentity(process.pid, executionId);
    if (
      identity === null ||
      identity.startTime !== process.startTime ||
      identity.processGroupId !== process.processGroupId
    )
      continue;
    try {
      globalThis.process.kill(process.pid, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw error;
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const remaining = await ownedProcesses(executionId);
    const groupLive = await Promise.all(
      observed.map((process) => processGroupHasLiveMembers(process.processGroupId)),
    );
    if (remaining.length === 0 && groupLive.every((live) => !live)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test-owned process cleanup did not settle for ${executionId}`);
}

/** Inspect marker-owned processes without failing on unrelated /proc entries. */
export async function ownedProcesses(
  executionId: string,
): Promise<readonly { pid: number; startTime: string; processGroupId: number }[]> {
  const parent = await readProcessIdentity(globalThis.process.pid);
  if (parent === null) throw new Error("could not identify test runner");
  return findProcessesByOwnerToken(executionId, parent.startTime);
}

export function disposePackedBashFixture(fixture: PackedBashFixture): void {
  rmSync(fixture.sandbox, { recursive: true, force: true });
}

export function loaderUrl(fixture: PackedBashFixture): string {
  return pathToFileURL(join(fixture.piRoot, "dist/core/extensions/loader.js")).href;
}
