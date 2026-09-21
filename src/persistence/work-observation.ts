/** Host-generated v2 work observations reconstructed from durable records (§11–§12). */

import type { RecipientTaskContextV2 } from "../core/types.js";
import { assertAcceptedControlV2 } from "./accepted-control-v2.js";
import type { PersistedRecord } from "./log.js";
import { sha256Canonical } from "./trajectory-records.js";
import {
  boundedObservation,
  boundText,
  collectEvidence,
  deriveChildObservation,
  findChildAcceptance,
  inferOrchestrator,
  legacyTask,
  projectHints,
  projectTask,
  recordRunId,
  roleVisit,
} from "./work-observation-bounds.js";

export { WorkObservationSizeError } from "./work-observation-bounds.js";

/** Host-derived terminal facts for one delegated child invocation. */
export interface ChildTerminalObservationV2 {
  readonly outcome: "returned" | "failed" | "cancelled";
  readonly workspace_state: "changed" | "clean" | "invalid" | "uninspected";
  readonly reported_status?: string;
}

/** A compact durable execution fact; it carries no command or output. */
export interface HostExecutionObservation {
  readonly status: string;
}

/** A safe artifact label; content, IDs, and storage paths are excluded. */
export interface HostArtifactObservation {
  readonly kind: string;
  readonly basename: string;
  readonly description?: string;
}

/** Pure, bounded observation reconstructed from an append-only run log. */
export interface WorkObservationV2 {
  readonly schema_version: 2;
  readonly observation_key: string;
  readonly source: "dispatch" | "role_return" | "delegated_result" | "host_failure";
  readonly provenance: {
    readonly record_key: string;
    readonly run_id: string;
    readonly role: string;
    readonly visit: number;
    readonly accepted_at: string;
    readonly child?: {
      readonly child_id: string;
      readonly subagent: string;
      readonly task_id: string;
      readonly attempt: number;
    };
  };
  readonly task: RecipientTaskContextV2;
  readonly reported_hints: {
    readonly summary?: string;
    readonly reason?: string;
    readonly verification?: readonly string[];
  };
  readonly ignored_hint_fields?: readonly string[];
  readonly ignored_hint_diagnostics?: readonly string[];
  readonly observed: {
    readonly terminal: "dispatched" | "returned_control" | "returned" | "failed" | "cancelled";
    readonly workspace_state?: ChildTerminalObservationV2["workspace_state"];
    readonly changed_paths: readonly string[];
    readonly executions: readonly HostExecutionObservation[];
    readonly artifacts: readonly HostArtifactObservation[];
  };
  readonly omitted: {
    readonly changed_paths: number;
    readonly executions: number;
    readonly artifacts: number;
  };
}

/** Closed prompt-safe projection of a durable work observation (§12). */
export interface RecipientObservationV2 {
  readonly source_role: string;
  readonly source_kind: WorkObservationV2["source"];
  readonly task: RecipientTaskContextV2;
  readonly terminal: WorkObservationV2["observed"]["terminal"];
  readonly workspace_state?: WorkObservationV2["observed"]["workspace_state"];
  readonly changed_paths: readonly string[];
  readonly execution_statuses: readonly string[];
  readonly artifact_labels: readonly string[];
  readonly omitted: WorkObservationV2["omitted"];
  /**
   * Issue #137 Phase 2: returned worker's supported narrative
   * (reported/untrusted). The `reason` field is the primary carried
   * value and is mandatory in the rendered v2 seed; `summary` and
   * `verification` are surfaced alongside when present. Empty when
   * the observation's source carried no hints.
   */
  readonly reported_hints: {
    readonly summary?: string;
    readonly reason?: string;
    readonly verification?: readonly string[];
  };
  /**
   * Issue #137 Phase 2: host-recorded list of unsupported return-envelope
   * fields the worker's tool call carried (e.g. `phase`, `tdd_stage`,
   * `changed_paths`, `red_*`, `green_*`). Surfaced verbatim to the
   * orchestrator's seed so a self-correcting role can see them.
   */
  readonly ignored_hint_fields?: readonly string[];
  /** Stable diagnostics for ignored worker-return fields (issue #137). */
  readonly ignored_hint_diagnostics?: readonly string[];
}

