/** Original platform-specific admission and recovery; never replace original evidence (#103/#165). */
import { readFile, readlink } from "node:fs/promises";
import { Value } from "typebox/value";
import {
  type ToolAdmissionEvidence,
  toolAdmissionSchema,
} from "../../persistence/tool-admission.js";
import { readProcessIdentity, snapshotProcessNamespace } from "./linux-process-identity.js";
import { observeMacProcesses } from "./macos/observer.js";
import type { ProcessObservationScope } from "./process-identity-contract.js";

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
          : "Cannot observe the admission origin. Check original-host process metadata and native observer/procfs capability.";
    super(`${detail} Cleanup remains unconfirmed; no confirmation was written.`);
    this.name = "ToolAdmissionError";
  }
}

type Origin = Omit<
  Extract<ToolAdmissionEvidence, { schema_version: 1 }>,
  "schema_version" | "preexisting_before"
>;

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
  if (process.platform === "darwin") {
    try {
      const observation = await observeMacProcesses("snapshot");
      const starts = observation.processes
        .filter((value) => value.uid === observation.uid && value.startKind === "mach")
        .map((value) => BigInt(value.startTime));
      if (starts.length === 0) throw new ToolAdmissionError("admission_origin_unavailable");
      const boundary = starts.reduce((left, right) => (left > right ? left : right));
      const after = await observeMacProcesses("snapshot");
      if (after.bootId !== observation.bootId || after.uid !== observation.uid)
        throw new ToolAdmissionError("admission_origin_mismatch");
      return Object.freeze({
        schema_version: 2,
        platform: "darwin",
        boot_id: observation.bootId,
        observer_uid: observation.uid,
        preexisting_before: String(boundary),
        preexisting_sessions: observation.processes
          .filter((value) => value.pid === value.sessionId)
          .map((value) => ({
            pid: value.pid,
            start_time: value.startTime,
            start_time_kind: value.startKind,
            process_group_id: value.processGroupId,
            session_id: value.sessionId,
          })),
      });
    } catch (error) {
      if (error instanceof ToolAdmissionError) throw error;
      throw new ToolAdmissionError("admission_origin_unavailable");
    }
  }
  return captureLinuxToolAdmission();
}

/** Capture the historical procfs contract independently of Darwin observation. */
export async function captureLinuxToolAdmission(): Promise<ToolAdmissionEvidence> {
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
  if (evidence.schema_version === 2) {
    if (process.platform !== "darwin") throw new ToolAdmissionError("admission_origin_mismatch");
    let current: Awaited<ReturnType<typeof observeMacProcesses>>;
    try {
      current = await observeMacProcesses("snapshot");
    } catch {
      throw new ToolAdmissionError("admission_origin_unavailable");
    }
    if (current.bootId !== evidence.boot_id || current.uid !== evidence.observer_uid)
      throw new ToolAdmissionError("admission_origin_mismatch");
    const sessions = evidence.preexisting_sessions;
    if (
      sessions.some((value) => value.pid !== value.session_id) ||
      new Set(sessions.map((value) => value.pid)).size !== sessions.length
    )
      throw new ToolAdmissionError("admission_evidence_invalid");
    return {
      preexisting: new Map(
        sessions.map((value) => [
          value.pid,
          {
            pid: value.pid,
            startTime: value.start_time,
            startTimeKind: value.start_time_kind,
            processGroupId: value.process_group_id,
            sessionId: value.session_id,
          },
        ]),
      ),
      preexistingBefore: evidence.preexisting_before,
    };
  }
  if (process.platform !== "linux") throw new ToolAdmissionError("admission_origin_mismatch");
  return restoreLinuxToolAdmission(evidence);
}

/** Restore only Linux v1 evidence in the original procfs origin; used by Linux contract tests. */
export async function restoreLinuxToolAdmission(
  evidence: unknown,
): Promise<ProcessObservationScope> {
  if (!Value.Check(toolAdmissionSchema, evidence) || evidence.schema_version !== 1)
    throw new ToolAdmissionError("admission_evidence_invalid");
  if (!sameOrigin(evidence, await currentOrigin()))
    throw new ToolAdmissionError("admission_origin_mismatch");
  return { preexisting: new Map(), preexistingBefore: evidence.preexisting_before };
}
