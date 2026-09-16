import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createChildOutputPublication } from "../../src/host/controller/child-output-publication.js";
import { ChildOutputStore } from "../../src/host/controller/child-output-store.js";
import type { PoolCompletedResult } from "../../src/host/delegation/pool.js";
import type { ControllerConfig } from "../../src/manifest/controller.js";
import type { ChildOutputRecord } from "../../src/persistence/child-output-records.js";
import { controllerDefinitionDigest } from "../../src/persistence/controller-records.js";
import {
  controllerDelegationSubmissionId,
  controllerLogicalParentId,
} from "../../src/persistence/delegation-task.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeRoot)));

describe("Issue #116 child output publication", () => {
  it("publishes A's exact report and patch, for its authorized reviewer only", async () => {
    const f = await fixture();
    await writeFile(join(f.worktree, "reports/result.json"), '{"ok":true}\n');
    await writeFile(join(f.worktree, "src/value.txt"), "changed\n");
    const publication = createChildOutputPublication(f.options());
    const capture = await publication.capture(f.result);
    if (capture === undefined) throw new Error("capture missing");
    f.addTerminal({ ...f.terminal, output_capture: capture });
    publication.terminal(f.result);
    await publication.settle();

    const published = publishedRecord(f.records);
    const report = outputById(published, "report");
    const patch = outputById(published, "patch");
    expect(
      (
        await f.store.read({
          ref: report.ref,
          principal: { kind: "native", profile_id: "reviewer" },
          expectedBinding: report.binding,
        })
      ).bytes.toString(),
    ).toBe('{"ok":true}\n');
    expect(
      (
        await f.store.read({
          ref: patch.ref,
          principal: { kind: "native", profile_id: "reviewer" },
          expectedBinding: patch.binding,
        })
      ).bytes.toString(),
    ).toContain("changed");
    await expect(
      f.store.read({
        ref: report.ref,
        principal: { kind: "controller" },
        expectedBinding: report.binding,
      }),
    ).rejects.toThrow("audience-denied");
    expect(published.terminal.record_digest).toBe(sha256Canonical(f.terminalRecord()));
  });

  it("records a failed settlement when the post-rename store hook faults", async () => {
    const f = await fixture();
    const hookedStore = await ChildOutputStore.open({
      root: f.storeRoot,
      testHook: () => {
        throw new Error("store hook fault");
      },
    });
    const publication = createChildOutputPublication(f.options({ store: hookedStore }));
    const capture = await publication.capture(f.result);
    if (capture === undefined) throw new Error("capture missing");
    f.addTerminal({ ...f.terminal, output_capture: capture });
    publication.terminal(f.result);
    await publication.settle();
    expect(f.records.at(-1)).toMatchObject({
      type: "controller_child_output_failed",
      code: "child-output-publication-unresolved",
    });
  });

  it("recovers immutable report and patch bytes after a process crash between rename and the journal", async () => {
    const f = await fixture();
    await writeFile(join(f.worktree, "reports/result.json"), "sealed report\n");
    await writeFile(join(f.worktree, "src/value.txt"), "sealed patch\n");
    let renameCount = 0;
    const crashingStore = await ChildOutputStore.open({
      root: f.storeRoot,
      testHook: () => {
        renameCount += 1;
        if (renameCount === 2) throw new Error("crash after second rename");
      },
    });
    const publication = createChildOutputPublication(
      f.options({
        store: crashingStore,
        persist(record) {
          if (record.type === "controller_child_output_failed")
            throw new Error("simulated process crash");
          f.records.push(record);
        },
      }),
    );
    const capture = await publication.capture(f.result);
    if (capture === undefined) throw new Error("capture missing");
    f.addTerminal({ ...f.terminal, output_capture: capture });
    publication.terminal(f.result);
    await expect(publication.settle()).rejects.toThrow("simulated process crash");
    expect(f.records.some((record) => record.type === "controller_child_output_failed")).toBe(
      false,
    );

    const previous = f.options().activation;
    const activation = {
      ...previous,
      activation_id: "resumed-activation",
      owner_epoch: 2,
      reason: "resume" as const,
      previous_activation_id: previous.activation_id,
      ts: Date.now(),
    };
    f.records.push(activation);
    // Recovery must use sealed bytes, even when the old worktree now disagrees.
    await writeFile(join(f.worktree, "reports/result.json"), "mutated after crash\n");
    const resumed = createChildOutputPublication({ ...f.options(), activation });
    resumed.recover();
    await resumed.settle();
    const published = publishedRecord(f.records);
    expect(published).toMatchObject({ activation_id: "resumed-activation", owner_epoch: 2 });
    const report = outputById(published, "report");
    const patch = outputById(published, "patch");
    expect(
      (
        await f.store.read({
          ref: report.ref,
          principal: { kind: "native", profile_id: "reviewer" },
          expectedBinding: report.binding,
        })
      ).bytes.toString(),
    ).toBe("sealed report\n");
    expect(
      (
        await f.store.read({
          ref: patch.ref,
          principal: { kind: "native", profile_id: "reviewer" },
          expectedBinding: patch.binding,
        })
      ).bytes.toString(),
    ).toContain("sealed patch");
  });

  it("records an explicit unresolved failure when recovery has an intent but no sealed bytes", async () => {
    const f = await fixture();
    let intentWritten = false;
    const publication = createChildOutputPublication(
      f.options({
        assertOpen() {
          if (intentWritten) throw new Error("crash before publication");
        },
        persist(record) {
          if (record.type === "controller_child_output_started") {
            intentWritten = true;
            f.records.push(record);
            return;
          }
          if (record.type === "controller_child_output_failed")
            throw new Error("simulated process crash");
          f.records.push(record);
        },
      }),
    );
    const capture = await publication.capture(f.result);
    if (capture === undefined) throw new Error("capture missing");
    f.addTerminal({ ...f.terminal, output_capture: capture });
    publication.terminal(f.result);
    await expect(publication.settle()).rejects.toThrow("simulated process crash");
    await writeFile(join(f.worktree, "reports/result.json"), "must not be recaptured\n");

    const resumed = createChildOutputPublication(f.options());
    resumed.recover();
    await resumed.settle();
    expect(f.records.at(-1)).toMatchObject({
      type: "controller_child_output_failed",
      code: "child-output-publication-unresolved",
    });
    expect(f.records.filter((record) => record.type === "subagent_completed")).toHaveLength(1);
    expect(f.records.some((record) => record.type === "controller_child_output_published")).toBe(
      false,
    );
  });

  it("keeps the authoritative terminal usage when trusted capture fails", async () => {
    const f = await fixture();
    const failed = {
      ...f.terminal,
      output_capture_failure: "child-output-capture-failed" as const,
    };
    f.addTerminal(failed);
    const publication = createChildOutputPublication(f.options());
    publication.terminal(f.result);
    await publication.settle();
    expect(failed.usage).toEqual(f.result.usage);
    expect(f.records.at(-1)).toMatchObject({
      type: "controller_child_output_failed",
      code: "child-output-capture-failed",
    });
  });
});