/** Materialize all v2 observations in canonical append order. */
export function materializeWorkObservations(
  records: readonly PersistedRecord[],
  runId: string,
  options: { readonly requireV2Control?: boolean } = {},
): readonly WorkObservationV2[] {
  const observations: WorkObservationV2[] = [];
  const evidenceCursors = new Map<string, number>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || recordRunId(record) !== runId) continue;
    if (record.type === "transition_accepted") {
      if (record.event !== "handoff") continue;
      if (options.requireV2Control) {
        assertAcceptedControlV2(
          record.accepted_control,
          record.to === "done" ? undefined : record.to,
          record.role === inferOrchestrator(records, index, record.role) ? "dispatch" : "return",
        );
      }
      observations.push(
        boundedObservation(buildTransitionObservation(records, index, record, evidenceCursors)),
      );
      continue;
    }
    if (record.type === "subagent_completed" || record.type === "subagent_failed") {
      observations.push(boundedObservation(buildChildObservation(records, index, record)));
      continue;
    }
    if (record.type === "session_failed") {
      observations.push(
        boundedObservation(buildHostFailureObservation(records, index, record, evidenceCursors)),
      );
    }
  }
  return Object.freeze(observations.map((observation) => Object.freeze(observation)));
}

/** Project a durable observation without exposing host identities or evidence internals. */
export function projectRecipientObservation(
  observation: WorkObservationV2,
): RecipientObservationV2 {
  const task = projectTask(observation.task);
  const projected: RecipientObservationV2 = {
    source_role: observation.provenance.role,
    source_kind: observation.source,
    task,
    terminal: observation.observed.terminal,
    ...(observation.observed.workspace_state === undefined
      ? {}
      : { workspace_state: observation.observed.workspace_state }),
    changed_paths: [...observation.observed.changed_paths],
    execution_statuses: observation.observed.executions.map((entry) => entry.status),
    artifact_labels: observation.observed.artifacts.map((entry) =>
      entry.description === undefined
        ? `${entry.kind}: ${entry.basename}`
        : `${entry.kind}: ${entry.description}`,
    ),
    omitted: { ...observation.omitted },
    reported_hints: { ...observation.reported_hints },
    ...(observation.ignored_hint_fields === undefined
      ? {}
      : { ignored_hint_fields: [...observation.ignored_hint_fields] }),
    ...(observation.ignored_hint_diagnostics === undefined
      ? {}
      : { ignored_hint_diagnostics: [...observation.ignored_hint_diagnostics] }),
  };
  return Object.freeze(projected);
}

function buildTransitionObservation(
  records: readonly PersistedRecord[],
  index: number,
  record: Extract<PersistedRecord, { type: "transition_accepted" }>,
  cursors: Map<string, number>,
): WorkObservationV2 {
  const role = record.role;
  const sessionKey = `${role}\u0000${record.session_file}`;
  const previous = cursors.get(sessionKey) ?? 0;
  cursors.set(sessionKey, index + 1);
  const evidence = collectEvidence(
    records,
    previous,
    index,
    record.run_id,
    role,
    record.session_file,
    roleVisit(records, index, role, record.session_file),
  );
  const control = record.accepted_control;
  const task = control?.task ?? legacyTask(role);
  const hints = control?.reported_hints ?? {};
  const source: WorkObservationV2["source"] =
    control?.direction === "dispatch" ||
    (control === undefined &&
      record.event === "handoff" &&
      role === inferOrchestrator(records, index, role))
      ? "dispatch"
      : "role_return";
  const terminal = source === "dispatch" ? "dispatched" : "returned_control";
  return makeObservation({
    runId: record.run_id,
    source,
    recordKey: `transition_accepted:${index}`,
    role,
    visit: roleVisit(records, index, role, record.session_file),
    ts: record.ts,
    task,
    hints,
    ...(control?.ignored_hint_fields === undefined || control.ignored_hint_fields.length === 0
      ? {}
      : { ignoredHintFields: control.ignored_hint_fields }),
    ...(control?.ignored_hint_diagnostics === undefined ||
    control.ignored_hint_diagnostics.length === 0
      ? {}
      : { ignoredHintDiagnostics: control.ignored_hint_diagnostics }),
    terminal,
    changedPaths: evidence.changedPaths,
    executions: evidence.executions,
    artifacts: evidence.artifacts,
  });
}

