import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { approveControllerDefinition } from "../../src/host/controller/approved-definition.js";
import type { ControllerExecutionDriver } from "../../src/host/controller/executable-host-contract.js";
import { measureGitEffectRepository } from "../../src/host/controller/git-effect.js";
import { validateControllerHostApproval } from "../../src/host/controller/host-approval.js";
import { createProductionSources } from "../../src/host/controller/production-sources.js";
import type { ToolExecutionScope } from "../../src/host/execution/tool-execution-controller.js";
import {
  type ControllerActivationStartedRecord,
  controllerActionRequestDigest,
} from "../../src/persistence/controller-records.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await execute("chmod", ["-R", "u+w", root]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("production source preparation capacity", () => {
  it.each([
    { maxParallel: 1, maxWorkspaces: 2, error: "capacity" },
    { maxParallel: 2, maxWorkspaces: 1, error: "storage" },
  ])("enforces $error before a concurrent prepare can pass admission", async ({
    maxParallel,
    maxWorkspaces,
    error,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "conduct-source-capacity-"));
    roots.push(root);
    const repository = join(root, "repository");
    await mkdir(repository, { mode: 0o700 });
    const git = async (...args: string[]) =>
      (
        await execute("/usr/bin/git", ["-C", repository, ...args], {
          env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" },
        })
      ).stdout;
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "Source Capacity Test");
    await git("config", "user.email", "test@example.invalid");
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src/value.txt"), "source\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const measured = await measureGitEffectRepository(repository);
    const config = {
      protocol_version: 1 as const,
      controller_id: "planner",
      runtime_id: "runtime",
      executable: "/bin/bash",
      argv: [],
      adapters: [],
      source_repositories: ["source"],
      delegation: { allowed_subagents: ["worker"], max_children_per_session: 1, max_parallel: 1 },
    };
    const approval = validateControllerHostApproval({
      schema_version: 1,
      approval_id: "capacity-test",
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
          allowed_refs: ["refs/heads/main"],
          allowed_paths: ["src"],
          audience: [{ kind: "controller" }],
          isolated_git_view: false,
          max_source_bytes: 1024 * 1024,
          max_source_files: 10,
          max_patch_bytes: 1024,
          max_patch_files: 2,
          max_workspaces: maxWorkspaces,
          max_total_bytes: maxWorkspaces * 16 * 1024 * 1024,
          max_parallel_preparations: maxParallel,
          timeout_ms: 30_000,
        },
      ],
    });
    const definition = approveControllerDefinition("source-capacity", config, approval, 1);
    const activation: ControllerActivationStartedRecord = {
      type: "controller_activation_started",
      schema_version: 1,
      run_id: definition.record.run_id,
      controller_id: "planner",
      definition_digest: definition.record.definition_digest,
      activation_id: "capacity-activation",
      owner_epoch: 1,
      previous_activation_id: null,
      reason: "start",
      ts: 2,
    };
    const records: PersistedRecord[] = [definition.record, activation];
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scope: ToolExecutionScope = {
      executionId: "capacity-execution",
      supervisionId: "capacity-supervision",
      signal: new AbortController().signal,
      graceMs: 1000,
      remainingTimeoutMs: () => 30_000,
      assertOpen: () => undefined,
    };
    const executions: ControllerExecutionDriver = {
      async runController(_origin, operation) {
        entered();
        await hold;
        return operation(scope);
      },
      async runControllerLifecycle() {
        throw new Error("lifecycle execution is not used by this test");
      },
    };
    const sources = await createProductionSources({
      definition,
      runStateDir: root,
      records: () => records,
      persist: (record) => records.push(record),
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
    const action = (actionId: string) => ({
      kind: "prepare_source" as const,
      action_id: actionId,
      source_id: "source",
      repository_ref: "refs/heads/main",
    });
    const firstAction = action("first");
    const first = dispatcher.prepare(
      firstAction,
      controllerActionRequestDigest(definition.record.definition_digest, firstAction),
    );
    await enteredPromise;
    const secondAction = action("second");
    await expect(
      dispatcher.prepare(
        secondAction,
        controllerActionRequestDigest(definition.record.definition_digest, secondAction),
      ),
    ).rejects.toThrow(error);
    release();
    await expect(first).resolves.toMatchObject({ outcome: "completed" });
  });
});
