/** Operator inspection and confirmation for unresolved executable tools (issue #97). */

import { readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import type {
  AnyToolExecutionCleanupConfirmedRecord,
  ControllerExecutionOrigin,
  ToolExecutionTimelineEntry,
} from "../../persistence/tool-execution.js";
import {
  isToolExecutionRecord,
  reconstructToolExecutionTimeline,
} from "../../persistence/tool-execution.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { FileRecordLog } from "../log-file.js";
import { inspectSandboxCleanup, type SandboxCleanupInspection } from "./sandbox/recovery.js";
import type { ProcessIdentity } from "./supervised-process-identity.js";
import * as processIdentity from "./supervised-process-identity.js";
import { restoreToolAdmission } from "./tool-admission.js";

const MAX_ID = 256;
const MAX_NOTE = 1000;

/** Filesystem location of the host-owned run log. */
export interface ToolExecutionCleanupOptions {
  readonly baseDir: string;
  /** Inspect only this execution, without scanning unrelated unresolved entries. */
  readonly executionId?: string;
}

interface ToolExecutionUnresolvedCommon {
  readonly executionId: string;
  readonly supervisionId: string;
  readonly entry: ToolExecutionTimelineEntry;
  readonly currentProcesses: readonly ProcessIdentity[];
  readonly sandbox?: SandboxCleanupInspection;
}

/** Safe identity-only view preserving real SDK or controller provenance. */
export type ToolExecutionUnresolvedEntry = ToolExecutionUnresolvedCommon &
  (
    | {
        readonly logicalSessionId: string;
        readonly roleSessionId: string;
        readonly toolCallId: string;
        readonly toolName: string;
        readonly controllerOrigin?: never;
      }
    | {
        readonly logicalSessionId?: never;
        readonly roleSessionId?: never;
        readonly toolCallId?: never;
        readonly toolName?: never;
        readonly controllerOrigin: ControllerExecutionOrigin;
      }
  );

/** Inspection result containing unresolved executions and marked processes. */
export interface ToolExecutionCleanupInspection {
  readonly runId: string;
  readonly unresolved: readonly ToolExecutionUnresolvedEntry[];
  readonly currentProcesses: readonly ProcessIdentity[];
}

/** Typed fail-closed error for operator reconciliation requests. */
export class ToolExecutionReconciliationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolExecutionReconciliationError";
    this.code = code;
  }
}

function valid(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID ||
    /[\0\\/]/u.test(value)
  )
    throw new ToolExecutionReconciliationError("invalid_request", `${label} is invalid`);
  return value;
}

function logFor(runId: string, baseDir: string): FileRecordLog {
  valid(runId, "run_id");
  if (
    typeof baseDir !== "string" ||
    baseDir.length === 0 ||
    baseDir.length > 4096 ||
    baseDir.includes("\0")
  )
    throw new ToolExecutionReconciliationError("invalid_request", "baseDir is invalid");
  return new FileRecordLog({ baseDir });
}

function assertCompleteLog(runId: string, baseDir: string): void {
  const content = readFileSync(join(realpathSync(baseDir), `${runId}.jsonl`), "utf8");
  if (content.length > 0 && !content.endsWith("\n"))
    throw new ToolExecutionReconciliationError(
      "incomplete_log",
      `run '${runId}' has an incomplete trailing record; repair the log separately before reconciliation`,
    );
}

async function inspectWithLog(
  runId: string,
  log: FileRecordLog,
  executionId?: string,
): Promise<ToolExecutionCleanupInspection> {
  if (!log.listRunIds().includes(runId))
    throw new ToolExecutionReconciliationError("run_not_found", `run '${runId}' does not exist`);
  if (process.platform !== "linux")
    throw new ToolExecutionReconciliationError(
      "unsupported_platform",
      "cleanup observation requires Linux",
    );
  const records = log.records(runId).filter(isToolExecutionRecord);
  const timeline = reconstructToolExecutionTimeline(records);
  const unresolved: ToolExecutionUnresolvedEntry[] = [];
  const currentProcesses: ProcessIdentity[] = [];
  for (const entry of timeline.unresolved) {
    const started = entry.started;
    if (executionId !== undefined && executionId !== started.execution_id) continue;
    // Record timestamps are wall-clock milliseconds; /proc startTime is a
    // boot-relative tick count, so they cannot be compared directly.
    const sandbox = started.sandbox === undefined ? undefined : await inspectSandboxCleanup(entry);
    const scope =
      sandbox !== undefined || started.admission === undefined
        ? undefined
        : await restoreToolAdmission(started.admission);
    // No minimum-start prefilter: marker-positive ownership takes precedence
    // over durable age evidence, which only resolves denied environment reads.
    const processes =
      sandbox !== undefined
        ? []
        : await processIdentity.findProcessesByOwnerToken(started.supervision_id, undefined, scope);
    currentProcesses.push(...processes);
    const common = {
      executionId: started.execution_id,
      supervisionId: started.supervision_id,
      entry,
      currentProcesses: processes,
      ...(sandbox === undefined ? {} : { sandbox }),
    };
    unresolved.push(
      started.schema_version === 1
        ? {
            ...common,
            logicalSessionId: started.logical_session_id,
            roleSessionId: started.role_session_id,
            toolCallId: started.tool_call_id,
            toolName: started.tool_name,
          }
        : { ...common, controllerOrigin: started.origin },
    );
  }
  if (executionId !== undefined && unresolved.length === 0)
    throw new ToolExecutionReconciliationError(
      "unknown_or_clean",
      `execution '${executionId}' is unknown or already clean`,
    );
  return {
    runId,
    unresolved: Object.freeze(unresolved),
    currentProcesses: Object.freeze(currentProcesses),
  };
}

