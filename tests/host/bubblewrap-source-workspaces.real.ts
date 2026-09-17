/** Actual fixed validators consume unapproved immutable source without host credentials (#118). */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { approveControllerDefinition } from "../../src/host/controller/approved-definition.js";
import { ArtifactStore } from "../../src/host/controller/artifact-store.js";
import { createExecutableControllerHost } from "../../src/host/controller/executable-host.js";
import { measureGitEffectRepository } from "../../src/host/controller/git-effect.js";
import { validateControllerHostApproval } from "../../src/host/controller/host-approval.js";
import {
  createSourceWorkspaceService,
  type SourceWorkspaceGrant,
  SourceWorkspaceStore,
} from "../../src/host/controller/source-workspace.js";
import { inventoryRuntimeTree } from "../../src/host/execution/sandbox/runtime-files.js";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import { resolveToolExecutionPolicy } from "../../src/manifest/execution-policy.js";
import { controllerActionRequestDigest } from "../../src/persistence/controller-records.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { preparedRuntimeInventoryDigest } from "../../src/persistence/sandbox-runtime.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import { createRealDelegationFixture } from "./fixtures/bubblewrap-delegation-fixture.js";

const execute = promisify(execFile);

describe("source workspaces with real Bubblewrap", () => {
  it("validates large unapproved source, records real failure, and tests a repaired identity with the same runtime", async () => {
    const f = await createRealDelegationFixture();
    try {
      const repository = join(f.root, "proposed-project");
      await mkdir(repository, { mode: 0o700 });
      const git = async (...args: string[]) =>
        (
          await execute("/usr/bin/git", ["-C", repository, ...args], {
            env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" },
          })
        ).stdout;
      await git("init", "-q", "-b", "main");
      await git("config", "user.name", "Test");
      await git("config", "user.email", "test@example.invalid");
      await mkdir(join(repository, "src"));
      await writeFile(join(repository, "src/test.sh"), "exit 0\n");
      await writeFile(join(repository, "src/data.txt"), `${"x".repeat(1_100_000)}\n`);
      await git("add", ".");
      await git("commit", "-qm", "base");
      await chmod(join(repository, ".git/index"), 0o600);
      const base = (await git("rev-parse", "HEAD")).trim();
      const measured = await measureGitEffectRepository(repository);
      const grant: SourceWorkspaceGrant = {
        sourceId: "source",
        authorityDigest: "c".repeat(64),
        canonicalPath: repository,
        repositoryFingerprint: measured.fingerprint,
        allowedRefs: ["refs/heads/main"],
        allowedPaths: ["src"],
        maxFiles: 20,
        maxBytes: 2_000_000,
        consumers: [{ kind: "controller" }, { kind: "adapter", adapter_id: "validate" }],
        allowGitView: false,
      };
      const sources = createSourceWorkspaceService(
        await SourceWorkspaceStore.open({ root: join(f.runStateDir, "sources") }),
      );
      const records: PersistedRecord[] = [];
      const prepare = async (id: string, exit: number) => {
        const body =
          exit === 23
            ? "printf '%8192s' x > /scratch/overflow || exit 23\nexit 99"
            : `exit ${exit}`;
        await writeFile(
          join(repository, "src/test.sh"),
          `# ${"unapproved ".repeat(4000)}\n${body}\n`,
        );
        const bytes = Buffer.from(await git("diff", "--binary", "HEAD", "--", "src/test.sh"));
        await git("checkout", "--", "src/test.sh");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const resolvePatch = async () => ({
          bytes,
          sha256,
          byteLength: bytes.length,
          acceptedBase: base,
          allowedPaths: ["src/test.sh"],
          audience: grant.consumers,
        });
        const intent = await sources.resolveIntent(
          {
            runId: "source-real",
            controllerId: "planner",
            definitionDigest: "d".repeat(64),
            activationId: "activation",
            ownerEpoch: 1,
            actionId: id,
            requestDigest: sha256Canonical({ id }),
            sourceId: "source",
            repositoryRef: "refs/heads/main",
            patches: [
              { ref: `fixture:${id}`, sha256, byteLength: bytes.length, acceptedBase: base },
            ],
          },
          grant,
          resolvePatch,
        );
        records.push(intent);
        const source = await sources.prepare(intent, grant, {
          resolvePatch,
          persist: async (record) => {
            records.push(record);
          },
          assertOpen: () => undefined,
        });
        expect(bytes.length).toBeGreaterThan(32768);
        return source;
      };
      const broken = await prepare("broken", 7);
      const repaired = await prepare("repaired", 0);
      const overflowing = await prepare("overflowing", 23);
      const runtime = join(f.checkout, ".pi/runtime");
      const script = join(runtime, "opt/source-validator.sh");
      await writeFile(
        script,
        [
          "#!/bin/bash",
          "set -eu",
          "[[ ! -e /workspace/.git && ! -e /source-git ]]",
          "IFS= read -r payload < /workspace/src/data.txt",
          `[[ ${"$"}{#payload} -gt 1048576 ]]`,
          "printf scratch > /scratch/build.txt",
          "/bin/bash /workspace/src/test.sh",
          "printf '{\"ok\":true}'",
        ].join("\n"),
        { mode: 0o500 },
      );
      const inventory = await inventoryRuntimeTree(runtime);
      const inputSchema = Type.Object(
        {
          protocol_version: Type.Literal(1),
          run_id: Type.String(),
          controller_id: Type.String(),
          definition_digest: Type.String(),
          action_id: Type.String(),
          input_refs: Type.Array(Type.Object({ ref: Type.String(), value: Type.Unknown() })),
        },
        { additionalProperties: false },
      );
      const outputSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
      const adapter = {
        id: "validate",
        runtime_id: "runtime",
        executable: "/bin/bash",
        argv: ["/opt/source-validator.sh"],
        capability: "read_only" as const,
        input_schema_id: "input",
        output_schema_id: "result",
        source_policy: {
          source_ids: ["source"],
          max_scratch_bytes: 4096,
          max_file_input_bytes: 524288,
          max_file_input_files: 1,
          timeout_ms: 30_000,
        },
      };
      const config = {
        protocol_version: 1 as const,
        controller_id: "planner",
        runtime_id: "runtime",
        executable: "/bin/bash",
        argv: [],
        adapters: [adapter],
        source_repositories: ["source"],
        delegation: { allowed_subagents: ["worker"], max_children_per_session: 1, max_parallel: 1 },
      };
      const approval = validateControllerHostApproval({
        schema_version: 1,
        approval_id: "source-real",
        controllers: [
          { controller_id: "planner", runtime_id: "runtime", executable: "/bin/bash", argv: [] },
        ],
        runtimes: [
          {
            runtime_id: "runtime",
            source_root: runtime,
            inventory_sha256: preparedRuntimeInventoryDigest(inventory),
            bootstrap_approval: {
              approvalId: "source-runtime",
              files: inventory.flatMap((entry) =>
                entry.type === "file" ? [{ path: entry.path, sha256: entry.sha256 }] : [],
              ),
            },
          },
        ],
        adapters: [adapter],
        schemas: [
          { schema_id: "input", schema_digest: sha256Canonical(inputSchema), schema: inputSchema },
          {
            schema_id: "result",
            schema_digest: sha256Canonical(outputSchema),
            schema: outputSchema,
          },
        ],
        source_repositories: [
          {
            schema_version: 1,
            id: "source",
            repository: {
              id: "repo",
              canonical_path: repository,
              fingerprint: measured.fingerprint,
            },
            allowed_refs: grant.allowedRefs,
            allowed_paths: grant.allowedPaths,
            audience: grant.consumers,
            isolated_git_view: false,
            max_source_bytes: grant.maxBytes,
            max_source_files: grant.maxFiles,
            max_patch_bytes: 524288,
            max_patch_files: 4,
            max_workspaces: 4,
            max_total_bytes: 134_217_728,
            max_parallel_preparations: 2,
            timeout_ms: 30_000,
          },
        ],
      });
      const definition = approveControllerDefinition("source-real", config, approval, 1);
      await mkdir(join(f.runStateDir, "artifacts"), { mode: 0o700 });
      const artifacts = await ArtifactStore.open({ root: join(f.runStateDir, "artifacts") });
      const controller = new ToolExecutionController({
        runId: "source-real",
        logicalSessionId: "controller",
        roleSessionId: "controller",
        policy: resolveToolExecutionPolicy(undefined),
        persist: (record) => {
          records.push(record);
        },
      });
      const host = createExecutableControllerHost({
        approvedDefinition: definition,
        getCurrentApproval: async () => approval,
        runStateDir: f.runStateDir,
        protection: {
          primaryCheckout: f.checkout,
          stateRoots: [f.runStateDir],
          childWorkspaceRoots: [],
        },
        sandboxHostApproval: f.hostApproval,
        activationId: "activation",
        ownerEpoch: 1,
        toolExecutionController: controller,
        assertOpen: () => undefined,
        artifactStore: artifacts,
        resolveRef: async () => {
          throw new Error("no inline artifacts");
        },
        openSourceWorkspace: async (ref, principal) => ({
          ...(await sources.open(ref, grant, principal)),
          sourceId: "source",
          allowGitView: false,
        }),
      });
      for (const [source, expected] of [
        [broken, 7],
        [repaired, 0],
        [overflowing, 23],
      ] as const) {
        const action = {
          kind: "adapter" as const,
          action_id: `validate-${expected}`,
          adapter_id: "validate",
          input_refs: [],
          source_workspace_ref: source.ref,
        };
        const result = await host.invokeAdapter(
          action,
          controllerActionRequestDigest(definition.record.definition_digest, action),
        );
        const output = await artifacts.rangeReadForController({
          ref: result.artifact.ref,
          runId: "source-real",
          definitionDigest: definition.record.definition_digest,
          offset: 0,
          length: 32768,
        });
        expect(JSON.parse(output.bytes.toString())).toMatchObject({
          source: {
            ref: source.ref,
            base_commit: source.baseCommit,
            head_commit: source.headCommit,
            policy_digest: source.policyDigest,
          },
          execution: { normalized_status: expected, capture: "complete", cleanup: "confirmed" },
          result: expected === 0 ? { ok: true } : null,
        });
      }
      expect(broken.ref).not.toBe(repaired.ref);
      expect(
        records
          .filter(
            (
              record,
            ): record is Extract<
              (typeof records)[number],
              { readonly type: "tool_execution_started" }
            > =>
              record.type === "tool_execution_started" &&
              record.schema_version === 2 &&
              record.origin.operation_kind === "adapter",
          )
          .map((record) => record.timeout_ms),
      ).toEqual([
        adapter.source_policy.timeout_ms,
        adapter.source_policy.timeout_ms,
        adapter.source_policy.timeout_ms,
      ]);
      expect(await readFile(join(repository, "src/test.sh"), "utf8")).toBe("exit 0\n");
      expect((await git("rev-parse", "HEAD")).trim()).toBe(base);
      expect((await git("status", "--porcelain")).trim()).toBe("");
      await controller.close();
    } finally {
      await f.cleanup();
    }
  }, 60_000);
});
