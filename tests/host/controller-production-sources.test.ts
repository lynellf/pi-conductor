import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { approveControllerDefinition } from "../../src/host/controller/approved-definition.js";
import { measureGitEffectRepository } from "../../src/host/controller/git-effect.js";
import { validateControllerHostApproval } from "../../src/host/controller/host-approval.js";
import { createProductionSources } from "../../src/host/controller/production-sources.js";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import { resolveToolExecutionPolicy } from "../../src/manifest/execution-policy.js";
import {
  type ControllerActivationStartedRecord,
  controllerActionRequestDigest,
} from "../../src/persistence/controller-records.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await execute("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});

describe("production source workspaces", () => {
  it("recovers only verified publication and never replays interrupted preparation", async () => {
    const f = await fixture();
    const ref = await f.prepare("recover");
    const action = {
      kind: "prepare_source" as const,
      action_id: "recover",
      source_id: "source",
      repository_ref: "refs/heads/delivered",
    };
    const definition = f.records.find((record) => record.type === "controller_definition_pinned");
    if (definition?.type !== "controller_definition_pinned") throw new Error("missing definition");
    const state = {
      actionId: "recover",
      intentActivationId: "source-activation",
      originalRevision: 1,
      intent: {
        action_id: action.action_id,
        kind: action.kind,
        request: action,
        request_sha256: controllerActionRequestDigest(definition.definition_digest, action),
      },
      latestReceipt: null,
      receipts: [],
      repair: null,
    };
    expect(await f.sources.recoverSourceAction(state)).toMatchObject({
      blocked: [],
      receipts: [{ outcome: "completed", resultRefs: [ref] }],
    });
    const index = f.records.findIndex((record) => record.type === "source_workspace_prepared");
    const prepared = f.records[index];
    if (prepared?.type !== "source_workspace_prepared") throw new Error("missing publication");
    f.records[index] = {
      ...prepared,
      content: { ...prepared.content, byte_length: prepared.content.byte_length + 1 },
    };
    expect(await f.sources.recoverSourceAction(state)).toMatchObject({
      receipts: [],
      blocked: [expect.stringContaining("unverifiable")],
    });
    f.records.splice(index, 1);
    await expect(f.sources.openSourceWorkspace(ref, { kind: "controller" })).rejects.toThrow(
      "no matching durable publication",
    );
    const before = f.records.length;
    expect(await f.sources.recoverSourceAction(state)).toMatchObject({
      receipts: [],
      blocked: [expect.stringContaining("inspection")],
    });
    expect(f.records).toHaveLength(before);
    const startedIndex = f.records.findIndex(
      (record) => record.type === "source_workspace_started",
    );
    f.records.splice(startedIndex, 1);
    expect(await f.sources.recoverSourceAction(state)).toMatchObject({
      blocked: [],
      receipts: [{ outcome: "interrupted", diagnostic: expect.stringContaining("never started") }],
    });
    const intentIndex = f.records.findIndex((record) => record.type === "source_workspace_intent");
    f.records.splice(intentIndex, 1);
    expect(await f.sources.recoverSourceAction(state)).toMatchObject({
      blocked: [],
      receipts: [
        { outcome: "interrupted", diagnostic: expect.stringContaining("not durably pinned") },
      ],
    });
    expect(f.records).toHaveLength(before - 2);
  });

  it("keeps admitted A pinned after delivery moves to B and explicitly prepares B", async () => {
    const f = await fixture();
    const a = await f.prepare("first");
    const first = await f.sources.openSourceWorkspace(a, { kind: "controller" });
    await writeFile(join(f.repository, "src/value.txt"), "B\n");
    await f.git("add", ".");
    await f.git("commit", "-qm", "B");
    const bHead = (await f.git("rev-parse", "HEAD")).trim();
    const reopened = await f.sources.openSourceWorkspace(a, { kind: "controller" });
    expect(await readFile(join(reopened.sourcePath, "src/value.txt"), "utf8")).toBe("A\n");
    const b = await f.prepare("second");
    const second = await f.sources.openSourceWorkspace(b, { kind: "controller" });
    expect(second.baseCommit).toBe(bHead);
    expect(second.ref).not.toBe(first.ref);
    expect(second.headCommit).not.toBe(first.headCommit);
    expect(first.byteLength).toBeGreaterThan(1024 * 1024);
    expect((await f.git("status", "--porcelain")).trim()).toBe("");
    expect(JSON.stringify(f.records)).not.toContain("data".repeat(100));
  });

  it("rejects unapproved consumers, replay, and an exhausted storage reservation", async () => {
    const f = await fixture(1);
    const ref = await f.prepare("first");
    await expect(
      f.sources.openSourceWorkspace(ref, { kind: "native", profile_id: "worker" }),
    ).rejects.toThrow();
    await expect(f.prepare("first")).rejects.toThrow();
    const perWorkspace = 8 * 2_097_152 + 100 * 512 * 1024;
    const required = 2 * perWorkspace;
    const approved = 70_000_000;
    await expect(f.prepare("second")).rejects.toThrow(
      `source workspace storage reservation exceeds approved limits: required ${required} bytes, approved ${approved} bytes`,
    );
    expect(f.records.filter((record) => record.type === "source_workspace_intent")).toHaveLength(1);
  });

  it("accepts the 3.515625 GiB aggregate reservation through the production dispatcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduct-production-source-aggregate-"));
    roots.push(root);
    const repository = join(root, "repo");
    await mkdir(repository, { mode: 0o700 });
    const git = async (...args: string[]) =>
      (
        await execute("/usr/bin/git", ["-C", repository, ...args], {
          env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" },
        })
      ).stdout;
    await git("init", "-q", "-b", "delivered");
    await git("config", "user.name", "Source Test");
    await git("config", "user.email", "test@example.invalid");
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src/value.txt"), "A\n");
    await git("add", ".");
    await git("commit", "-qm", "A");
    const measured = await measureGitEffectRepository(repository);
    const maxWorkspaces = 4;
    const config = {
      protocol_version: 1 as const,
      controller_id: "planner",
      runtime_id: "runtime",
      executable: "/bin/bash",
      argv: [],
      adapters: [],
      source_repositories: ["source"],
      delegation: { allowed_subagents: ["worker"], max_children_per_session: 2, max_parallel: 1 },
    };
    const approval = validateControllerHostApproval({
      schema_version: 1,
      approval_id: "source-aggregate",
      controllers: [
        { controller_id: "planner", runtime_id: "runtime", executable: "/bin/bash", argv: [] },
      ],
      runtimes: [
        {
          runtime_id: "runtime",
          source_root: "/operator/runtime",
          inventory_sha256: "a".repeat(64),
          bootstrap_approval: {
            approvalId: "runtime",
            files: [{ path: "bin/bash", sha256: "b".repeat(64) }],
          },
        },
      ],
      adapters: [],
      schemas: [],
      source_repositories: [
        {
          schema_version: 1,
          id: "source",
          repository: { id: "repo", canonical_path: repository, fingerprint: measured.fingerprint },
          allowed_refs: ["refs/heads/delivered"],
          allowed_paths: ["src"],
          audience: [{ kind: "controller" }],
          isolated_git_view: true,
          max_source_bytes: 64 * 1024 * 1024,
          max_source_files: 776,
          max_patch_bytes: 1024,
          max_patch_files: 4,
          max_workspaces: maxWorkspaces,
          max_total_bytes: 3_600 * 1024 * 1024,
          max_parallel_preparations: 4,
          timeout_ms: 30_000,
        },
      ],
    });
    const definition = approveControllerDefinition("source-run-aggregate", config, approval, 1);
    const activation: ControllerActivationStartedRecord = {
      type: "controller_activation_started",
      schema_version: 1,
      run_id: definition.record.run_id,
      controller_id: "planner",
      definition_digest: definition.record.definition_digest,
      activation_id: "source-aggregate-activation",
      owner_epoch: 1,
      previous_activation_id: null,
      reason: "start",
      ts: 2,
    };
    const records: PersistedRecord[] = [definition.record, activation];
    const executions = new ToolExecutionController({
      runId: "source-run-aggregate",
      logicalSessionId: "source-aggregate-test",
      roleSessionId: "source-aggregate-test",
      policy: resolveToolExecutionPolicy(undefined),
      persist: (record) => {
        records.push(record);
      },
    });
    const sources = await createProductionSources({
      definition,
      runStateDir: root,
      records: () => records,
      persist: (record) => {
        records.push(record);
      },
      loadApproval: async () => approval,
      assertOpen: () => undefined,
      outputResolver: {
        resolveRef: async () => {
          throw new Error("no patch requested");
        },
        getInputAudience: async () => null,
      },
    });
    const dispatcher = sources.dispatcher(activation, executions);
    const outcome = await dispatcher.prepare(
      {
        kind: "prepare_source" as const,
        action_id: "aggregate",
        source_id: "source",
        repository_ref: "refs/heads/delivered",
      },
      controllerActionRequestDigest(definition.record.definition_digest, {
        kind: "prepare_source",
        action_id: "aggregate",
        source_id: "source",
        repository_ref: "refs/heads/delivered",
      }),
    );
    expect(outcome.outcome).toBe("completed");
    expect(outcome.result_refs[0]).toMatch(/^source-workspace\/v1\//);
  });
});

