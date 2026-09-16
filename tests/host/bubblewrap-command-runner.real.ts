/** End-to-end production runner proof against the operator-approved Bubblewrap. */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, readlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createControllerCommandRunner } from "../../src/host/controller/controller-command-runner.js";
import {
  captureSandboxAdmission,
  readSandboxAdmission,
} from "../../src/host/execution/sandbox/admission-store.js";
import { createSandboxCommandRunner } from "../../src/host/execution/sandbox/command-runner.js";
import type { HostApprovedBubblewrapBuild } from "../../src/host/execution/sandbox/prerequisites.js";
import { classifySandboxProcess } from "../../src/host/execution/sandbox/process-observation.js";
import {
  materializeSandboxProject,
  verifySandboxProjectBase,
} from "../../src/host/execution/sandbox/project-materialization.js";
import type { HostApprovedBootstrapRuntime } from "../../src/host/execution/sandbox/runtime-types.js";
import type { ToolExecutionScope } from "../../src/host/execution/tool-execution-contract.js";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import type { ToolExecutionRecord } from "../../src/persistence/tool-execution.js";
import {
  cleanupSandboxProjectFixture,
  createSandboxProjectFixture,
} from "./fixtures/sandbox-project-fixture.js";

const RUNTIME_PATHS = [
  "bin/bash",
  "lib/x86_64-linux-gnu/libtinfo.so.6",
  "lib/x86_64-linux-gnu/libc.so.6",
  "lib64/ld-linux-x86-64.so.2",
] as const;

