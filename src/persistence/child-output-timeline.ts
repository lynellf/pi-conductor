/** Pure reconstruction of the issue #116 child-output journal. */
import { parseControllerConfig } from "../manifest/controller.js";
import { intersectOutputAudience } from "../manifest/output-audience.js";
import {
  assertChildOutputRecord,
  type ChildOutputFailedRecord,
  type ChildOutputPublishedRecord,
  type ChildOutputStartedRecord,
  isChildOutputRecord,
} from "./child-output-records.js";
import type {
  ControllerActivationStartedRecord,
  ControllerDefinitionPinnedRecord,
} from "./controller-records.js";
import { reconstructControllerTimeline } from "./controller-timeline.js";
import {
  assertDelegationTaskTimeline,
  type DelegationAcceptedChild,
  type DelegationSubmissionAcceptedRecord,
} from "./delegation-task.js";
import type { PersistedRecord, SubagentCompletedRecord, SubagentFailedRecord } from "./log.js";
import { sha256Canonical } from "./trajectory-records.js";

type Terminal = SubagentCompletedRecord | SubagentFailedRecord;
/** One durably started or explicitly failed collection; no worker rerun is implied. */
export interface ChildOutputTimelineChild {
  readonly child_id: string;
  readonly status: "pending" | "published" | "failed";
  readonly start: ChildOutputStartedRecord | null;
  readonly terminal: Terminal;
  readonly publication: ChildOutputPublishedRecord | ChildOutputFailedRecord | null;
}
/** Collection facts across all validated activation epochs. */
export interface ChildOutputTimeline {
  readonly latestActivation: ControllerActivationStartedRecord | null;
  readonly children: readonly ChildOutputTimelineChild[];
}

/** Validate each append against the owner, acceptance and terminal that preceded it. */
export function reconstructChildOutputTimeline(
  records: readonly PersistedRecord[],
): ChildOutputTimeline {
  if (!records.some(isChildOutputRecord)) return { latestActivation: null, children: [] };
  reconstructControllerTimeline(records);
  assertDelegationTaskTimeline(records);
  let definition: ControllerDefinitionPinnedRecord | undefined;
  let activation: ControllerActivationStartedRecord | null = null;
  const accepted = new Map<
    string,
    { child: DelegationAcceptedChild; submission: DelegationSubmissionAcceptedRecord }
  >();
  const states = new Map<string, ChildOutputTimelineChild>();
  for (const [ordinal, record] of records.entries()) {
    if (record.type === "controller_definition_pinned") definition = record;
    if (record.type === "controller_activation_started") activation = record;
    if (record.type === "delegation_submission_accepted") {
      for (const child of record.children)
        accepted.set(child.child_id, { child, submission: record });
    }
    if (!isChildOutputRecord(record)) continue;
    assertChildOutputRecord(record);
    if (definition === undefined || activation === null)
      throw new Error("child output precedes controller ownership");
    for (const field of [
      "run_id",
      "controller_id",
      "definition_digest",
      "activation_id",
      "owner_epoch",
    ] as const)
      if (record[field] !== activation[field]) throw new Error("child output owner mismatch");
    const entry = accepted.get(record.child_id);
    if (
      entry === undefined ||
      entry.submission.schema_version !== 2 ||
      entry.submission.origin.kind !== "controller_action" ||
      entry.submission.run_id !== record.run_id ||
      entry.submission.origin.controller_id !== record.controller_id ||
      entry.submission.origin.definition_digest !== record.definition_digest
    )
      throw new Error("child output lacks matching controller acceptance");
    if (
      entry.child.task_id !== record.task_id ||
      entry.child.subagent !== record.producer_profile_id
    )
      throw new Error("child output accepted identity mismatch");
    const terminal = records[record.terminal.ordinal];
    if (
      record.terminal.ordinal >= ordinal ||
      terminal === undefined ||
      (terminal.type !== "subagent_completed" && terminal.type !== "subagent_failed") ||
      terminal.child_id !== record.child_id ||
      terminal.run_id !== record.run_id ||
      terminal.task_id !== record.task_id ||
      terminal.subagent !== record.producer_profile_id ||
      terminal.base_commit !== entry.child.base_commit ||
      sha256Canonical(terminal) !== record.terminal.record_digest
    )
      throw new Error("child output terminal reference mismatch");
    const prior = states.get(record.child_id);
    if (prior !== undefined && prior.status !== "pending")
      throw new Error("duplicate child output settlement");
    if (record.type === "controller_child_output_started") {
      if (prior !== undefined) throw new Error("duplicate child output start");
      if (
        terminal.output_capture === undefined ||
        sha256Canonical(terminal.output_capture) !== sha256Canonical(record.capture) ||
        record.capture.accepted_base !== entry.child.base_commit
      )
        throw new Error("child output capture disagrees with terminal");
      const pinned = definition.pinned_definition;
      if (pinned === null || typeof pinned !== "object" || !("config" in pinned))
        throw new Error("child output pinned configuration missing");
      const policy = parseControllerConfig(pinned.config).child_outputs?.find(
        (item) => item.profile_id === record.producer_profile_id,
      );
      if (policy === undefined || sha256Canonical(policy) !== sha256Canonical(record.policy))
        throw new Error("child output policy disagrees with pinned definition");
      assertCapturePolicy(record);
      states.set(record.child_id, {
        child_id: record.child_id,
        status: "pending",
        start: record,
        terminal,
        publication: null,
      });
      continue;
    }
    if (prior === undefined) {
      if (
        record.type !== "controller_child_output_failed" ||
        record.intent_digest !== null ||
        terminal.output_capture_failure === undefined
      )
        throw new Error("child output settlement precedes its intent");
      states.set(record.child_id, {
        child_id: record.child_id,
        status: "failed",
        start: null,
        terminal,
        publication: record,
      });
      continue;
    }
    if (
      prior.start === null ||
      record.intent_digest !== sha256Canonical(prior.start) ||
      sha256Canonical(record.terminal) !== sha256Canonical(prior.start.terminal)
    )
      throw new Error("child output intent mismatch");
    if (record.type === "controller_child_output_published") assertPublication(record, prior.start);
    states.set(record.child_id, {
      ...prior,
      status: record.type === "controller_child_output_published" ? "published" : "failed",
      publication: record,
    });
  }
  return { latestActivation: activation, children: [...states.values()] };
}

