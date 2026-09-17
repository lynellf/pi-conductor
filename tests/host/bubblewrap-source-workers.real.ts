/** Controller-native children consume one exact source identity through real Bubblewrap (#118). */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StreamFunction } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { measureGitEffectRepository } from "../../src/host/controller/git-effect.js";
import {
  createSourceWorkspaceService,
  type SourceWorkspaceGrant,
  SourceWorkspaceStore,
} from "../../src/host/controller/source-workspace.js";
import { createDelegationAdmissionService } from "../../src/host/delegation/admission-service.js";
import {
  createControllerDelegateScheduler,
  type NativeDelegationSchedulerFactoryOptions,
} from "../../src/host/delegation/factory-scheduler.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import type { SubagentProfile } from "../../src/manifest/types.js";
import { controllerLogicalParentId } from "../../src/persistence/delegation-task.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import {
  createRealDelegationFixture,
  type RealDelegationFixture,
} from "./fixtures/bubblewrap-delegation-fixture.js";

const execute = promisify(execFile);
const fixtures: RealDelegationFixture[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

describe("controller-native source workers with real Bubblewrap", () => {
  it("gives independent reviewers the exact prepared source without mutating primary Git", async () => {
    const fixture = await createRealDelegationFixture();
    fixtures.push(fixture);
    const records: PersistedRecord[] = [];
    const source = await preparePatchedSource(fixture, records);
    const primaryHead = await gitText(fixture.checkout, "rev-parse", "HEAD");
    const sourceHead = await gitText(source.repository, "rev-parse", "HEAD");
    const profiles = [reviewer("alpha"), reviewer("beta")];
    const manager = new DelegationManager();
    const definitionDigest = "d".repeat(64);
    const logicalParentId = controllerLogicalParentId(
      "real-delegate",
      "source-reviewer",
      definitionDigest,
    );
    const options = {
      subagents: profiles,
      remainingChildren: 2,
      runId: "real-delegate",
      parentRole: "orchestrator",
      parentVisitIndex: 1,
      primaryCheckout: fixture.checkout,
      runStateDir: fixture.runStateDir,
      persistRecord: (record) => records.push(record),
      agentDir: fixture.agentDir,
      systemPromptRoot: fixture.promptRoot,
      modelRegistry: routedRegistry(
        new Map([
          ["alpha", reviewerStream("alpha")],
          ["beta", reviewerStream("beta")],
        ]),
      ),
      sessionDir: fixture.sessionDir,
      manager,
      sandboxAdmission: fixture.sandboxAdmission,
      sandboxHostApproval: fixture.hostApproval,
      records: () => records,
      delegationPolicy: {
        allowed_subagents: profiles.map((profile) => profile.name),
        max_children_per_session: 2,
        max_parallel: 2,
        mode: "nonblocking",
      },
      resolveDelegatedSource: async (ref: string, profileId: string) => ({
        ...(await source.service.open(ref, source.grant, {
          kind: "native",
          profile_id: profileId,
        })),
        sourceId: source.grant.sourceId,
        allowGitView: false,
      }),
    } satisfies NativeDelegationSchedulerFactoryOptions;
    const scheduler = createControllerDelegateScheduler(options, logicalParentId, {
      kind: "controller",
      controllerId: "source-reviewer",
      definitionDigest,
    });
    const admission = createDelegationAdmissionService(scheduler);

    try {
      const childIds = await admission.submit(
        {
          kind: "controller_action",
          actionId: "review-prepared-source",
          activationId: "activation",
        },
        {
          mode: "nonblocking",
          tasks: profiles.map((profile) => ({
            id: `task-${profile.name}`,
            subagent: profile.name,
            objective: "review the prepared source",
            expected_output: "record an independent review",
            projection_paths: ["review.txt"],
          })),
        },
        source.preparedRef,
      );
      const results = await Promise.all(childIds.map((childId) => admission.wait(childId)));
      if (results.some((result) => result.status === "failed"))
        throw new Error(
          JSON.stringify(
            {
              results,
              records: records.filter(
                (record) =>
                  record.type === "subagent_started" ||
                  record.type === "subagent_failed" ||
                  record.type === "tool_execution_finished",
              ),
            },
            null,
            2,
          ),
        );

      expect(
        results.map((result) => ({
          status: result.status,
          summary: result.summary,
          failureReason: "failureReason" in result ? result.failureReason : null,
        })),
      ).toEqual([
        { status: "completed", summary: "reviewed alpha", failureReason: null },
        { status: "completed", summary: "reviewed beta", failureReason: null },
      ]);
      const accepted = records.find((record) => record.type === "delegation_submission_accepted");
      expect(accepted?.schema_version).toBe(3);
      expect(admission.acceptedSubmission("review-prepared-source")).toBe(accepted);
      expect(
        accepted?.type === "delegation_submission_accepted"
          ? accepted.children.map((child) => child.source_workspace?.ref)
          : [],
      ).toEqual([source.preparedRef, source.preparedRef]);
      const completed = records.filter((record) => record.type === "subagent_completed");
      expect(completed).toHaveLength(2);
      for (const record of completed) {
        const suffix = record.subagent.replace("reviewer-", "");
        expect(await readFile(join(record.worktree_path, "review.txt"), "utf8")).toBe(
          `reviewed by ${suffix}\n`,
        );
      }

      const started = records.filter((record) => record.type === "subagent_started");
      expect(started.map((record) => record.source_workspace?.ref)).toEqual([
        source.preparedRef,
        source.preparedRef,
      ]);
      const commandTerminals = records
        .filter((record) => record.type === "tool_execution_finished")
        .filter((record) => record.tool_name === "bash");
      expect(commandTerminals.map((record) => record.sandbox?.normalized_status)).toEqual([0, 0]);

      const childGitDirs = await Promise.all(
        completed.map(async (record) =>
          realpath(
            join(
              record.worktree_path,
              await gitText(record.worktree_path, "rev-parse", "--git-common-dir"),
            ),
          ),
        ),
      );
      expect(new Set(childGitDirs).size).toBe(2);
      expect(childGitDirs).not.toContain(
        await realpath(
          join(
            source.preparedCheckout,
            await gitText(source.preparedCheckout, "rev-parse", "--git-common-dir"),
          ),
        ),
      );
      expect(await readFile(join(source.preparedCheckout, "review.txt"), "utf8")).toBe(
        "prepared source\n",
      );
      expect(await gitText(fixture.checkout, "rev-parse", "HEAD")).toBe(primaryHead);
      expect(await gitText(fixture.checkout, "status", "--porcelain")).toBe("");
      expect(await gitText(source.repository, "rev-parse", "HEAD")).toBe(sourceHead);
      expect(await gitText(source.repository, "status", "--porcelain")).toBe("");
    } finally {
      try {
        await scheduler.close();
      } finally {
        await manager.abortAll();
      }
    }
  }, 90_000);
});

async function preparePatchedSource(fixture: RealDelegationFixture, records: PersistedRecord[]) {
  const repository = join(fixture.root, "review-source");
  await mkdir(repository, { mode: 0o700 });
  await git(repository, "init", "-q", "-b", "main");
  await writeFile(join(repository, "review.txt"), "base source\n");
  await git(repository, "add", "review.txt");
  await git(
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  await chmod(join(repository, ".git/index"), 0o600);
  const base = await gitText(repository, "rev-parse", "HEAD");
  await writeFile(join(repository, "review.txt"), "prepared source\n");
  const patch = Buffer.from(
    await gitOutput(repository, "diff", "--binary", "HEAD", "--", "review.txt"),
  );
  await git(repository, "checkout", "--", "review.txt");
  const patchDigest = createHash("sha256").update(patch).digest("hex");
  const measured = await measureGitEffectRepository(repository);
  const grant: SourceWorkspaceGrant = {
    sourceId: "review-source",
    authorityDigest: "a".repeat(64),
    canonicalPath: repository,
    repositoryFingerprint: measured.fingerprint,
    allowedRefs: ["refs/heads/main"],
    allowedPaths: ["review.txt"],
    maxFiles: 4,
    maxBytes: 4096,
    consumers: [
      { kind: "controller" },
      { kind: "native", profile_id: "reviewer-alpha" },
      { kind: "native", profile_id: "reviewer-beta" },
    ],
    allowGitView: false,
  };
  const service = createSourceWorkspaceService(
    await SourceWorkspaceStore.open({ root: join(fixture.runStateDir, "source-workspaces") }),
  );
  const resolvePatch = async () => ({
    bytes: patch,
    sha256: patchDigest,
    byteLength: patch.length,
    acceptedBase: base,
    allowedPaths: ["review.txt"],
    audience: grant.consumers,
  });
  const intent = await service.resolveIntent(
    {
      runId: "real-delegate",
      controllerId: "source-reviewer",
      definitionDigest: "d".repeat(64),
      activationId: "activation",
      ownerEpoch: 1,
      actionId: "prepare-review-source",
      requestDigest: sha256Canonical({ action: "prepare-review-source" }),
      sourceId: grant.sourceId,
      repositoryRef: "refs/heads/main",
      patches: [
        {
          ref: "fixture:review-patch",
          sha256: patchDigest,
          byteLength: patch.length,
          acceptedBase: base,
        },
      ],
    },
    grant,
    resolvePatch,
  );
  records.push(intent);
  const prepared = await service.prepare(intent, grant, {
    resolvePatch,
    persist: async (record) => {
      records.push(record);
    },
    assertOpen: () => undefined,
  });
  expect(await readFile(join(prepared.checkoutPath, "review.txt"), "utf8")).toBe(
    "prepared source\n",
  );
  return {
    repository,
    grant,
    service,
    preparedRef: prepared.ref,
    preparedCheckout: prepared.checkoutPath,
  };
}

function reviewer(name: "alpha" | "beta"): SubagentProfile {
  return {
    name: `reviewer-${name}`,
    models: [{ model: `stub:${name}`, effort: "medium" }],
    max_session_cost_usd: 1,
    system_prompt: "worker.md",
    completion_protocol: "minimal",
    execution: {
      backend: "bubblewrap",
      runtime_root: ".pi/runtime",
      writable_paths: ["review.txt"],
    },
    workspace: { projection: { required: true, allowed_paths: ["review.txt"] } },
    tool_execution: { timeout_seconds: 5, termination_grace_seconds: 1 },
  };
}

function reviewerStream(name: "alpha" | "beta"): StreamFunction {
  return makeStubStreamFunction({
    steps: [
      {
        kind: "emit_tool_calls",
        calls: [
          {
            name: "bash",
            arguments: { command: "[[ $(<review.txt) == 'prepared source' ]]" },
          },
        ],
      },
      {
        kind: "emit_tool_calls",
        calls: [
          {
            name: "write",
            arguments: { path: "review.txt", content: `reviewed by ${name}\n` },
          },
        ],
      },
      { kind: "emit_text", text: `reviewed ${name}` },
    ],
  });
}

function routedRegistry(streams: ReadonlyMap<string, StreamFunction>): ModelRegistry {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const base = makeStubModel();
  registry.registerProvider("stub", {
    api: "anthropic-messages",
    apiKey: "unused",
    baseUrl: base.baseUrl,
    streamSimple: ((model, context, options) => {
      const stream = streams.get(model.id);
      if (stream === undefined) throw new Error(`missing stream ${model.id}`);
      return stream(model, context, options);
    }) as StreamFunction,
    models: [...streams.keys()].map((id) => ({ ...base, id, name: id })),
  });
  return registry;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execute("/usr/bin/git", args, { cwd, env: gitEnvironment() });
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  return (await gitOutput(cwd, ...args)).trim();
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("/usr/bin/git", args, { cwd, env: gitEnvironment() })).stdout;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" };
}
