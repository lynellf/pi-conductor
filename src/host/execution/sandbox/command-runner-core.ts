/** Production Bubblewrap command lifecycle adapter (#106 §7). */
import { type ChildProcess, spawn } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import type { SandboxExecutionTerminal } from "../../../persistence/sandbox-command.js";
import type { SandboxReadyEvidence } from "../../../persistence/sandbox-execution.js";
import type { SandboxOutputFinalRecord } from "../../../persistence/sandbox-output.js";
import type { ToolExecutionScope } from "../tool-execution-contract.js";
import { captureSandboxCommandPipes, type SandboxCommandPipes } from "./command-pipes.js";
import { exactProcessSettled, terminateSandboxProcesses } from "./command-runner-cleanup.js";
import type {
  CreateVerifiedSandboxCommandRunnerOptions,
  SandboxCommandResult,
  SandboxCommandRunner,
} from "./command-runner-contract.js";
import { beginSandboxInput, type SandboxCommandInput } from "./command-runner-input.js";
import { buildSandboxMountPlan } from "./mount-plan.js";
import { collectBubblewrapStaticObservation } from "./observation.js";
import { createSandboxOutputSpool, type SandboxOutputSpool } from "./output-spool.js";
import { assessBubblewrapStaticPrerequisites } from "./prerequisites.js";
import { observeSandboxProcess, verifyFinalSandboxNamespaces } from "./process-observation.js";

type SandboxCommandTerminalCategory = SandboxExecutionTerminal["category"];