function publishedRecord(records: readonly PersistedRecord[]) {
  const record = records.find((item) => item.type === "controller_child_output_published");
  if (record?.type !== "controller_child_output_published") throw new Error("missing publication");
  return record;
}
function outputById(record: ReturnType<typeof publishedRecord>, id: string) {
  const output = record.outputs.find((item) => item.binding.output.id === id);
  if (output === undefined) throw new Error(`missing ${id} output`);
  return output;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-116-publication-"));
  roots.push(root);
  const worktree = join(root, "worktree");
  const storeRoot = join(root, "outputs");
  await mkdir(join(worktree, "reports"), { recursive: true });
  await mkdir(join(worktree, "src"));
  await writeFile(join(worktree, "reports/result.json"), "old\n");
  await writeFile(join(worktree, "src/value.txt"), "old\n");
  await git(worktree, "init", "-q", "-b", "child-generated");
  await git(worktree, "add", "-A");
  await git(
    worktree,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  await chmod(worktree, 0o700);
  const base = await git(worktree, "rev-parse", "HEAD");
  const digest = "a".repeat(64);
  const policy = {
    profile_id: "worker",
    reports: [
      {
        id: "report",
        path: "reports/result.json",
        media_type: "application/json" as const,
        max_bytes: 1000,
        consumers: [{ kind: "native" as const, profile_id: "reviewer" }],
      },
    ],
    patch: {
      id: "patch",
      paths: ["src/value.txt"],
      max_bytes: 1000,
      consumers: [{ kind: "native" as const, profile_id: "reviewer" }],
    },
  };
  const config = {
    protocol_version: 1 as const,
    controller_id: "controller",
    runtime_id: "runtime",
    executable: "/bin/true",
    argv: [],
    adapters: [],
    child_outputs: [policy],
    delegation: {
      allowed_subagents: ["worker", "reviewer"],
      max_children_per_session: 2,
      max_parallel: 1,
    },
  } satisfies ControllerConfig;
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
  const result: PoolCompletedResult = {
    childId: "child" as PoolCompletedResult["childId"],
    taskId: "task",
    subagent: "worker",
    model: "model",
    status: "completed",
    summary: "done",
    branch: "child-generated",
    worktreePath: worktree,
    baseCommit: base,
    headCommit: base,
    sessionFile: "session",
    usage: { input: 3, output: 4, cache_read: 0, cache_write: 0, tokens: 7, cost: 0.2 },
  };
  const terminal: Extract<PersistedRecord, { type: "subagent_completed" }> = {
    type: "subagent_completed" as const,
    run_id: "run",
    child_id: "child",
    task_id: "task",
    subagent: "worker",
    model: "model",
    status: "completed" as const,
    summary: "done",
    branch: "child-generated",
    worktree_path: worktree,
    base_commit: base,
    head_commit: base,
    session_file: "session",
    usage: result.usage,
    ts: 4,
  };
  const nativeStart = {
    type: "subagent_started" as const,
    run_id: "run",
    child_id: "child",
    task_id: "task",
    subagent: "worker",
    model: "model",
    branch: "child-generated",
    worktree_path: worktree,
    base_commit: base,
    parent_role: "orchestrator" as const,
    parent_visit_index: 1,
    session_file: "session",
    ts: 4,
  };
  const parent = controllerLogicalParentId("run", "controller", definitionDigest);
  const args = {
    mode: "nonblocking" as const,
    tasks: [{ id: "task", subagent: "worker", objective: "report", expected_output: "report" }],
  };
  const child = {
    child_id: "child",
    task_id: "task",
    subagent: "worker",
    model: "model",
    branch: "child-generated",
    worktree_path: worktree,
    base_commit: base,
    task_fingerprint: digest,
    profile_fingerprint: digest,
    context_fingerprint: digest,
    prompt_fingerprint: digest,
    projection_fingerprint: { kind: "exact" as const, path_count: 0, sha256: digest },
  };
  const records: PersistedRecord[] = [
    definition,
    activation,
    {
      type: "delegation_submission_accepted",
      schema_version: 2,
      run_id: "run",
      submission_id: controllerDelegationSubmissionId("run", parent, "action"),
      logical_parent_id: parent,
      parent_role: "orchestrator",
      parent_visit_index: 1,
      origin: {
        kind: "controller_action",
        controller_id: "controller",
        definition_digest: definitionDigest,
        action_id: "action",
        activation_id: "activation",
      },
      accepted_args: args,
      input_fingerprint: sha256Canonical(args),
      children: [child],
      ts: 3,
    },
  ];
  const store = await ChildOutputStore.open({ root: storeRoot });
  const options = (
    overrides: {
      readonly store?: ChildOutputStore;
      readonly persist?: (record: ChildOutputRecord) => void;
      readonly assertOpen?: () => void;
    } = {},
  ) => ({
    activation,
    config,
    store: overrides.store ?? store,
    records: () => records,
    persist: overrides.persist ?? ((record: ChildOutputRecord) => records.push(record)),
    inputAudience: async () => null,
    assertOpen: overrides.assertOpen ?? (() => {}),
    wake: () => {},
    onFatal: () => {},
  });
  return {
    worktree,
    storeRoot,
    store,
    result,
    terminal,
    records,
    options,
    addTerminal: (record: typeof terminal) => records.push({ ...nativeStart }, record),
    terminalRecord: () => {
      const record = records.find((item) => item.type === "subagent_completed");
      if (record?.type !== "subagent_completed") throw new Error("missing terminal");
      return record;
    },
  };
}

async function removeRoot(root: string): Promise<void> {
  await execute("chmod", ["-R", "u+w", root]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
async function git(worktree: string, ...args: string[]): Promise<string> {
  return (await execute("git", ["-C", worktree, ...args])).stdout.trim();
}
