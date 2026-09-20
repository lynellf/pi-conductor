import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { createSandboxAdmissionAdapter } from "../../../src/host/delegation/sandbox-admission.js";
import type { SandboxHostApproval } from "../../../src/host/execution/sandbox/host-approval.js";
import type { HostApprovedBootstrapRuntime } from "../../../src/host/execution/sandbox/runtime-types.js";

const execute = promisify(execFile);

export interface RealDelegationFixture {
  readonly root: string;
  readonly checkout: string;
  readonly runStateDir: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly promptRoot: string;
  readonly hostApproval: SandboxHostApproval;
  readonly sandboxAdmission: ReturnType<typeof createSandboxAdmissionAdapter>;
  cleanup(): Promise<void>;
}

export async function createRealDelegationFixture(
  options: {
    readonly freshProductionLayout?: boolean;
    readonly fourFiles?: boolean;
    readonly verificationScript?: boolean;
  } = {},
): Promise<RealDelegationFixture> {
  const binaryPath = required("PI_CONDUCTOR_BWRAP");
  const runtimeSource = required("PI_CONDUCTOR_BWRAP_RUNTIME");
  const expectedHash = required("PI_CONDUCTOR_BWRAP_SHA256");
  if (process.platform !== "linux" || process.getuid?.() === 0)
    throw new Error("requires unprivileged Linux");
  if ((await sha256(binaryPath)) !== expectedHash) throw new Error("Bubblewrap digest changed");
  const root = await mkdtemp(join(tmpdir(), "conductor-delegated-session-"));
  await chmod(root, 0o700);
  const checkout = join(root, "checkout");
  const runtime = join(checkout, ".pi/runtime");
  const runStateDir = options.freshProductionLayout
    ? join(root, ".pi-conductor/runs/real-delegate")
    : join(root, "state/run");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const promptRoot = join(root, "prompts");
  await Promise.all([
    mkdir(checkout),
    mkdir(runStateDir, { recursive: true, mode: 0o700 }),
    mkdir(agentDir),
    mkdir(sessionDir),
    mkdir(promptRoot),
    ...(options.freshProductionLayout
      ? []
      : [mkdir(join(runStateDir, "worktrees"), { recursive: true, mode: 0o700 })]),
  ]);
  await chmod(checkout, 0o700);
  for (const entry of parseInventory(
    JSON.parse(await readFile(join(dirname(runtimeSource), "bash-runtime-inventory.json"), "utf8")),
  )) {
    const from = join(runtimeSource, entry.path),
      to = join(runtime, entry.path);
    if ((await sha256(from)) !== entry.sha256) throw new Error("runtime source digest changed");
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  const probe = join(runtime, "opt/pi-conductor/probes/capability-probe-v1");
  await mkdir(dirname(probe), { recursive: true });
  await execute(
    "/usr/bin/cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "resources/sandbox/capability-probe-v1.c",
      "-o",
      probe,
    ],
    { env: cleanEnv() },
  );
  await mkdir(join(checkout, "alpha"));
  await mkdir(join(checkout, "beta"));
  await mkdir(join(checkout, "docs"));
  if (options.fourFiles) {
    await mkdir(join(checkout, "gamma"));
    await mkdir(join(checkout, "delta"));
  }
  await writeFile(join(checkout, "alpha/value.txt"), "original\n");
  if (options.verificationScript)
    await writeFile(
      join(checkout, "alpha/check.bash"),
      '#!/bin/bash\nvalue=$(<alpha/value.txt)\n[[ "$value" == "fixed" ]]\n',
    );
  await writeFile(join(checkout, "beta/value.txt"), "original\n");
  if (options.fourFiles) {
    await writeFile(join(checkout, "gamma/value.txt"), "original\n");
    await writeFile(join(checkout, "delta/value.txt"), "original\n");
  }
  await writeFile(join(checkout, "docs/notes + final.md"), "unselected notes\n");
  await writeFile(join(checkout, "docs/space name.md"), "unselected space\n");
  await writeFile(join(promptRoot, "worker.md"), "Use the supplied tools to complete the task.\n");
  if (options.freshProductionLayout) {
    await writeFile(join(checkout, "worker.md"), "Use the supplied tools to complete the task.\n");
    await writeFile(join(root, "worker.md"), "Use the supplied tools to complete the task.\n");
  }
  await git(checkout, ["init", "-q"]);
  await git(checkout, ["add", "."]);
  await git(checkout, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  await chmod(join(checkout, ".git"), 0o700);
  await chmod(join(checkout, ".git/index"), 0o600);
  await chmod(join(checkout, "docs"), 0o700);
  await chmod(join(checkout, "docs/notes + final.md"), 0o600);
  await chmod(join(checkout, "docs/space name.md"), 0o600);
  const binary = await lstat(binaryPath);
  const bootstrapApproval = {
    approvalId: "delegated-session-runtime",
    files: [...(await inventoryFiles(runtime))],
  } satisfies HostApprovedBootstrapRuntime;
  const hostApproval = Object.freeze({
    schemaVersion: 1,
    binaryPath,
    approvedBuilds: [
      {
        kind: "upstream-release",
        release: "0.12.0",
        approvalId: "delegated-session-bwrap",
        sha256: expectedHash,
        binaryIdentity: {
          device: binary.dev,
          inode: binary.ino,
          mode: binary.mode,
          uid: binary.uid,
          gid: binary.gid,
          size: binary.size,
          mtimeMs: binary.mtimeMs,
          ctimeMs: binary.ctimeMs,
        },
      },
    ],
    bootstrapApproval,
    probeApproval: { approvalId: "delegated-session-probe", sha256: await sha256(probe) },
  } satisfies SandboxHostApproval);
  const hostProtection = {
    primaryCheckout: checkout,
    stateRoots: [join(root, "state")],
    childWorkspaceRoots: [join(runStateDir, "worktrees")],
  };
  const sandboxAdmission = createSandboxAdmissionAdapter({
    runId: "real-delegate",
    runStateDir,
    primaryCheckout: checkout,
    manifestRoot: checkout,
    hostProtection,
    bootstrapApproval,
    binaryPath,
    approvedBuilds: hostApproval.approvedBuilds,
    probeApproval: hostApproval.probeApproval,
  });
  return {
    root,
    checkout,
    runStateDir,
    agentDir,
    sessionDir,
    promptRoot,
    hostApproval,
    sandboxAdmission,
    cleanup: async () => {
      await makeRemovable(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`requires ${name}`);
  return value;
}
function cleanEnv(): NodeJS.ProcessEnv {
  return { LANG: "C", PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" };
}
async function git(cwd: string, args: string[]): Promise<void> {
  await execute("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: cleanEnv(),
  });
}
async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
function parseInventory(value: unknown): readonly { path: string; sha256: string }[] {
  if (!Array.isArray(value)) throw new Error("invalid runtime inventory");
  return value as { path: string; sha256: string }[];
}
async function inventoryFiles(root: string): Promise<HostApprovedBootstrapRuntime["files"]> {
  const files: { path: string; sha256: string }[] = [];
  async function visit(path: string, relative: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name),
        child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(next, child);
      else if (entry.isFile()) files.push({ path: child, sha256: await sha256(next) });
      else throw new Error("unsupported runtime entry");
    }
  }
  await visit(root, "");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function makeRemovable(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    for (const entry of await readdir(path)) await makeRemovable(join(path, entry));
    await chmod(path, 0o700);
  } else if (stat.isFile()) await chmod(path, 0o600);
}