/** Construct one single-use, stop-latched production command adapter. */
export function createVerifiedSandboxCommandRunner(
  supplied: CreateVerifiedSandboxCommandRunnerOptions,
): SandboxCommandRunner {
  const { loadVerifiedContext, testHookAfterSpool, ...cloneable } = supplied;
  const options = {
    ...structuredClone(cloneable),
    loadVerifiedContext,
    ...(testHookAfterSpool === undefined ? {} : { testHookAfterSpool }),
  };
  if (options.argv.some((value) => value.includes("\0")))
    throw new TypeError("sandbox argv must be NUL-free");
  let stopped = false;
  let terminationRequested = false;
  let authorized = false;
  let scope: ToolExecutionScope | undefined;
  let child: ChildProcess | undefined;
  let pipes: SandboxCommandPipes | undefined;
  let input: SandboxCommandInput | undefined;
  let spool: SandboxOutputSpool | undefined;
  let finalInit: Awaited<ReturnType<typeof observeSandboxProcess>> | undefined;
  let normalizedStatus: number | null = null;
  let output: SandboxOutputFinalRecord | undefined;
  let outputFailed = false;
  let cleanup: "confirmed" | "unconfirmed" = "confirmed";
  let category: SandboxCommandTerminalCategory = "setup_failed";
  let prepareWork: Promise<SandboxReadyEvidence> | undefined;
  let terminateWork: Promise<"confirmed" | "unconfirmed"> | undefined;

  const prepare = (value: ToolExecutionScope): Promise<SandboxReadyEvidence> => {
    if (prepareWork !== undefined) return prepareWork;
    scope = value;
    prepareWork = doPrepare(value);
    void prepareWork.catch(() => undefined);
    return prepareWork;
  };

  async function doPrepare(value: ToolExecutionScope): Promise<SandboxReadyEvidence> {
    assertRunning();
    const context = await options.loadVerifiedContext(value);
    assertRunning();
    spool = await createSandboxOutputSpool({
      runStateDir: options.runStateDir,
      runId: context.runId,
      ...outputOwner(context.owner),
      executionId: value.executionId,
      supervisionId: value.supervisionId,
      maxBytes: context.outputCaps.maxBytes,
      ...(context.outputCaps.previewBytes === undefined
        ? {}
        : { previewBytes: context.outputCaps.previewBytes }),
    });
    const currentSpool = spool;
    void currentSpool.captureFailure.then(() => {
      outputFailed = true;
      if (cleanup === "confirmed") category = "output_incomplete";
      void terminate("failed", value.graceMs);
    });
    await options.testHookAfterSpool?.();
    assertRunning();
    const [host, bootId, timeNamespace] = await Promise.all([
      observeSandboxProcess(process.pid),
      readFile("/proc/sys/kernel/random/boot_id", "utf8").then((text) => text.trim()),
      readlink("/proc/self/ns/time"),
    ]);
    const args = buildSandboxMountPlan({
      runtime: context.runtime,
      immutableWorkspaceRoot: context.readonlyWorkspaceRoot,
      privateWritableRoot: context.privateWritableRoot,
      bootstrapPath: context.bootstrapPath,
      writableRoots: context.writableMounts,
      environment: context.environment,
      ...(context.readonlyInputs === undefined ? {} : { readonlyInputs: context.readonlyInputs }),
      ...(context.scratchBytes === undefined ? {} : { scratchBytes: context.scratchBytes }),
    });
    const observation = await collectBubblewrapStaticObservation({
      binaryPath: options.binaryPath,
      approvedBuilds: options.approvedBuilds,
      ...(options.getcapPath === undefined ? {} : { getcapPath: options.getcapPath }),
    });
    const assessed = assessBubblewrapStaticPrerequisites(observation, options.approvedBuilds);
    if (assessed.status !== "accepted")
      throw new Error(`Bubblewrap prerequisite rejected: ${assessed.reason}`);
    assertRunning();
    child = spawn(
      observation.binary.path,
      [
        "--json-status-fd",
        "5",
        ...args,
        "--",
        "/bin/bash",
        "/bootstrap/bootstrap.sh",
        ...options.argv,
      ],
      {
        env: {},
        stdio: [
          options.stdin === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
          "pipe",
          "pipe",
          "pipe",
        ],
      },
    );
    const launched = child;
    // Listener attachment must be the first operation after spawn.
    try {
      pipes = captureSandboxCommandPipes(launched, currentSpool);
      input = beginSandboxInput(launched, options.stdin);
      cleanup = "unconfirmed";
    } catch (cause) {
      await closeUncaptured(launched);
      throw cause;
    }
    if (stopped) {
      pipes.deny();
      throw new Error("sandbox command setup was stopped");
    }
    if (launched.pid === undefined) throw new Error("Bubblewrap spawn returned no PID");
    const launcher = await observeSandboxProcess(launched.pid);
    const startup = await Promise.race([pipes.startup, pipes.fault, input.fault]);
    await Promise.race([pipes.ready, pipes.fault, input.fault]);
    const final = await observeSandboxProcess(startup.observation.pid);
    verifyFinalSandboxNamespaces(startup.observation, final, host, startup.pidNamespace);
    finalInit = final;
    if (stopped) {
      pipes.deny();
      throw new Error("sandbox command setup was stopped");
    }
    const ready = {
      boot_id: bootId,
      host_observer: { process: host, time_namespace: timeNamespace },
      launcher: { pid: launcher.pid, start_time: launcher.startTime },
      early_init: startup.observation,
      final_init: final,
      startup_pid_namespace: startup.pidNamespace,
      verified_binary: {
        identity: assessed.evidence.binaryIdentity,
        digest: assessed.evidence.sha256,
        path: assessed.evidence.binaryPath,
        approval_id: assessed.evidence.provenance.approvalId,
      },
      output_ref: currentSpool.outputRef,
    };
    // Keep TypeScript's exact child/controller evidence union narrowed here.
    if (context.owner.kind === "controller_operation")
      return Object.freeze({ ...ready, sandbox: context.owner });
    return Object.freeze({ ...ready, sandbox: context.owner });
  }

  async function authorize(): Promise<void> {
    if (stopped || pipes === undefined) throw new Error("sandbox authorization is closed");
    category = "authorization_ambiguous";
    try {
      await pipes.release();
    } catch (cause) {
      category = "authorization_ambiguous";
      throw new SandboxCommandRunnerError(
        "sandbox authorization could not be confirmed",
        terminalEvidence(),
        { cause },
      );
    }
    authorized = true;
  }

  async function settle(): Promise<SandboxCommandResult> {
    if (
      !authorized ||
      pipes === undefined ||
      input === undefined ||
      spool === undefined ||
      finalInit === undefined ||
      scope === undefined
    )
      throw new Error("sandbox command was not authorized");
    try {
      normalizedStatus = await Promise.race([pipes.settlement, input.fault]);
      await input.settled;
    } catch (cause) {
      if (outputFailed) category = "output_incomplete";
      throw new SandboxCommandRunnerError(
        outputFailed
          ? "sandbox output capture failed before command settlement"
          : "sandbox command protocol failed before settlement",
        terminalEvidence(),
        { cause },
      );
    }
    await pipes.drained;
    try {
      output = await spool.finalize();
    } catch (cause) {
      category = "output_incomplete";
      throw new SandboxCommandRunnerError(
        "sandbox output settlement could not be persisted",
        terminalEvidence(),
        { cause },
      );
    }
    if (!(await exactProcessSettled(finalInit))) throw new Error("sandbox init did not settle");
    cleanup = "confirmed";
    if (output.capture !== "complete") {
      category = "output_incomplete";
      throw new SandboxCommandRunnerError(
        "sandbox output capture is incomplete",
        terminalEvidence(),
      );
    }
    category = "command_status";
    return Object.freeze({
      executionId: scope.executionId,
      normalizedStatus,
      signal: "unknown",
      output,
      previews: spool.previews(),
    });
  }

  function terminate(
    reason: "cancelled" | "failed",
    graceMs: number,
  ): Promise<"confirmed" | "unconfirmed"> {
    stopped = true;
    terminationRequested ||= reason === "cancelled";
    if (reason === "cancelled") category = "interrupted";
    pipes?.deny();
    if (terminateWork !== undefined) return terminateWork;
    terminateWork = (async () => {
      // Cleanup runs while pending setup reaches its next stop check. Any process
      // resources are published synchronously before prepare can await again.
      if (pipes === undefined && spool !== undefined) {
        spool.stdout.end();
        spool.stderr.end();
      }
      const processCleanup = terminateSandboxProcesses(finalInit, child, pipes?.closed, graceMs);
      const lateSetup = prepareWork === undefined ? Promise.resolve() : prepareWork;
      const settleLateResources = async () => {
        pipes?.deny();
        if (pipes === undefined && spool !== undefined) {
          spool.stdout.end();
          spool.stderr.end();
        }
        if (pipes !== undefined) await pipes.drained.catch(() => undefined);
        if (input !== undefined) await input.settled.catch(() => undefined);
        if (spool !== undefined)
          await spool.finalize().then(
            (value) => {
              output = value;
            },
            () => {
              outputFailed = true;
              if (cleanup === "confirmed") category = "output_incomplete";
            },
          );
      };
      // Keep this continuation installed even when the controller's bounded
      // cleanup result must return unconfirmed first.
      const lateSettlement = lateSetup.then(settleLateResources, settleLateResources);
      const [setupSettled, processSettled] = await Promise.all([
        bounded(lateSettlement, 2 * graceMs + 500),
        bounded(processCleanup, 2 * graceMs + 900),
      ]);
      cleanup = processSettled && setupSettled ? await processCleanup : "unconfirmed";
      if (!setupSettled || (child !== undefined && finalInit === undefined))
        cleanup = "unconfirmed";
      if (cleanup === "unconfirmed") category = "cleanup_unconfirmed";
      return cleanup;
    })();
    void terminateWork.catch(() => {
      cleanup = "unconfirmed";
      category = "cleanup_unconfirmed";
    });
    return terminateWork;
  }

  function terminalEvidence(): SandboxExecutionTerminal {
    return Object.freeze({
      category:
        cleanup === "unconfirmed"
          ? "cleanup_unconfirmed"
          : outputFailed
            ? "output_incomplete"
            : category,
      normalized_status: normalizedStatus,
      signal: "unknown",
      termination_requested: terminationRequested,
      cleanup,
      ...(spool === undefined ? {} : { output_ref: spool.outputRef }),
      ...(output === undefined ? {} : { output }),
    });
  }

  function assertRunning(): void {
    if (stopped) throw new Error("sandbox command setup was stopped");
    scope?.assertOpen();
  }

  return { prepare, authorize, settle, terminate, terminalEvidence };
}

/** Failure retaining a safe terminal snapshot for controller persistence. */
export class SandboxCommandRunnerError extends Error {
  constructor(
    message: string,
    readonly terminal: SandboxExecutionTerminal,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxCommandRunnerError";
  }
}

async function closeUncaptured(child: ChildProcess): Promise<void> {
  const close = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    child.kill("SIGKILL");
  } catch {
    // Awaiting close below is still mandatory.
  }
  await bounded(close, 1500);
}

function outputOwner(
  owner: import("../../../persistence/sandbox-execution.js").AnySandboxExecutionOwner,
):
  | { readonly childId: string; readonly controllerOrigin?: never }
  | {
      readonly childId?: never;
      readonly controllerOrigin: import("../../../persistence/tool-execution-origin.js").ControllerExecutionOrigin;
    } {
  if (owner.kind === "controller_operation" && owner.origin !== undefined)
    return { controllerOrigin: owner.origin };
  if (owner.child_id === undefined) throw new TypeError("sandbox execution owner is invalid");
  return { childId: owner.child_id };
}

async function bounded(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
