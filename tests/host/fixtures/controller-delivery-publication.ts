import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createChildOutputPublication } from "../../../src/host/controller/child-output-publication.js";
import { ChildOutputStore } from "../../../src/host/controller/child-output-store.js";
import type { PoolCompletedResult } from "../../../src/host/delegation/pool.js";
import type { ControllerConfig } from "../../../src/manifest/controller.js";
import type { ChildOutputRecord } from "../../../src/persistence/child-output-records.js";
import { controllerDefinitionDigest } from "../../../src/persistence/controller-records.js";
import {
  controllerDelegationSubmissionId,
  controllerLogicalParentId,
} from "../../../src/persistence/delegation-task.js";
import type { PersistedRecord } from "../../../src/persistence/log.js";
import { sha256Canonical } from "../../../src/persistence/trajectory-records.js";

const execute = promisify(execFile);
const fixedDigest = "a".repeat(64);

export async function publishGatedChildren(input: {
  readonly root: string;
  readonly repository: string;
  readonly base: string;
  readonly aContent: string;
  readonly bContent: string;
  readonly onBPublished: (
    store: ChildOutputStore,
    published: Extract<PersistedRecord, { type: "controller_child_output_published" }>,
    records: readonly PersistedRecord[],
  ) => Promise<void>;
}) {
  const worktreeA = join(input.root, "child-a-worktree");
  const worktreeB = join(input.root, "child-b-worktree");
  await git(input.repository, "worktree", "add", "-q", "-b", "child-a", worktreeA, input.base);
  await git(input.repository, "worktree", "add", "-q", "-b", "child-b", worktreeB, input.base);
  for (const [worktree, content] of [
    [worktreeA, input.aContent],
    [worktreeB, input.bContent],
  ] as const) {
    await mkdir(join(worktree, "reports"));
    await writeFile(join(worktree, "reports", "review.txt"), "review: approved\n");
    await writeFile(join(worktree, "value.txt"), content);
    await chmod(worktree, 0o700);
  }
  const config = configFixture();
  const definitionBase = {
    type: "controller_definition_pinned" as const,
    schema_version: 1 as const,
    run_id: "run",
    controller_id: "controller",
    pinned_definition: { config },
    controller_authority: {
      registration_id: "runtime",
      approval_id: "operator",
      runtime_digest: fixedDigest,
      executable_digest: fixedDigest,
      capability_digest: fixedDigest,
    },
    adapter_authorities: [],
    limits: { max_decisions: 10, max_actions: 10, max_outstanding_actions: 4 },
    ts: 1,
  };
  const definition = {
    ...definitionBase,
    definition_digest: controllerDefinitionDigest(definitionBase),
  };
  const activation = {
    type: "controller_activation_started" as const,
    schema_version: 1 as const,
    run_id: "run",
    controller_id: "controller",
    definition_digest: definition.definition_digest,
    activation_id: "activation",
    owner_epoch: 1,
    reason: "start" as const,
    previous_activation_id: null,
    ts: 2,
  };
  const results = [
    result("child-a", worktreeA, input.base),
    result("child-b", worktreeB, input.base),
  ];
  const parent = controllerLogicalParentId("run", "controller", definition.definition_digest);
  const args = {
    mode: "nonblocking" as const,
    tasks: results.map((item) => ({
      id: item.taskId,
      subagent: "worker",
      objective: "change one line",
      expected_output: "review and patch",
    })),
  };
  const records: PersistedRecord[] = [
    definition,
    activation,
    {
      type: "delegation_submission_accepted",
      schema_version: 2,
      run_id: "run",
      submission_id: controllerDelegationSubmissionId("run", parent, "prepare"),
      logical_parent_id: parent,
      parent_role: "orchestrator",
      parent_visit_index: 1,
      origin: {
        kind: "controller_action",
        controller_id: "controller",
        definition_digest: definition.definition_digest,
        action_id: "prepare",
        activation_id: "activation",
      },
      accepted_args: args,
      input_fingerprint: sha256Canonical(args),
      children: results.map((item) => ({
        child_id: item.childId,
        task_id: item.taskId,
        subagent: item.subagent,
        model: item.model,
        branch: item.branch,
        worktree_path: item.worktreePath,
        base_commit: item.baseCommit,
        task_fingerprint: fixedDigest,
        profile_fingerprint: fixedDigest,
        context_fingerprint: fixedDigest,
        prompt_fingerprint: fixedDigest,
        projection_fingerprint: { kind: "exact" as const, path_count: 0, sha256: fixedDigest },
      })),
      ts: 3,
    },
  ];
  records.push(...results.map((item) => started(item)));
  const store = await ChildOutputStore.open({ root: join(input.root, "child-outputs") });
  const publication = createChildOutputPublication({
    activation,
    config,
    store,
    records: () => records,
    persist: (record: ChildOutputRecord) => records.push(record),
    inputAudience: async () => null,
    assertOpen: () => undefined,
    wake: () => undefined,
    onFatal: (cause) => {
      throw cause;
    },
  });

  const bCapture = await publication.capture(results[1] as PoolCompletedResult);
  if (bCapture === undefined) throw new Error("B capture missing");
  records.push(terminal(results[1] as PoolCompletedResult, bCapture));
  publication.terminal(results[1] as PoolCompletedResult);
  await publication.settle();
  if (
    records.some(
      (record) =>
        (record.type === "subagent_completed" || record.type === "subagent_failed") &&
        record.child_id === "child-a",
    )
  )
    throw new Error("A settled before B publication");
  const publishedB = published(records, "child-b");
  await input.onBPublished(store, publishedB, records);

  const aCapture = await publication.capture(results[0] as PoolCompletedResult);
  if (aCapture === undefined) throw new Error("A capture missing");
  records.push(terminal(results[0] as PoolCompletedResult, aCapture));
  publication.terminal(results[0] as PoolCompletedResult);
  await publication.settle();
  return {
    store,
    records,
    definition,
    publishedA: published(records, "child-a"),
    publishedB: published(records, "child-b"),
  };
}