function buildChildObservation(
  records: readonly PersistedRecord[],
  index: number,
  record: Extract<PersistedRecord, { type: "subagent_completed" | "subagent_failed" }>,
): WorkObservationV2 {
  const acceptance = findChildAcceptance(records, index, record.child_id, record.task_id);
  const taskEntry =
    acceptance !== null && acceptance.schema_version !== 1
      ? acceptance.accepted_args.tasks.find((task) => task.id === record.task_id)
      : undefined;
  const task: RecipientTaskContextV2 = {
    host_directive: "Assess the returned delegated work",
    ...(taskEntry === undefined
      ? {}
      : { reported_objective: boundText(taskEntry.objective, 2048) }),
    ...(taskEntry === undefined
      ? {}
      : { reported_action: boundText(taskEntry.expected_output, 2048) }),
  };
  const terminal = record.terminal_observation ?? deriveChildObservation(record);
  const changedPaths = record.completion_evidence?.changed_paths ?? [];
  const workspaceState = terminal.workspace_state;
  const role = acceptance?.parent_role ?? "unknown";
  const visit = acceptance?.parent_visit_index ?? 0;
  return makeObservation({
    runId: record.run_id,
    source: "delegated_result",
    recordKey: `${record.type}:${index}`,
    role,
    visit,
    ts: record.ts,
    task,
    hints: {},
    terminal: terminal.outcome,
    workspaceState,
    changedPaths,
    executions: [],
    artifacts: [],
    child: {
      child_id: record.child_id,
      subagent: record.subagent,
      task_id: record.task_id,
      attempt: 1,
    },
  });
}

function buildHostFailureObservation(
  records: readonly PersistedRecord[],
  index: number,
  record: Extract<PersistedRecord, { type: "session_failed" }>,
  cursors: Map<string, number>,
): WorkObservationV2 {
  const previousAccepted = [...records]
    .slice(0, index)
    .reverse()
    .find(
      (entry) =>
        entry.type === "transition_accepted" &&
        entry.to === record.role &&
        entry.accepted_control !== undefined,
    );
  const task =
    previousAccepted?.type === "transition_accepted" &&
    previousAccepted.accepted_control !== undefined
      ? previousAccepted.accepted_control.task
      : legacyTask(record.role);
  const sessionKey = `${record.role}\u0000${record.session_file}`;
  const previous = cursors.get(sessionKey) ?? 0;
  cursors.set(sessionKey, index + 1);
  const evidence = collectEvidence(
    records,
    previous,
    index,
    record.run_id,
    record.role,
    record.session_file,
    record.visit_index,
  );
  return makeObservation({
    runId: record.run_id,
    source: "host_failure",
    recordKey: `session_failed:${index}`,
    role: record.role,
    visit: record.visit_index,
    ts: record.ts,
    task,
    hints:
      record.failure_reason === undefined ? {} : { reason: boundText(record.failure_reason, 2048) },
    terminal: "failed",
    changedPaths: evidence.changedPaths,
    executions: evidence.executions,
    artifacts: evidence.artifacts,
  });
}

function makeObservation(args: {
  readonly runId: string;
  readonly source: WorkObservationV2["source"];
  readonly recordKey: string;
  readonly role: string;
  readonly visit: number;
  readonly ts: number;
  readonly task: RecipientTaskContextV2;
  readonly hints: WorkObservationV2["reported_hints"];
  readonly ignoredHintFields?: readonly string[];
  readonly ignoredHintDiagnostics?: readonly string[];
  readonly terminal: WorkObservationV2["observed"]["terminal"];
  readonly workspaceState?: WorkObservationV2["observed"]["workspace_state"];
  readonly changedPaths: readonly string[];
  readonly executions: readonly HostExecutionObservation[];
  readonly artifacts: readonly HostArtifactObservation[];
  readonly child?: WorkObservationV2["provenance"]["child"];
}): WorkObservationV2 {
  const acceptedAt = new Date(args.ts).toISOString();
  const child = args.child;
  const provenance = {
    record_key: args.recordKey,
    run_id: args.runId,
    role: args.role,
    visit: args.visit,
    accepted_at: acceptedAt,
    ...(child === undefined ? {} : { child }),
  };
  return {
    schema_version: 2,
    observation_key: sha256Canonical({
      domain: "pi-conductor/work-observation/v2",
      run_id: args.runId,
      source: args.source,
      record_key: args.recordKey,
      role: args.role,
      visit: args.visit,
      child: child ?? null,
    }),
    source: args.source,
    provenance,
    task: projectTask(args.task),
    reported_hints: projectHints(args.hints),
    ...(args.ignoredHintFields === undefined || args.ignoredHintFields.length === 0
      ? {}
      : {
          ignored_hint_fields: args.ignoredHintFields
            .slice(0, 32)
            .map((item) => boundText(item, 128)),
        }),
    ...(args.ignoredHintDiagnostics === undefined || args.ignoredHintDiagnostics.length === 0
      ? {}
      : {
          ignored_hint_diagnostics: args.ignoredHintDiagnostics
            .slice(0, 32)
            .map((item) => boundText(item, 128)),
        }),
    observed: {
      terminal: args.terminal,
      ...(args.workspaceState === undefined ? {} : { workspace_state: args.workspaceState }),
      changed_paths: args.changedPaths,
      executions: args.executions,
      artifacts: args.artifacts,
    },
    omitted: { changed_paths: 0, executions: 0, artifacts: 0 },
  };
}
