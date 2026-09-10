/** Linux admission evidence capture and recovery validation (issue #103). */
import { readFile, readlink } from "node:fs/promises";
import { Value } from "typebox/value";
import {
  type ToolAdmissionEvidence,
  toolAdmissionSchema,
} from "../../persistence/tool-admission.js";
import {
  type ProcessObservationScope,
  readProcessIdentity,
  snapshotProcessNamespace,
} from "./supervised-process-identity.js";

/** Refuse recovery when its original process-observation context cannot be established. */
export class ToolAdmissionError extends Error {
  constructor(
    readonly code:
      | "admission_evidence_invalid"
      | "admission_origin_unavailable"
      | "admission_origin_mismatch",
  ) {
    const detail =
      code === "admission_evidence_invalid"
        ? "Admission evidence is invalid; recover an intact canonical log. Do not reconstruct a baseline from current processes."
        : code === "admission_origin_mismatch"
          ? "Admission evidence belongs to a different boot or process-observation namespace. Inspect on the original host/boot and PID, time, and network namespaces."
          : "Cannot observe the admission origin. Check access to procfs boot and namespace metadata on the original host.";
    super(`${detail} Cleanup remains unconfirmed; no confirmation was written.`);
    this.name = "ToolAdmissionError";
  }
}

type Origin = Omit<ToolAdmissionEvidence, "schema_version" | "preexisting_before">;

async function currentOrigin(): Promise<Origin> {
  try {
    const [boot, pid, time, network, status, init] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readlink("/proc/self/ns/pid"),
      readlink("/proc/self/ns/time"),
      readlink("/proc/self/ns/net"),
      readFile("/proc/self/status", "utf8"),
      readProcessIdentity(1),
    ]);
    const namespacePids = /^NSpid:\s*(.*)$/m.exec(status)?.[1]?.trim().split(/\s+/);
    // A procfs mounted for an ancestor PID namespace reports multiple NSpid values.
    // Never mix that PID view with the observer's own namespace identifiers.
    if (namespacePids?.length !== 1 || namespacePids[0] !== String(process.pid))
      throw new ToolAdmissionError("admission_origin_mismatch");
    if (init === null) throw new ToolAdmissionError("admission_origin_unavailable");
    return {
      boot_id: boot.trim(),
      pid_namespace: pid,
      time_namespace: time,
      network_namespace: network,
      init_start_time: init.startTime,
    };
  } catch (error) {
    if (error instanceof ToolAdmissionError) throw error;
    throw new ToolAdmissionError("admission_origin_unavailable");
  }
}

function sameOrigin(left: Origin, right: Origin): boolean {
  return (
    left.boot_id === right.boot_id &&
    left.pid_namespace === right.pid_namespace &&
    left.time_namespace === right.time_namespace &&
    left.network_namespace === right.network_namespace &&
    left.init_start_time === right.init_start_time
  );
}

/** Capture a conservative tick boundary before any operation is admitted, without environment reads. */
export async function captureToolAdmission(): Promise<ToolAdmissionEvidence> {
  const origin = await currentOrigin();
  const snapshot = await snapshotProcessNamespace();
  let boundary: bigint | undefined;
  for (const identity of snapshot.preexisting.values()) {
    if (!/^(0|[1-9][0-9]{0,63})$/.test(identity.startTime))
      throw new ToolAdmissionError("admission_evidence_invalid");
    const tick = BigInt(identity.startTime);
    if (boundary === undefined || tick > boundary) boundary = tick;
  }
  if (boundary === undefined) throw new ToolAdmissionError("admission_origin_unavailable");
  if (!sameOrigin(origin, await currentOrigin()))
    throw new ToolAdmissionError("admission_origin_mismatch");
  const evidence = { schema_version: 1 as const, ...origin, preexisting_before: String(boundary) };
  if (!Value.Check(toolAdmissionSchema, evidence))
    throw new ToolAdmissionError("admission_evidence_invalid");
  return Object.freeze(evidence);
}

/** Restore only original, validated evidence; never take a replacement admission snapshot. */
export async function restoreToolAdmission(evidence: unknown): Promise<ProcessObservationScope> {
  if (!Value.Check(toolAdmissionSchema, evidence))
    throw new ToolAdmissionError("admission_evidence_invalid");
  if (!sameOrigin(evidence, await currentOrigin()))
    throw new ToolAdmissionError("admission_origin_mismatch");
  return { preexisting: new Map(), preexistingBefore: evidence.preexisting_before };
}