function assertCapturePolicy(start: ChildOutputStartedRecord): void {
  const selections = [
    ...start.policy.reports.map((report) => ({
      id: report.id,
      path: report.path,
      kind: "report",
      media_type: report.media_type,
      max_bytes: report.max_bytes,
    })),
    ...(start.policy.patch === undefined
      ? []
      : [
          {
            id: start.policy.patch.id,
            path: null,
            kind: "patch",
            media_type: "application/x-git-patch",
            max_bytes: start.policy.patch.max_bytes,
          },
        ]),
  ];
  if (selections.length !== start.capture.outputs.length)
    throw new Error("child output capture selection mismatch");
  for (const output of start.capture.outputs) {
    const selected = selections.find((item) => item.id === output.id);
    if (
      selected === undefined ||
      output.path !== selected.path ||
      output.kind !== selected.kind ||
      output.media_type !== selected.media_type ||
      output.byte_length > selected.max_bytes
    )
      throw new Error("child output capture exceeds selected policy");
  }
}
function assertPublication(
  record: ChildOutputPublishedRecord,
  start: ChildOutputStartedRecord,
): void {
  if (record.outputs.length !== start.capture.outputs.length)
    throw new Error("child output publication count mismatch");
  for (const output of record.outputs) {
    const captured = start.capture.outputs.find((item) => item.id === output.binding.output.id);
    const selected =
      start.policy.reports.find((item) => item.id === output.binding.output.id) ??
      start.policy.patch;
    if (
      captured === undefined ||
      selected === undefined ||
      output.sha256 !== captured.sha256 ||
      output.byte_length !== captured.byte_length ||
      output.media_type !== captured.media_type ||
      output.binding.acceptedBase !== start.capture.accepted_base ||
      output.binding.outputPolicyDigest !== start.capture.policy_digest ||
      sha256Canonical(output.binding.output) !==
        sha256Canonical({ id: captured.id, path: captured.path, kind: captured.kind }) ||
      sha256Canonical(output.binding.audience) !==
        sha256Canonical(intersectOutputAudience(selected.consumers, start.input_audience))
    )
      throw new Error("child output publication disagrees with capture or audience");
    const binding = output.binding;
    const namespace = sha256Canonical({
      run_id: binding.runId,
      definition_digest: binding.definitionDigest,
      child_id: binding.childId,
      task_id: binding.taskId,
      accepted_base: binding.acceptedBase,
      terminal: binding.terminal,
      producer_profile_id: binding.producerProfileId,
    });
    const manifest = sha256Canonical({
      schema_version: 2,
      binding,
      content: {
        sha256: output.sha256,
        byte_length: output.byte_length,
        media_type: output.media_type,
      },
    });
    if (output.ref !== `child-output/v2/${namespace}/${manifest}`)
      throw new Error("child output reference does not bind immutable descriptor");
  }
}
