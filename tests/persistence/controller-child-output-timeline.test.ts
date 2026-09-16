import { describe, expect, it } from "vitest";
import { buildChildOutputManifest } from "../../src/host/controller/child-output-store-contract.js";
import { reconstructChildOutputTimeline } from "../../src/persistence/child-output-timeline.js";
import { controllerDefinitionDigest } from "../../src/persistence/controller-records.js";
import {
  controllerDelegationSubmissionId,
  controllerLogicalParentId,
} from "../../src/persistence/delegation-task.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const digest = "a".repeat(64);
const base = "b".repeat(40);
const policy = {
  profile_id: "worker",
  reports: [
    {
      id: "report",
      path: "reports/result.json",
      media_type: "application/json",
      max_bytes: 100,
      consumers: [{ kind: "controller" }],
    },
  ],
};
const capture = {
  schema_version: 1,
  accepted_base: base,
  head_commit: base,
  policy_digest: sha256Canonical(policy),
  profile_id: "worker",
  outputs: [
    {
      id: "report",
      path: "reports/result.json",
      kind: "report",
      media_type: "application/json",
      sha256: digest,
      byte_length: 10,
    },
  ],
};

function history() {
  const terminal = {
    type: "subagent_completed",
    run_id: "run",
    child_id: "child",
    task_id: "task",
    subagent: "worker",
    model: "model",
    status: "completed",
    summary: "done",
    branch: "branch",
    worktree_path: "/tmp/worktree",
    base_commit: base,
    head_commit: base,
    session_file: "session",
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
    ts: 4,
    output_capture: capture,
  };
  const terminalDigest = sha256Canonical(terminal);
  const started = {
    type: "controller_child_output_started",
    schema_version: 1,
    run_id: "run",
    controller_id: "controller",
    definition_digest: digest,
    activation_id: "activation",
    owner_epoch: 1,
    child_id: "child",
    task_id: "task",
    producer_profile_id: "worker",
    terminal: { ordinal: 4, record_digest: terminalDigest },
    ts: 5,
    capture,
    policy,
    input_audience: null,
  };
  const publication = {
    type: "controller_child_output_published",
    schema_version: 1,
    run_id: "run",
    controller_id: "controller",
    definition_digest: digest,
    activation_id: "activation",
    owner_epoch: 1,
    child_id: "child",
    task_id: "task",
    producer_profile_id: "worker",
    terminal: { ordinal: 4, record_digest: terminalDigest },
    ts: 6,
    intent_digest: sha256Canonical(started),
    outputs: [
      {
        ref: `child-output/v2/${digest}/${digest}`,
        sha256: digest,
        byte_length: 10,
        media_type: "application/json",
        binding: {
          runId: "run",
          definitionDigest: digest,
          childId: "child",
          taskId: "task",
          acceptedBase: base,
          terminal: { ordinal: 4, recordDigest: terminalDigest },
          producerProfileId: "worker",
          output: { id: "report", path: "reports/result.json", kind: "report" },
          outputPolicyDigest: sha256Canonical(policy),
          mediaType: "application/json",
          audience: [{ kind: "controller" }],
        },
      },
    ],
  };
  const config = {
    protocol_version: 1,
    controller_id: "controller",
    runtime_id: "runtime",
    executable: "/bin/bash",
    argv: [],
    adapters: [],
    child_outputs: [policy],
    delegation: { allowed_subagents: ["worker"], max_parallel: 1, max_children_per_session: 2 },
  };
  const definitionFields = {
    type: "controller_definition_pinned" as const,
    schema_version: 1 as const,
    run_id: "run",
    controller_id: "controller",
    pinned_definition: { config },
    controller_authority: {
      registration_id: "runtime",
      approval_id: "operator",
      runtime_digest: digest,
      executable_digest: digest,
      capability_digest: digest,
    },
    adapter_authorities: [],
    limits: { max_decisions: 10, max_actions: 10, max_outstanding_actions: 4 },
    ts: 1,
  };
  const definitionDigest = controllerDefinitionDigest(definitionFields);
  const definition = { ...definitionFields, definition_digest: definitionDigest };
  const activation = {
    type: "controller_activation_started" as const,
    schema_version: 1 as const,
    run_id: "run",
    controller_id: "controller",
    definition_digest: definitionDigest,
    activation_id: "activation",
    owner_epoch: 1,
    reason: "start" as const,
    previous_activation_id: null,
    ts: 2,
  };
  const acceptedArgs = {
    mode: "nonblocking" as const,
    tasks: [
      { id: "task", subagent: "worker", objective: "make report", expected_output: "report" },
    ],
  };
  const parent = controllerLogicalParentId("run", "controller", definitionDigest);
  const child = {
    child_id: "child",
    task_id: "task",
    subagent: "worker",
    model: "model",
    branch: "branch",
    worktree_path: "/tmp/worktree",
    base_commit: base,
    task_fingerprint: digest,
    profile_fingerprint: digest,
    context_fingerprint: digest,
    prompt_fingerprint: digest,
    projection_fingerprint: { kind: "exact" as const, path_count: 0, sha256: digest },
  };
  const accepted = {
    type: "delegation_submission_accepted" as const,
    schema_version: 2 as const,
    run_id: "run",
    submission_id: controllerDelegationSubmissionId("run", parent, "delegate"),
    logical_parent_id: parent,
    parent_role: "orchestrator",
    parent_visit_index: 1,
    origin: {
      kind: "controller_action" as const,
      controller_id: "controller",
      definition_digest: definitionDigest,
      action_id: "delegate",
      activation_id: "activation",
    },
    accepted_args: acceptedArgs,
    input_fingerprint: sha256Canonical(acceptedArgs),
    children: [child],
    ts: 3,
  };
  const nativeStart = {
    type: "subagent_started" as const,
    run_id: "run",
    child_id: "child",
    task_id: "task",
    subagent: "worker",
    model: "model",
    branch: "branch",
    worktree_path: "/tmp/worktree",
    base_commit: base,
    parent_role: "orchestrator",
    parent_visit_index: 1,
    session_file: "session",
    ts: 3,
  };
  started.definition_digest = definitionDigest;
  publication.definition_digest = definitionDigest;
  const output = publication.outputs[0];
  if (output === undefined) throw new Error("missing output");
  output.binding.definitionDigest = definitionDigest;
  const bytes = Buffer.from("report-116");
  output.sha256 = sha256Canonical("placeholder");
  const manifest = buildChildOutputManifest(
    output.binding as import("../../src/persistence/child-output-artifact.js").ChildOutputBinding,
    bytes,
  );
  output.ref = manifest.ref;
  output.sha256 = manifest.content.sha256;
  const fingerprint = capture.outputs[0];
  if (fingerprint === undefined) throw new Error("missing fingerprint");
  fingerprint.sha256 = output.sha256;
  const terminalHash = sha256Canonical(terminal);
  started.terminal.record_digest = terminalHash;
  publication.terminal.record_digest = terminalHash;
  output.binding.terminal.recordDigest = terminalHash;
  output.ref = buildChildOutputManifest(
    output.binding as import("../../src/persistence/child-output-artifact.js").ChildOutputBinding,
    bytes,
  ).ref;
  publication.intent_digest = sha256Canonical(started);
  return [
    definition,
    activation,
    accepted,
    nativeStart,
    terminal,
    started,
    publication,
  ] as PersistedRecord[];
}

describe("controller child-output chronology", () => {
  it("reconstructs a published child output lifecycle", () => {
    const timeline = reconstructChildOutputTimeline(history());
    expect(timeline.children).toHaveLength(1);
    expect(timeline.children[0]?.status).toBe("published");
  });

  it("preserves old histories that contain no output records", () => {
    expect(
      reconstructChildOutputTimeline([{ type: "run_seeded", run_id: "run", goal: "goal", ts: 0 }])
        .children,
    ).toEqual([]);
  });

  it.each([
    [
      "publication before start",
      (records: unknown[]) => records.splice(5, 2, records[6], records[5]),
    ],
    [
      "wrong terminal digest",
      (records: unknown[]) =>
        ((records[5] as { terminal: { record_digest: string } }).terminal.record_digest = digest),
    ],
    [
      "wrong accepted base",
      (records: unknown[]) =>
        ((records[5] as { capture: { accepted_base: string } }).capture.accepted_base = "c".repeat(
          40,
        )),
    ],
    ["duplicate publication", (records: unknown[]) => records.push(records[6])],
  ] as const)("rejects %s", (_name, mutate) => {
    const records = structuredClone(history());
    mutate(records);
    expect(() => reconstructChildOutputTimeline(records)).toThrow();
  });
});
