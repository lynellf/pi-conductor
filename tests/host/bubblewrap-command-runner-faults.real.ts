/** Real production runner fault boundaries for Issue #106 §6–7. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureSandboxAdmission } from "../../src/host/execution/sandbox/admission-store.js";
import { createSandboxCommandRunner } from "../../src/host/execution/sandbox/command-runner.js";
import { collectBubblewrapStaticObservation } from "../../src/host/execution/sandbox/observation.js";
import { readSandboxExecutionOutput } from "../../src/host/execution/sandbox/output-retrieval.js";
import { pinSandboxPolicy } from "../../src/host/execution/sandbox/policy-pin.js";
import {
  assessBubblewrapStaticPrerequisites,
  type HostApprovedBubblewrapBuild,
} from "../../src/host/execution/sandbox/prerequisites.js";
import { classifySandboxProcess } from "../../src/host/execution/sandbox/process-observation.js";
import { materializeSandboxProject } from "../../src/host/execution/sandbox/project-materialization.js";
import type { HostApprovedBootstrapRuntime } from "../../src/host/execution/sandbox/runtime-types.js";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import type {
  SandboxExecutionOwner,
  ToolExecutionSandboxReadyRecord,
} from "../../src/persistence/sandbox-execution.js";
import type { SandboxProcessObservation } from "../../src/persistence/sandbox-process.js";
import type { ToolExecutionRecord } from "../../src/persistence/tool-execution.js";
import {
  classifyOwnedProcess,
  type ProcessIdentity,
  terminateOwned,
} from "./bubblewrap-bootstrap-real-harness.js";
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

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`real command-runner fault test requires ${name}`);
  return value;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("real production sandbox command runner faults", () => {
  let fixture: Awaited<ReturnType<typeof createSandboxProjectFixture>>;
  let admission: Awaited<ReturnType<typeof captureSandboxAdmission>>;
  let project: Awaited<ReturnType<typeof materializeSandboxProject>>;
  let bootstrapApproval: HostApprovedBootstrapRuntime;
  let approvedBuild: HostApprovedBubblewrapBuild;
  const binary = required("PI_CONDUCTOR_BWRAP");

  beforeAll(async () => {
    const runtimeSource = required("PI_CONDUCTOR_BWRAP_RUNTIME");
    const expectedBinaryHash = required("PI_CONDUCTOR_BWRAP_SHA256");
    if (process.platform !== "linux" || process.getuid?.() === 0)
      throw new Error("real command-runner fault test requires unprivileged Linux");
    fixture = await createSandboxProjectFixture({ writablePaths: ["src"] });
    if ((await sha256(binary)) !== expectedBinaryHash)
      throw new Error("Bubblewrap binary does not match the host-approved digest");
    const binaryStat = await lstat(binary);
    approvedBuild = {
      kind: "upstream-release",
      release: "0.12.0",
      approvalId: "issue-106-real-command-runner-faults",
      sha256: expectedBinaryHash,
      binaryIdentity: {
        device: binaryStat.dev,
        inode: binaryStat.ino,
        mode: binaryStat.mode,
        uid: binaryStat.uid,
        gid: binaryStat.gid,
        size: binaryStat.size,
        mtimeMs: binaryStat.mtimeMs,
        ctimeMs: binaryStat.ctimeMs,
      },
    };
    await requireApprovedBubblewrap();

    const inventory = parseRuntimeInventory(
      JSON.parse(
        await readFile(join(dirname(runtimeSource), "bash-runtime-inventory.json"), "utf8"),
      ),
    );
    const manifestRoot = join(fixture.root, "operator-manifest");
    const runtime = join(manifestRoot, ".pi/runtime");
    await mkdir(manifestRoot, { mode: 0o700 });
    for (const entry of inventory) {
      const source = join(runtimeSource, entry.path);
      const stat = await lstat(source);
      if (!stat.isFile() || stat.nlink !== 1 || (await sha256(source)) !== entry.sha256)
        throw new Error(`approved runtime input changed: ${entry.path}`);
      const destination = join(runtime, entry.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      if ((await sha256(destination)) !== entry.sha256)
        throw new Error(`approved runtime input changed during copy: ${entry.path}`);
    }
    bootstrapApproval = {
      approvalId: "issue-106-real-command-runner-fault-runtime",
      files: inventory,
    };
    const policy = pinSandboxPolicy({
      execution: {
        backend: "bubblewrap",
        runtime_root: ".pi/runtime",
        writable_paths: ["src"],
        max_output_bytes: 4096,
      },
      toolExecution: {
        timeout_seconds: 10,
        termination_grace_seconds: 1,
        max_recoverable_timeouts: 1,
      },
      selectedPaths: ["package.json", "src/a.ts"],
      trackedPaths: ["package.json", "src/a.ts"],
      projectionRoots: ["package.json", "src"],
    });
    admission = await captureSandboxAdmission({
      runId: "run-1",
      childId: "child-1",
      manifestRoot,
      runStateDir: fixture.runStateDir,
      policy,
      bootstrapApproval,
      hostProtection: {
        primaryCheckout: fixture.worktree,
        stateRoots: [fixture.state],
        childWorkspaceRoots: [],
      },
    });
    project = await materializeSandboxProject({
      admission,
      runStateDir: fixture.runStateDir,
      expectedRunId: "run-1",
      expectedChildId: "child-1",
      generatedWorktreePath: fixture.worktree,
    });
  }, 20_000);

  afterAll(async () => {
    if (fixture !== undefined) await cleanupSandboxProjectFixture(fixture.root);
  });

  function owner(): SandboxExecutionOwner {
    return { child_id: admission.childId, descriptor: admission.sandbox };
  }

  function runner(command: string) {
    return createSandboxCommandRunner({
      binaryPath: binary,
      approvedBuilds: [approvedBuild],
      bootstrapApproval,
      runStateDir: fixture.runStateDir,
      admission,
      project,
      command,
      previewBytes: 256,
    });
  }

  it("stops an output-cap descendant and retains an inspectable verified prefix", async () => {
    const logBaseDir = join(fixture.root, "cap-log");
    const log = new FileRecordLog({ baseDir: logBaseDir });
    const controller = new ToolExecutionController({
      runId: admission.runId,
      logicalSessionId: "cap-logical",
      roleSessionId: "cap-role",
      policy: admission.policy.toolExecution,
      idFactory: sequenceIds("cap"),
      persist: (record) => log.append(record),
    });
    const command = "(trap '' TERM; while :; do printf 0123456789abcdef; done) & wait";
    await expect(
      controller.runLifecycle("bash", "cap-call", owner(), runner(command)),
    ).rejects.toMatchObject({ code: "tool_failed", cleanup: "confirmed" });

    const records = toolRecords(new FileRecordLog({ baseDir: logBaseDir }), admission.runId);
    const ready = records.find(
      (record): record is ToolExecutionSandboxReadyRecord =>
        record.type === "tool_execution_sandbox_ready",
    );
    const started = records.find((record) => record.type === "tool_execution_started");
    const finished = records.find((record) => record.type === "tool_execution_finished");
    expect(ready).toBeDefined();
    expect(started).toBeDefined();
    expect(finished).toMatchObject({
      outcome: "failed",
      cleanup: "confirmed",
      sandbox: {
        category: "output_incomplete",
        cleanup: "confirmed",
        output: { capture: "incomplete", failure: { category: "cap" } },
      },
    });
    if (ready === undefined || started?.type !== "tool_execution_started")
      throw new Error("output-cap execution did not retain ready/start evidence");
    expect(await classifySandboxProcess(ready.final_init)).not.toBe("alive");
    const prefix = await readSandboxExecutionOutput({
      runStateDir: fixture.runStateDir,
      expectedRunId: admission.runId,
      expectedChildId: admission.childId,
      expectedExecutionId: started.execution_id,
      outputRef: ready.output_ref,
      stream: "stdout",
      offset: 0,
      maxBytes: 256,
    });
    expect(prefix.capture).toBe("incomplete");
    expect(prefix.byteCount).toBeGreaterThan(0);
    expect(prefix.retainedByteCount).toBeLessThanOrEqual(4096);
    expect(prefix.encoding).toBe("utf8");
    expect("0123456789abcdef".repeat(16)).toContain(prefix.data);
  }, 15_000);

  it.each([
    "before_ready",
    "after_ready",
  ] as const)("retains reopenable records after host death %s", async (mode) => {
    const logBaseDir = join(fixture.root, `host-death-${mode}-log`);
    const configPath = join(fixture.root, `host-death-${mode}.json`);
    await writeFile(
      configPath,
      JSON.stringify({
        mode,
        logBaseDir,
        runner: {
          binaryPath: binary,
          approvedBuilds: [approvedBuild],
          bootstrapApproval,
          runStateDir: fixture.runStateDir,
          admission,
          project,
          command: `printf executed > /workspace/src/host-death-${mode}`,
        },
        owner: owner(),
      }),
      { mode: 0o600 },
    );
    const child = spawn(
      join(process.cwd(), "node_modules/.bin/vitest"),
      ["run", "--config", "tests/fixtures/bubblewrap/host-death-vitest.config.ts", "--silent"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PI_CONDUCTOR_HOST_DEATH_CONFIG: configPath },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.resume();
    child.stderr?.resume();
    const closed = await waitForClose(child, 15_000);
    expect(closed.code).not.toBe(0);
    await expect(lstat(join(project.writablePath, "src", `host-death-${mode}`))).rejects.toThrow();

    const records = toolRecords(new FileRecordLog({ baseDir: logBaseDir }), admission.runId);
    expect(records.filter((record) => record.type === "tool_execution_started")).toHaveLength(1);
    expect(records.some((record) => record.type === "tool_execution_finished")).toBe(false);
    const ready = records.find(
      (record): record is ToolExecutionSandboxReadyRecord =>
        record.type === "tool_execution_sandbox_ready",
    );
    if (mode === "before_ready") {
      expect(ready).toBeUndefined();
    } else {
      expect(ready).toBeDefined();
      if (ready === undefined) throw new Error("durable READY record is missing");
      await waitUntilSettled(ready.final_init, 3_000);
      await waitUntilSettled(
        { pid: ready.launcher.pid, startTime: ready.launcher.start_time },
        3_000,
      );
    }
  }, 20_000);

  it("retains partial work and raw attributed output after host death following release", async () => {
    const logBaseDir = join(fixture.root, "host-death-after-release-log");
    const configPath = join(fixture.root, "host-death-after-release.json");
    const reportPath = join(fixture.root, "host-death-after-release-report.json");
    const command = [
      "printf partial-file > /workspace/src/host-death-after-release",
      "printf partial-output",
      "(trap '' TERM; while :; do :; done) & printf %s $! > /workspace/src/host-death-descendant-nspid",
      "wait",
    ].join("; ");
    await writeFile(
      configPath,
      JSON.stringify({
        mode: "after_release",
        reportPath,
        logBaseDir,
        runner: {
          binaryPath: binary,
          approvedBuilds: [approvedBuild],
          bootstrapApproval,
          runStateDir: fixture.runStateDir,
          admission,
          project,
          command,
        },
        owner: owner(),
      }),
      { mode: 0o600 },
    );
    const child = spawn(
      join(process.cwd(), "node_modules/.bin/vitest"),
      ["run", "--config", "tests/fixtures/bubblewrap/host-death-vitest.config.ts", "--silent"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PI_CONDUCTOR_HOST_DEATH_CONFIG: configPath },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const fixtureErrors: Buffer[] = [];
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => fixtureErrors.push(Buffer.from(chunk)));
    const closed = await waitForClose(child, 15_000);
    expect(closed.code).not.toBe(0);

    const records = toolRecords(new FileRecordLog({ baseDir: logBaseDir }), admission.runId);
    const ready = records.find(
      (record): record is ToolExecutionSandboxReadyRecord =>
        record.type === "tool_execution_sandbox_ready",
    );
    expect(ready).toBeDefined();
    if (records.some((record) => record.type === "tool_execution_finished"))
      throw new Error(`after-release fixture reached terminal: ${Buffer.concat(fixtureErrors)}`);
    if (ready === undefined) throw new Error("after-release READY record is missing");
    const reportBytes = await readFile(reportPath, "utf8").catch((cause) => {
      throw new Error(`after-release report missing: ${Buffer.concat(fixtureErrors)}`, { cause });
    });
    const report = parseHostDeathReport(JSON.parse(reportBytes));
    const init = { pid: ready.final_init.pid, start: ready.final_init.startTime };
    const launcher = { pid: ready.launcher.pid, start: ready.launcher.start_time };
    expect(report.activeBeforeHostDeath).toBe(true);
    expect(await readFile(join(project.writablePath, "src/host-death-after-release"), "utf8")).toBe(
      "partial-file",
    );
    const outputDirectory = join(fixture.runStateDir, "sandbox-output", ready.output_ref);
    const attribution = JSON.parse(
      await readFile(join(outputDirectory, "attribution.json"), "utf8"),
    ) as { outputRef?: unknown; runId?: unknown; childId?: unknown };
    expect(attribution).toMatchObject({
      outputRef: ready.output_ref,
      runId: admission.runId,
      childId: admission.childId,
    });
    expect(await readFile(join(outputDirectory, "stdout.bin"), "utf8")).toBe("partial-output");
    await expect(readFile(join(outputDirectory, "final.json"), "utf8")).rejects.toThrow();

    await Promise.all([
      terminateOwned(report.descendant),
      terminateOwned(init),
      terminateOwned(launcher),
    ]);
    await Promise.all([
      waitUntilOwnedSettled(report.descendant, 3_000),
      waitUntilOwnedSettled(init, 3_000),
      waitUntilOwnedSettled(launcher, 3_000),
    ]);
    const reopened = toolRecords(new FileRecordLog({ baseDir: logBaseDir }), admission.runId);
    expect(reopened.some((record) => record.type === "tool_execution_finished")).toBe(false);
    expect(await readFile(join(project.writablePath, "src/host-death-after-release"), "utf8")).toBe(
      "partial-file",
    );
  }, 20_000);

  async function requireApprovedBubblewrap(): Promise<void> {
    const observation = await collectBubblewrapStaticObservation({
      binaryPath: binary,
      approvedBuilds: [approvedBuild],
    });
    const result = assessBubblewrapStaticPrerequisites(observation, [approvedBuild]);
    if (result.status !== "accepted")
      throw new Error(`Bubblewrap prerequisite rejected: ${result.reason}`);
  }
});

function toolRecords(log: FileRecordLog, runId: string): ToolExecutionRecord[] {
  return log
    .records(runId)
    .filter(
      (record): record is ToolExecutionRecord =>
        record.type === "tool_execution_started" ||
        record.type === "tool_execution_sandbox_ready" ||
        record.type === "tool_execution_finished" ||
        record.type === "tool_execution_cleanup_confirmed",
    );
}

function sequenceIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${String(++next)}`;
}

async function waitForClose(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("host-death fixture did not close"));
    }, timeoutMs);
    child.once("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitUntilSettled(
  observation: Pick<SandboxProcessObservation, "pid" | "startTime">,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await classifySandboxProcess(observation)) !== "alive") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("host-death namespace-init remained alive");
}

function parseRuntimeInventory(value: unknown): { path: string; sha256: string }[] {
  if (!Array.isArray(value)) throw new Error("approved Bash inventory is not an array");
  const entries = value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      !/^[a-f0-9]{64}$/.test(String((entry as { sha256?: unknown }).sha256))
    )
      throw new Error("approved Bash inventory contains an invalid entry");
    return {
      path: (entry as { path: string }).path,
      sha256: String((entry as { sha256: string }).sha256),
    };
  });
  if (
    entries.length !== RUNTIME_PATHS.length ||
    !RUNTIME_PATHS.every((path) => entries.some((entry) => entry.path === path))
  )
    throw new Error("approved Bash inventory does not match the fixed runtime");
  return entries;
}

function parseHostDeathReport(value: unknown): {
  descendant: ProcessIdentity;
  activeBeforeHostDeath: true;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("descendant" in value) ||
    typeof value.descendant !== "object" ||
    value.descendant === null ||
    !("activeBeforeHostDeath" in value) ||
    value.activeBeforeHostDeath !== true ||
    !("pid" in value.descendant) ||
    !("start" in value.descendant) ||
    typeof value.descendant.pid !== "number" ||
    !Number.isSafeInteger(value.descendant.pid) ||
    value.descendant.pid < 1 ||
    typeof value.descendant.start !== "string" ||
    !/^[1-9][0-9]*$/.test(value.descendant.start)
  )
    throw new Error("host-death descendant report is invalid");
  return {
    descendant: { pid: value.descendant.pid, start: value.descendant.start },
    activeBeforeHostDeath: true,
  };
}

async function waitUntilOwnedSettled(identity: ProcessIdentity, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await classifyOwnedProcess(identity)) !== "alive") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`owned PID ${String(identity.pid)} remained alive`);
}
