/** Read-only original-host recovery; never scans, signals, or replays commands (#106 §6). */
import { readFile, readlink } from "node:fs/promises";
import type { SandboxExecutionHostObserver } from "../../../persistence/sandbox-execution.js";
import type { ToolExecutionTimelineEntry } from "../../../persistence/tool-execution.js";
import {
  type SandboxCleanupEvidence,
  sameSandboxObserverOrigin,
  sameSandboxProcessObservation,
} from "../../../persistence/tool-execution-cleanup.js";
import {
  classifySandboxProcess,
  observeSandboxProcess,
  SandboxProcessObservationError,
} from "./process-observation.js";

type Classification = Awaited<ReturnType<typeof classifySandboxProcess>>;
interface Origin {
  readonly bootId: string;
  readonly observer: SandboxExecutionHostObserver;
}
interface ProcessView {
  readonly pid: number;
  readonly startTime: string;
  readonly state: Classification;
}

/** Safe inspection data. Only explicit operator confirmation can resolve the execution. */
export interface SandboxCleanupInspection {
  readonly status:
    | "missing_ready"
    | "origin_mismatch"
    | "unreadable"
    | "live"
    | "attestation_required";
  readonly guidance: string;
  readonly outputRef?: string;
  readonly init?: ProcessView;
  readonly launcher?: ProcessView;
  readonly evidence?: SandboxCleanupEvidence;
  readonly diagnostic?: {
    readonly operation: string;
    readonly code: string;
    readonly pid?: number;
  };
}

/** Read-only dependency boundary for original-host recovery tests. */
export interface SandboxRecoveryReader {
  readonly origin: () => Promise<Origin>;
  readonly classify: typeof classifySandboxProcess;
  readonly observe: typeof observeSandboxProcess;
}

const reader: SandboxRecoveryReader = {
  origin: async () => {
    const [bootId, processObservation, timeNamespace] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8").then((value) => value.trim()),
      observeSandboxProcess(process.pid),
      readlink("/proc/self/ns/time"),
    ]);
    return { bootId, observer: { process: processObservation, time_namespace: timeNamespace } };
  },
  classify: classifySandboxProcess,
  observe: observeSandboxProcess,
};

/** Inspect recorded identities; missing/reused init never automatically proves cleanup. */
export async function inspectSandboxCleanup(
  entry: ToolExecutionTimelineEntry,
  access: SandboxRecoveryReader = reader,
): Promise<SandboxCleanupInspection> {
  const ready = entry.ready;
  if (ready === undefined)
    return {
      status: "missing_ready",
      guidance:
        "No usable READY identity was persisted. Preserve the canonical log and private project/output files; restore intact original-host evidence before recovery. Do not replay this command.",
    };
  let operation = "read_origin";
  try {
    const origin = await access.origin();
    if (
      origin.bootId !== ready.boot_id ||
      !sameSandboxObserverOrigin(ready.host_observer, origin.observer)
    )
      return {
        status: "origin_mismatch",
        outputRef: ready.output_ref,
        guidance:
          "Run recovery on the original boot and host namespaces with canonical storage. Current origin differs from READY; cleanup remains unconfirmed. Do not replay.",
      };
    operation = "inspect_init";
    const initState = await access.classify(ready.final_init);
    if (initState === "alive") {
      const actual = await access.observe(ready.final_init.pid);
      if (!sameSandboxProcessObservation(ready.final_init, actual))
        throw new Error("recorded init identity or namespaces changed");
    }
    const init = {
      pid: ready.final_init.pid,
      startTime: ready.final_init.startTime,
      state: initState,
    };
    operation = "inspect_launcher";
    const launcherIdentity = { pid: ready.launcher.pid, startTime: ready.launcher.start_time };
    const launcherState = await access.classify(launcherIdentity);
    const launcher = { ...launcherIdentity, state: launcherState };
    if (initState === "alive" || launcherState === "alive")
      return {
        status: "live",
        outputRef: ready.output_ref,
        init,
        launcher,
        guidance:
          "An exact recorded sandbox process is still live. Stop the original owned processes, inspect partial effects, and rerun inspection before confirming cleanup. This command does not send signals.",
      };
    return {
      status: "attestation_required",
      outputRef: ready.output_ref,
      init,
      launcher,
      guidance:
        "Observed identities are no longer live, but absence alone is not namespace cleanup proof. Inspect all original processes/writers and partial files/output, then use --execution <id> --confirm-cleanup --note <inspection details> on this original host. Unfinalized output remains retained; no command is replayed.",
      evidence: {
        owner: ready.sandbox,
        boot_id: origin.bootId,
        observer: origin.observer,
        final_init: ready.final_init,
        launcher: ready.launcher,
        init_observation: initState,
        launcher_observation: launcherState,
        output_ref: ready.output_ref,
      },
    };
  } catch (cause) {
    const diagnostic =
      cause instanceof SandboxProcessObservationError
        ? { operation: cause.operation, code: cause.code, pid: cause.pid }
        : { operation, code: safeCode(cause) };
    return {
      status: "unreadable",
      outputRef: ready.output_ref,
      diagnostic,
      guidance: `Sandbox observation failed: operation=${diagnostic.operation} code=${diagnostic.code}${"pid" in diagnostic ? ` pid=${diagnostic.pid}` : ""}. Restore authorized procfs observation on the original host, then retry inspection. Cleanup remains unconfirmed; preserve partial effects and do not replay.`,
    };
  }
}

function safeCode(cause: unknown): string {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)
    ? code
    : "INVALID_OBSERVATION";
}