describe("real production Bubblewrap command runner", () => {
  let fixture: Awaited<ReturnType<typeof createSandboxProjectFixture>>;
  let runnerOptions: Omit<Parameters<typeof createSandboxCommandRunner>[0], "command">;
  const active: ReturnType<typeof createSandboxCommandRunner>[] = [];

  beforeAll(async () => {
    const binaryPath = required("PI_CONDUCTOR_BWRAP");
    const runtimeSource = required("PI_CONDUCTOR_BWRAP_RUNTIME");
    const binaryDigest = required("PI_CONDUCTOR_BWRAP_SHA256");
    if (process.platform !== "linux" || process.getuid?.() === 0)
      throw new Error("real command runner proof requires unprivileged Linux");
    fixture = await createSandboxProjectFixture({ writablePaths: ["src"] });
    const binary = await lstat(binaryPath);
    if ((await sha256(binaryPath)) !== binaryDigest)
      throw new Error("Bubblewrap binary does not match the approved digest");
    const approvedBuild: HostApprovedBubblewrapBuild = {
      kind: "upstream-release",
      release: "0.12.0",
      approvalId: "issue-106-real-command-runner",
      sha256: binaryDigest,
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
    };
    const inventory = parseInventory(
      JSON.parse(
        await readFile(join(dirname(runtimeSource), "bash-runtime-inventory.json"), "utf8"),
      ),
    );
    const manifestRoot = join(fixture.root, "manifest");
    const runtimeRoot = join(manifestRoot, ".pi", "runtime");
    for (const entry of inventory) {
      const source = join(runtimeSource, entry.path);
      if ((await sha256(source)) !== entry.sha256)
        throw new Error(`approved runtime input changed: ${entry.path}`);
      const target = join(runtimeRoot, entry.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    const bootstrapApproval: HostApprovedBootstrapRuntime = {
      approvalId: "issue-106-real-command-runner-runtime",
      files: inventory,
    };
    const policy = {
      ...fixture.admission.policy,
      execution: { ...fixture.admission.policy.execution, runtime_root: ".pi/runtime" },
    };
    const admission = await captureSandboxAdmission({
      runId: "run-1",
      childId: "child-1",
      manifestRoot,
      policy,
      hostProtection: {
        primaryCheckout: fixture.worktree,
        stateRoots: [fixture.runStateDir],
        childWorkspaceRoots: [],
      },
      bootstrapApproval,
      runStateDir: fixture.runStateDir,
    });
    const project = await materializeSandboxProject({
      admission,
      runStateDir: fixture.runStateDir,
      expectedRunId: "run-1",
      expectedChildId: "child-1",
      generatedWorktreePath: fixture.worktree,
    });
    runnerOptions = {
      binaryPath,
      approvedBuilds: [approvedBuild],
      bootstrapApproval,
      runStateDir: fixture.runStateDir,
      admission,
      project,
    };
  }, 20_000);

  afterAll(async () => {
    if (fixture !== undefined) await cleanupSandboxProjectFixture(fixture.root);
  });
  afterEach(async () => {
    await Promise.all(active.splice(0).map((runner) => runner.terminate("failed", 250)));
  });

  it("returns exit 17 and preserves its private repair for the next command", async () => {
    const runner = createSandboxCommandRunner({
      ...runnerOptions,
      command: "printf repaired > src/a.ts; printf 'runner stderr\\n' >&2; exit 17",
    });
    active.push(runner);
    await runner.prepare(scope());
    await runner.authorize();
    const result = await runner.settle();
    expect(result.normalizedStatus).toBe(17);
    expect(result.signal).toBe("unknown");
    expect(result.previews.stderr).toMatchObject({
      encoding: "utf8",
      data: "runner stderr\n",
      truncated: false,
    });
    expect(runner.terminalEvidence()).toMatchObject({
      category: "command_status",
      normalized_status: 17,
      cleanup: "confirmed",
      output_ref: result.output.outputRef,
    });
    const followup = createSandboxCommandRunner({
      ...runnerOptions,
      command: 'printf %s "$(<src/a.ts)"',
    });
    active.push(followup);
    await followup.prepare(scope("execution-2", "supervision-2"));
    await followup.authorize();
    const repaired = await followup.settle();
    expect(repaired.previews.stdout.data).toBe("repaired");
  }, 10_000);

  it("issue #109: production command runner strips ambient descriptors and confirms cleanup", async () => {
    await assertIssue109AmbientDescriptors();
    const runner = createSandboxCommandRunner({
      ...runnerOptions,
      command: [
        "test ! -e /proc/self/fd/3 && test ! -e /proc/self/fd/4 || exit 91",
        `for descriptor in /proc/self/fd/[0-9]*; do if [ -e "$descriptor" ]; then printf "%s\\n" "\${descriptor##*/}"; fi; done`,
      ].join("; "),
    });
    active.push(runner);
    await runner.prepare(scope("issue109-execution", "issue109-supervision"));
    await runner.authorize();
    const result = await runner.settle();
    await assertIssue109AmbientDescriptors();
    expect(result.normalizedStatus).toBe(0);
    const observed = result.previews.stdout.data.trim().split("\n").sort();
    expect(observed).toEqual(["0", "1", "2"]);
    expect(runner.terminalEvidence()).toMatchObject({ cleanup: "confirmed" });
  }, 15_000);

  it("delivers a large JSON request on FD 0 to a fixed executable and literal argv", async () => {
    const request = { payload: "x".repeat(128 * 1024) };
    const literalArgument = "$(touch /workspace/src/escaped); $HOME";
    const origin = {
      kind: "controller_operation" as const,
      controller_id: "controller-1",
      definition_digest: "a".repeat(64),
      activation_id: "activation-1",
      owner_epoch: 1,
      operation_id: "operation-1",
      operation_kind: "planner" as const,
      action_id: null,
      request_sha256: "b".repeat(64),
    };
    const owner = {
      kind: "controller_operation" as const,
      origin,
      runtime: {
        runtime_id: "runtime-1",
        approval_id: "approval-1",
        runtime_digest: "c".repeat(64),
        executable_digest: "d".repeat(64),
        capability_digest: "e".repeat(64),
      },
    };
    const runner = createControllerCommandRunner({
      binaryPath: runnerOptions.binaryPath,
      approvedBuilds: runnerOptions.approvedBuilds,
      runStateDir: runnerOptions.runStateDir,
      executable: "/bin/bash",
      argv: [
        "--noprofile",
        "--norc",
        "-c",
        'IFS= read -r -d "" request || :; printf "%s" "$request"; printf "%s" "$1" >&2',
        "controller-test",
        literalArgument,
      ],
      request,
      loadVerifiedContext: async (executionScope) => {
        expect(executionScope.executionId).toBe("controller-execution");
        executionScope.assertOpen();
        const admission = await readSandboxAdmission({
          runStateDir: runnerOptions.runStateDir,
          expectedRunId: runnerOptions.admission.runId,
          expectedChildId: runnerOptions.admission.childId,
          expectedSandbox: runnerOptions.admission.sandbox,
          bootstrapApproval: runnerOptions.bootstrapApproval,
        });
        const project = await verifySandboxProjectBase(runnerOptions.project, {
          admission,
          runStateDir: runnerOptions.runStateDir,
          expectedRunId: admission.runId,
          expectedChildId: admission.childId,
        });
        return {
          runtime: admission.runtime,
          readonlyWorkspaceRoot: project.basePath,
          privateWritableRoot: project.writablePath,
          bootstrapPath: project.bootstrapPath,
          owner,
          writableMounts: [],
          environment: admission.policy.execution.environment,
          runId: admission.runId,
          outputCaps: { maxBytes: 1024 * 1024 + 4096 },
        };
      },
    });
    active.push(runner);

    const ready = await runner.prepare(scope("controller-execution", "controller-supervision"));
    await runner.authorize();
    const result = await runner.settle();

    expect(ready.sandbox).toEqual(owner);
    expect(result.normalizedStatus).toBe(0);
    expect(result.output.stdout.byteCount).toBe(Buffer.byteLength(JSON.stringify(request)));
    expect(result.previews.stdout).toMatchObject({
      encoding: "utf8",
      data: JSON.stringify(request).slice(0, 64 * 1024),
      truncated: true,
    });
    expect(result.previews.stderr).toMatchObject({
      encoding: "utf8",
      data: literalArgument,
      truncated: false,
    });
    expect(
      await lstat(join(runnerOptions.project.writablePath, "src/escaped")).catch(() => null),
    ).toBeNull();
  }, 15_000);

  it("controller timeout kills a TERM-resistant namespace and retains terminal evidence", async () => {
    const records: ToolExecutionRecord[] = [];
    const controller = new ToolExecutionController({
      runId: "run-1",
      logicalSessionId: "logical-1",
      roleSessionId: "role-1",
      policy: {
        ...DEFAULT_TOOL_EXECUTION_POLICY,
        timeout_seconds: 1,
        termination_grace_seconds: 1,
      },
      persist: (record) => records.push(record),
    });
    const runner = createSandboxCommandRunner({
      ...runnerOptions,
      command: "trap '' TERM; (trap '' TERM; while :; do :; done) & wait",
    });
    active.push(runner);
    await expect(
      controller.runLifecycle(
        "bash",
        "call-timeout",
        { child_id: "child-1", descriptor: runnerOptions.admission.sandbox },
        runner,
      ),
    ).rejects.toMatchObject({ code: "tool_timeout" });
    const ready = records.find((record) => record.type === "tool_execution_sandbox_ready");
    if (ready?.type !== "tool_execution_sandbox_ready") throw new Error("missing durable READY");
    expect(await classifySandboxProcess(ready.final_init)).not.toBe("alive");
    expect(records.at(-1)).toMatchObject({
      type: "tool_execution_finished",
      outcome: "timed_out",
      sandbox: { termination_requested: true, signal: "unknown", cleanup: "confirmed" },
    });
  }, 10_000);

  it("cancellation during held setup cannot spawn or release later", async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runner = createSandboxCommandRunner({
      ...runnerOptions,
      command: "printf escaped > src/held",
      testHookAfterSpool: async () => {
        entered();
        await held;
      },
    });
    active.push(runner);
    const preparing = runner.prepare(scope("execution-held", "supervision-held"));
    await reached;
    await expect(runner.terminate("cancelled", 25)).resolves.toBe("unconfirmed");
    release();
    await expect(preparing).rejects.toThrow("sandbox command setup was stopped");
    expect(
      await lstat(join(runnerOptions.project.writablePath, "src/held")).catch(() => undefined),
    ).toBeUndefined();
    expect(runner.terminalEvidence()).toMatchObject({
      category: "cleanup_unconfirmed",
      termination_requested: true,
      cleanup: "unconfirmed",
    });
  }, 10_000);
});

function scope(executionId = "execution-1", supervisionId = "supervision-1"): ToolExecutionScope {
  return {
    executionId,
    supervisionId,
    signal: new AbortController().signal,
    graceMs: 250,
    remainingTimeoutMs: () => 5000,
    assertOpen: () => undefined,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`real command runner test requires ${name}`);
  return value;
}

async function assertIssue109AmbientDescriptors(): Promise<void> {
  const mode = process.env.PI_CONDUCTOR_ISSUE109_MODE;
  if (mode === undefined) return;
  const descriptors = await readdir("/proc/self/fd");
  const present = mode === "inherit";
  for (const descriptor of ["34", "35", "255"]) {
    expect(descriptors.includes(descriptor)).toBe(present);
    if (present) expect(await readlink(`/proc/self/fd/${descriptor}`)).toContain("/dev/ptmx");
  }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function parseInventory(value: unknown): { path: string; sha256: string }[] {
  if (!Array.isArray(value)) throw new Error("approved runtime inventory is not an array");
  const entries = value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      !/^[a-f0-9]{64}$/.test(String((entry as { sha256?: unknown }).sha256))
    )
      throw new Error("approved runtime inventory contains an invalid entry");
    return {
      path: (entry as { path: string }).path,
      sha256: String((entry as { sha256: string }).sha256),
    };
  });
  if (
    entries.length !== RUNTIME_PATHS.length ||
    !RUNTIME_PATHS.every((path) => entries.some((entry) => entry.path === path))
  )
    throw new Error("approved runtime inventory differs from the fixed Bash runtime");
  return entries;
}