function configFixture(): ControllerConfig {
  return {
    protocol_version: 1,
    controller_id: "controller",
    runtime_id: "runtime",
    executable: "/bin/true",
    argv: [],
    adapters: [
      {
        id: "fixed-reviewer",
        runtime_id: "review-runtime",
        executable: "/bin/true",
        argv: [],
        input_schema_id: "review-input-v1",
        output_schema_id: "delivery-review-v1",
        capability: "read_only",
      },
      {
        id: "fixed-validator",
        runtime_id: "validation-runtime",
        executable: "/bin/true",
        argv: [],
        input_schema_id: "selected-source-v1",
        output_schema_id: "delivery-validation-v1",
        capability: "read_only",
      },
      ...["integrate", "promote", "deliver"].map((effectId) => ({
        id: `choose-${effectId}`,
        runtime_id: `${effectId}-runtime`,
        executable: "/bin/true",
        argv: [],
        input_schema_id: `${effectId}-adapter-input-v1`,
        output_schema_id: `${effectId}-request-v1`,
        capability: "private_staging" as const,
        effect_id: effectId,
        output_consumers: [{ kind: "effect" as const, effect_id: effectId }],
      })),
    ],
    child_outputs: [
      {
        profile_id: "worker",
        reports: [
          {
            id: "report",
            path: "reports/review.txt",
            media_type: "text/plain",
            max_bytes: 1024,
            consumers: [
              { kind: "adapter", adapter_id: "fixed-reviewer" },
              { kind: "effect", effect_id: "integrate" },
            ],
          },
        ],
        patch: {
          id: "patch",
          paths: ["value.txt"],
          max_bytes: 524288,
          consumers: [
            { kind: "adapter", adapter_id: "fixed-reviewer" },
            { kind: "effect", effect_id: "integrate" },
            { kind: "adapter", adapter_id: "fixed-validator" },
          ],
        },
      },
    ],
    delegation: { allowed_subagents: ["worker"], max_children_per_session: 2, max_parallel: 2 },
  };
}
function result(childId: string, worktreePath: string, baseCommit: string): PoolCompletedResult {
  return {
    childId: childId as PoolCompletedResult["childId"],
    taskId: `task-${childId}`,
    subagent: "worker",
    model: "synthetic-native",
    status: "completed",
    summary: "done",
    branch: childId,
    worktreePath,
    baseCommit,
    headCommit: baseCommit,
    sessionFile: `${childId}.jsonl`,
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
  };
}
function started(
  value: PoolCompletedResult,
): Extract<PersistedRecord, { type: "subagent_started" }> {
  return {
    type: "subagent_started",
    run_id: "run",
    child_id: value.childId,
    task_id: value.taskId,
    subagent: value.subagent,
    model: value.model,
    branch: value.branch,
    worktree_path: value.worktreePath,
    base_commit: value.baseCommit,
    parent_role: "orchestrator",
    parent_visit_index: 1,
    session_file: value.sessionFile,
    ts: Date.now(),
  };
}
function terminal(
  value: PoolCompletedResult,
  output_capture: NonNullable<
    Extract<PersistedRecord, { type: "subagent_completed" }>["output_capture"]
  >,
): Extract<PersistedRecord, { type: "subagent_completed" }> {
  return {
    type: "subagent_completed",
    run_id: "run",
    child_id: value.childId,
    task_id: value.taskId,
    subagent: value.subagent,
    model: value.model,
    status: "completed",
    summary: value.summary,
    branch: value.branch,
    worktree_path: value.worktreePath,
    base_commit: value.baseCommit,
    head_commit: value.headCommit,
    session_file: value.sessionFile,
    usage: value.usage,
    output_capture,
    ts: Date.now(),
  };
}
function published(records: readonly PersistedRecord[], childId: string) {
  const value = records.find(
    (record) => record.type === "controller_child_output_published" && record.child_id === childId,
  );
  if (value?.type !== "controller_child_output_published")
    throw new Error(`${childId} publication missing`);
  return value;
}
async function git(repository: string, ...args: string[]) {
  return (await execute("git", ["-C", repository, ...args])).stdout.trim();
}
