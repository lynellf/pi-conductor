/** Subprocess-only actual controller/runner host-death fixture for Issue #106 §6. */
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "vitest";
import {
  type CreateSandboxCommandRunnerOptions,
  createSandboxCommandRunner,
} from "../../../src/host/execution/sandbox/command-runner.js";
import { ToolExecutionController } from "../../../src/host/execution/tool-execution-controller.js";
import { FileRecordLog } from "../../../src/host/log-file.js";
import type {
  SandboxExecutionOwner,
  ToolExecutionSandboxReadyRecord,
} from "../../../src/persistence/sandbox-execution.js";
import {
  captureProcessIdentity,
  classifyOwnedProcess,
} from "../../host/bubblewrap-bootstrap-real-harness.js";

interface HostDeathConfig {
  readonly mode: "before_ready" | "after_ready" | "after_release";
  readonly logBaseDir: string;
  readonly reportPath?: string;
  readonly runner: CreateSandboxCommandRunnerOptions;
  readonly owner: SandboxExecutionOwner;
}

describe("command runner host-death fixture", () => {
  it("dies at the requested durable boundary", async () => {
    const path = process.env.PI_CONDUCTOR_HOST_DEATH_CONFIG;
    if (path === undefined) throw new Error("host-death fixture requires its config path");
    const config = JSON.parse(await readFile(path, "utf8")) as HostDeathConfig;
    const log = new FileRecordLog({ baseDir: config.logBaseDir });
    const runner = createSandboxCommandRunner(config.runner);
    let resolveReady!: (record: ToolExecutionSandboxReadyRecord) => void;
    const ready = new Promise<ToolExecutionSandboxReadyRecord>((resolve) => {
      resolveReady = resolve;
    });
    const controller = new ToolExecutionController({
      runId: config.runner.admission.runId,
      logicalSessionId: "host-death-logical",
      roleSessionId: "host-death-role",
      policy: config.runner.admission.policy.toolExecution,
      idFactory: sequenceIds(),
      persist: (record) => {
        log.append(record);
        if (record.type === "tool_execution_sandbox_ready" && record.schema_version === 1)
          resolveReady(record);
        if (
          (config.mode === "before_ready" && record.type === "tool_execution_started") ||
          (config.mode === "after_ready" && record.type === "tool_execution_sandbox_ready")
        )
          process.kill(process.pid, "SIGKILL");
      },
    });
    const execution = controller.runLifecycle("bash", "host-death-call", config.owner, runner);
    void execution.catch(() => undefined);
    if (config.mode === "after_release") {
      const persistedReady = await ready;
      const reportPath = config.reportPath;
      if (reportPath === undefined) throw new Error("after-release host death requires reportPath");
      const namespacePid = Number(
        await waitForText(
          `${config.runner.project.writablePath}/src/host-death-descendant-nspid`,
          5_000,
        ),
      );
      if (!Number.isSafeInteger(namespacePid) || namespacePid < 1)
        throw new Error("host-death command reported invalid descendant namespace PID");
      const descendantPid = await findDescendant(
        persistedReady.final_init.pid,
        namespacePid,
        5_000,
      );
      const descendant = await captureProcessIdentity(descendantPid);
      if ((await classifyOwnedProcess(descendant)) !== "alive")
        throw new Error("recorded descendant was not active before host death");
      await writeFile(reportPath, JSON.stringify({ descendant, activeBeforeHostDeath: true }), {
        mode: 0o600,
      });
      process.kill(process.pid, "SIGKILL");
    }
    await execution;
    throw new Error("host-death fixture did not terminate at its boundary");
  }, 15_000);
});

function sequenceIds(): () => string {
  let next = 0;
  return () => `host-death-${String(++next)}`;
}

async function waitForText(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => undefined);
    if (value !== undefined && value.length > 0) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture timed out waiting for ${path}`);
}

async function findDescendant(
  initPid: number,
  namespacePid: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = [initPid];
    const seen = new Set<number>();
    while (pending.length > 0) {
      const pid = pending.shift();
      if (pid === undefined || seen.has(pid)) continue;
      seen.add(pid);
      if (pid !== initPid) {
        const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => undefined);
        const nspid = status
          ?.match(/^NSpid:\s+(.+)$/m)?.[1]
          ?.trim()
          .split(/\s+/)
          .map(Number);
        if (nspid?.at(-1) === namespacePid) return pid;
      }
      const value = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8").catch(
        () => undefined,
      );
      pending.push(...(value?.trim().split(/\s+/).filter(Boolean).map(Number) ?? []));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture timed out mapping namespace descendant ${String(namespacePid)}`);
}