async function fixture(maxWorkspaces = 4) {
  const root = await mkdtemp(join(tmpdir(), "conduct-production-source-"));
  roots.push(root);
  const repository = join(root, "repo");
  await mkdir(repository, { mode: 0o700 });
  const git = async (...args: string[]) =>
    (
      await execute("/usr/bin/git", ["-C", repository, ...args], {
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" },
      })
    ).stdout;
  await git("init", "-q", "-b", "delivered");
  await git("config", "user.name", "Source Test");
  await git("config", "user.email", "test@example.invalid");
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src/value.txt"), "A\n");
  await writeFile(join(repository, "src/data.bin"), "data".repeat(300_000));
  await git("add", ".");
  await git("commit", "-qm", "A");
  await chmod(join(repository, ".git/index"), 0o600);
  const measured = await measureGitEffectRepository(repository);
  const config = {
    protocol_version: 1 as const,
    controller_id: "planner",
    runtime_id: "runtime",
    executable: "/bin/bash",
    argv: [],
    adapters: [],
    source_repositories: ["source"],
    delegation: { allowed_subagents: ["worker"], max_children_per_session: 2, max_parallel: 1 },
  };
  const approval = validateControllerHostApproval({
    schema_version: 1,
    approval_id: "source-test",
    controllers: [
      { controller_id: "planner", runtime_id: "runtime", executable: "/bin/bash", argv: [] },
    ],
    runtimes: [
      {
        runtime_id: "runtime",
        source_root: "/operator/runtime",
        inventory_sha256: "a".repeat(64),
        bootstrap_approval: {
          approvalId: "runtime",
          files: [{ path: "bin/bash", sha256: "b".repeat(64) }],
        },
      },
    ],
    adapters: [],
    schemas: [],
    source_repositories: [
      {
        schema_version: 1,
        id: "source",
        repository: { id: "repo", canonical_path: repository, fingerprint: measured.fingerprint },
        allowed_refs: ["refs/heads/delivered"],
        allowed_paths: ["src"],
        audience: [{ kind: "controller" }],
        isolated_git_view: true,
        max_source_bytes: 2_097_152,
        max_source_files: 100,
        max_patch_bytes: 524288,
        max_patch_files: 8,
        max_workspaces: maxWorkspaces,
        max_total_bytes: maxWorkspaces * 70_000_000,
        max_parallel_preparations: 2,
        timeout_ms: 30_000,
      },
    ],
  });
  const definition = approveControllerDefinition("source-run", config, approval, 1);
  const activation: ControllerActivationStartedRecord = {
    type: "controller_activation_started",
    schema_version: 1,
    run_id: definition.record.run_id,
    controller_id: "planner",
    definition_digest: definition.record.definition_digest,
    activation_id: "source-activation",
    owner_epoch: 1,
    previous_activation_id: null,
    reason: "start",
    ts: 2,
  };
  const records: PersistedRecord[] = [definition.record, activation];
  const executions = new ToolExecutionController({
    runId: "source-run",
    logicalSessionId: "source-test",
    roleSessionId: "source-test",
    policy: resolveToolExecutionPolicy(undefined),
    persist: (record) => {
      records.push(record);
    },
  });
  const sources = await createProductionSources({
    definition,
    runStateDir: root,
    records: () => records,
    persist: (record) => {
      records.push(record);
    },
    loadApproval: async () => approval,
    assertOpen: () => undefined,
    outputResolver: {
      resolveRef: async () => {
        throw new Error("no patch requested");
      },
      getInputAudience: async () => null,
    },
  });
  const dispatcher = sources.dispatcher(activation, executions);
  const prepare = async (actionId: string) => {
    const action = {
      kind: "prepare_source" as const,
      action_id: actionId,
      source_id: "source",
      repository_ref: "refs/heads/delivered",
    };
    const outcome = await dispatcher.prepare(
      action,
      controllerActionRequestDigest(definition.record.definition_digest, action),
    );
    const ref = outcome.result_refs[0];
    if (ref === undefined) throw new Error("missing prepared reference");
    return ref;
  };
  return { root, repository, git, sources, records, prepare };
}