/** Inspect unresolved executable tools and their currently marked processes under the run lease. */
export async function inspectToolExecutionCleanup(
  runId: string,
  options: ToolExecutionCleanupOptions,
): Promise<ToolExecutionCleanupInspection> {
  const log = logFor(runId, options.baseDir);
  if (options.executionId !== undefined) valid(options.executionId, "execution_id");
  const lease = await log.acquireRunLease(runId);
  try {
    return await inspectWithLog(runId, log, options.executionId);
  } finally {
    await lease.release();
  }
}

/**
 * Append an operator confirmation after marked-process absence is observed.
 * The acknowledgment attests the original host/PID and network namespace,
 * canonical storage, all original processes—including unmarked descendants—
 * were stopped, and partial effects were inspected.
 * This API never kills processes or replays tools.
 */
export async function reconcileToolExecutionCleanup(
  runId: string,
  executionId: string,
  options: ToolExecutionCleanupOptions & {
    readonly acknowledgment: true;
    readonly operatorNote: string;
    readonly controllerPartialEffects?:
      | "none_observed"
      | "inspected_unpublished"
      | "immutable_publication_verified";
  },
): Promise<AnyToolExecutionCleanupConfirmedRecord> {
  const log = logFor(runId, options.baseDir);
  valid(executionId, "execution_id");
  if (options.acknowledgment !== true)
    throw new ToolExecutionReconciliationError(
      "acknowledgment_required",
      "explicit cleanup acknowledgment is required",
    );
  if (
    typeof options.operatorNote !== "string" ||
    options.operatorNote.length === 0 ||
    options.operatorNote.length > MAX_NOTE ||
    options.operatorNote.trim().length === 0
  )
    throw new ToolExecutionReconciliationError(
      "invalid_request",
      "operatorNote must contain 1–1000 non-whitespace characters",
    );
  const lease = await log.acquireRunLease(runId);
  try {
    if (!log.listRunIds().includes(runId))
      throw new ToolExecutionReconciliationError("run_not_found", `run '${runId}' does not exist`);
    assertCompleteLog(runId, realpathSync(options.baseDir));
    const inspection = await inspectWithLog(runId, log, executionId);
    const target = inspection.unresolved.find((item) => item.executionId === executionId);
    if (target === undefined)
      throw new ToolExecutionReconciliationError(
        "unknown_or_clean",
        `execution '${executionId}' is unknown or already clean`,
      );
    if (
      target.entry.finished !== undefined &&
      target.entry.finished.outcome !== "cleanup_unconfirmed"
    )
      throw new ToolExecutionReconciliationError(
        "not_confirmable",
        "only unresolved cleanup can be reconciled",
      );
    if (target.currentProcesses.length > 0) {
      const detail = target.currentProcesses
        .map((p) => `pid=${p.pid} startTime=${p.startTime} group=${p.processGroupId}`)
        .join(", ");
      throw new ToolExecutionReconciliationError(
        "live_processes",
        `marked processes remain live: ${detail}`,
      );
    }
    const started = target.entry.started;
    if (started.schema_version === 2 && options.controllerPartialEffects === undefined)
      throw new ToolExecutionReconciliationError(
        "invalid_request",
        "controller reconciliation requires an explicit partial-effects classification",
      );
    const sandbox = target.sandbox;
    if (
      sandbox !== undefined &&
      (sandbox.status !== "attestation_required" || sandbox.evidence === undefined)
    )
      throw new ToolExecutionReconciliationError("sandbox_cleanup_unconfirmed", sandbox.guidance);
    const common = {
      type: "tool_execution_cleanup_confirmed" as const,
      run_id: runId,
      execution_id: started.execution_id,
      supervision_id: started.supervision_id,
      cleanup: "confirmed" as const,
      ...(sandbox?.evidence === undefined
        ? { verification: "operator_confirmed_owner_marker_absent" as const }
        : {
            verification: "operator_confirmed_sandbox_cleanup" as const,
            sandbox: sandbox.evidence,
          }),
      operator_note: options.operatorNote,
      operator: userInfo().username,
      ts: Date.now(),
    };
    const record: AnyToolExecutionCleanupConfirmedRecord =
      started.schema_version === 1
        ? {
            ...common,
            schema_version: 1,
            logical_session_id: started.logical_session_id,
            role_session_id: started.role_session_id,
            tool_call_id: started.tool_call_id,
            tool_name: started.tool_name,
          }
        : {
            ...common,
            schema_version: 2,
            origin: structuredClone(started.origin),
            start_record_digest: sha256Canonical(started),
            partial_effects: options.controllerPartialEffects as NonNullable<
              typeof options.controllerPartialEffects
            >,
          };
    // Validate the complete post-append timeline before touching the file. This
    // keeps malformed correlations/timestamps append-only safe.
    reconstructToolExecutionTimeline([...log.records(runId).filter(isToolExecutionRecord), record]);
    log.append(record);
    return record;
  } finally {
    await lease.release();
  }
}
