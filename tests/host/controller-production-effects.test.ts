import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovedControllerDefinition,
  approveControllerDefinition,
} from "../../src/host/controller/approved-definition.js";
import { ArtifactStore } from "../../src/host/controller/artifact-store.js";
import { measureBuiltinEffectImplementations } from "../../src/host/controller/effect-implementation-inventory.js";
import { pinEffectAuthority } from "../../src/host/controller/effect-registry.js";
import { measureGitEffectRepository } from "../../src/host/controller/git-effect.js";
import { validateControllerHostApproval } from "../../src/host/controller/host-approval.js";
import { createControllerOutputResolver } from "../../src/host/controller/output-resolver.js";
import {
  ControllerEffectRejectedError,
  createProductionEffects,
} from "../../src/host/controller/production-effects.js";
import { parseControllerConfig } from "../../src/manifest/controller.js";
import { effectRequestSchemaFor } from "../../src/manifest/controller-effect.js";
import { controllerActionRequestDigest } from "../../src/persistence/controller-records.js";
import { InMemoryRecordLog } from "../../src/persistence/in-memory-log.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import { createLocalProductionGrant } from "./fixtures/local-production-grant.js";

const digest = "a".repeat(64);
const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await execute("chmod", ["-R", "u+w", root]);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("production controller effects", () => {
  it("rejects a substituted adapter request artifact before a durable effect intent", async () => {
    const supported = await measureBuiltinEffectImplementations();
    const implementation = supported.find((entry) => entry.kind === "deliver_ref");
    if (implementation === undefined) throw new Error("delivery implementation missing");
    const grant = {
      schema_version: 1 as const,
      id: "delivery",
      adapter_id: "deliver",
      kind: "deliver_ref" as const,
      implementation_id: implementation.id,
      implementation_digest: implementation.digest,
      request_schema_id: implementation.request_schema_id,
      request_schema_digest: implementation.request_schema_digest,
      output_schema_id: implementation.output_schema_id,
      output_schema_digest: implementation.output_schema_digest,
      repository: { id: "repo", canonical_path: "/repo", fingerprint: digest },
      remote: {
        id: "remote",
        exact_origin: "https://example.invalid",
        exact_path: "/ref",
        method: "PUT" as const,
        credential_source_id: "token",
      },
      allowed_source_refs: ["refs/reviewed/main"],
      allowed_target_refs: ["refs/heads/main"],
      required_evidence: [{ producer_id: "review", schema_id: "review-v1" }],
      max_input_bytes: 65536,
      max_output_bytes: 65536,
      timeout_seconds: 5,
    };
    const authority = pinEffectAuthority(grant, supported);
    const adapter = {
      id: "deliver",
      runtime_id: "runtime",
      executable: "/bin/deliver",
      argv: [],
      input_schema_id: "input",
      output_schema_id: implementation.request_schema_id,
      capability: "private_staging" as const,
      effect_id: "delivery",
      output_consumers: [{ kind: "effect" as const, effect_id: "delivery" }],
    };
    const definition = {
      config: {
        protocol_version: 1,
        controller_id: "controller",
        runtime_id: "runtime",
        executable: "/bin/controller",
        argv: [],
        adapters: [adapter],
        delegation: { allowed_subagents: ["review"], max_children_per_session: 1, max_parallel: 1 },
      },
      approval: {
        schema_version: 1,
        approval_id: "approval",
        runtimes: [],
        controllers: [],
        adapters: [adapter],
        schemas: [
          {
            schema_id: implementation.request_schema_id,
            schema_digest: implementation.request_schema_digest,
            schema: {},
          },
        ],
        effects: [grant],
        credential_sources: [{ id: "token", path: "/private/token" }],
      },
      record: {
        type: "controller_definition_pinned",
        schema_version: 1,
        run_id: "run",
        controller_id: "controller",
        definition_digest: digest,
        pinned_definition: { effects: [authority] },
      },
    } as unknown as ApprovedControllerDefinition;
    const effects = await createProductionEffects({
      definition,
      activation: {
        type: "controller_activation_started",
        schema_version: 1,
        run_id: "run",
        controller_id: "controller",
        definition_digest: digest,
        activation_id: "activation",
        owner_epoch: 1,
        reason: "start",
        previous_activation_id: null,
        ts: 1,
      },
      artifacts: {} as never,
      outputResolver: {
        resolveRef: async () => {
          throw new Error("must not read");
        },
      },
      records: () => [],
      persist: () => {},
      loadApproval: async () => definition.approval,
      runStateDir: "/private",
      assertOpen: () => {},
      credentialFiles: { token: "/private/token" },
    });
    await expect(
      effects.runAdapterEffect(
        { kind: "adapter", action_id: "action", adapter_id: "deliver", input_refs: [] },
        {
          operationId: "real-operation",
          artifact: {
            ref: `artifact/v1/${digest}/${digest}`,
            sha256: digest,
            byteLength: 2,
            mediaType: "application/json",
            binding: {
              runId: "run",
              definitionDigest: digest,
              actionId: "other-action",
              requestDigest: digest,
              producer: { kind: "operation", operationId: "real-operation", requestDigest: digest },
              outputSchema: {
                id: implementation.request_schema_id,
                digest: implementation.request_schema_digest,
              },
              capabilityDigest: digest,
              mediaType: "application/json",
              allowedConsumerProfileIds: [],
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(ControllerEffectRejectedError);
  });

  it.each([
    { kind: "git_promote", privateEvidence: false, inputAccess: true },
    { kind: "local_program", privateEvidence: false, inputAccess: true },
    { kind: "local_program", privateEvidence: true, inputAccess: true },
    { kind: "local_program", privateEvidence: true, inputAccess: false },
  ] as const)("runs $kind (private: $privateEvidence; input access: $inputAccess)", async ({
    kind,
    privateEvidence,
    inputAccess,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-production-effects-"));
    roots.push(root);
    const repository = join(root, "repository");
    const artifactRoot = join(root, "artifacts");
    await mkdir(repository);
    await mkdir(artifactRoot, { mode: 0o700 });
    await execute("git", ["-C", repository, "init", "-q", "-b", "main"]);
    await execute("git", ["-C", repository, "config", "user.name", "Test"]);
    await execute("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(repository, "value.txt"), "approved\n");
    await execute("git", ["-C", repository, "add", "."]);
    await execute("git", ["-C", repository, "commit", "-qm", "base"]);
    const head = (await execute("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    await execute("git", ["-C", repository, "update-ref", "refs/reviewed/main", head]);
    const supported = await measureBuiltinEffectImplementations();
    const implementation = supported.find((entry) => entry.kind === "git_promote");
    if (implementation === undefined) throw new Error("promotion implementation missing");
    const measured = await measureGitEffectRepository(repository);
    const validator = {
      id: "validator",
      runtime_id: "runtime",
      executable: "/bin/bash",
      argv: [],
      input_schema_id: "validator-input",
      output_schema_id: "validation-v1",
      capability: "read_only" as const,
      output_consumers: [{ kind: "effect" as const, effect_id: "promote" }],
    };
    const promote = {
      id: "promote",
      runtime_id: "runtime",
      executable: "/bin/bash",
      argv: [],
      input_schema_id: "promote-input",
      output_schema_id: implementation.request_schema_id,
      capability: "private_staging" as const,
      effect_id: "promote",
      output_consumers: [{ kind: "effect" as const, effect_id: "promote" }],
      result_consumers: [{ kind: "controller" as const }],
    };
    const builtinGrant = {
      schema_version: 1 as const,
      id: "promote",
      adapter_id: promote.id,
      kind: "git_promote" as const,
      implementation_id: implementation.id,
      implementation_digest: implementation.digest,
      request_schema_id: implementation.request_schema_id,
      request_schema_digest: implementation.request_schema_digest,
      output_schema_id: implementation.output_schema_id,
      output_schema_digest: implementation.output_schema_digest,
      repository: {
        id: "repository",
        canonical_path: measured.canonical_path,
        fingerprint: measured.fingerprint,
      },
      allowed_source_refs: ["refs/reviewed/main"],
      allowed_target_refs: ["refs/releases/approved"],
      required_evidence: [{ producer_id: validator.id, schema_id: validator.output_schema_id }],
      max_input_bytes: 65536,
      max_output_bytes: 65536,
      timeout_seconds: 10,
    };
    const grant =
      kind === "git_promote"
        ? builtinGrant
        : await createLocalProductionGrant(root, builtinGrant, supported);
    promote.output_schema_id = grant.request_schema_id;
    const inputSchema = { type: "object" };
    const approval = validateControllerHostApproval({
      schema_version: 1,
      approval_id: "operator",
      runtimes: [
        {
          runtime_id: "runtime",
          source_root: root,
          inventory_sha256: digest,
          bootstrap_approval: {
            approvalId: "runtime",
            files: [{ path: "bin/bash", sha256: digest }],
          },
        },
      ],
      controllers: [
        { controller_id: "controller", runtime_id: "runtime", executable: "/bin/bash", argv: [] },
      ],
      adapters: [validator, promote],
      schemas: [
        {
          schema_id: "validator-input",
          schema_digest: sha256Canonical(inputSchema),
          schema: inputSchema,
        },
        {
          schema_id: "promote-input",
          schema_digest: sha256Canonical(inputSchema),
          schema: inputSchema,
        },
        {
          schema_id: validator.output_schema_id,
          schema_digest: sha256Canonical(inputSchema),
          schema: inputSchema,
        },
        {
          schema_id: promote.output_schema_id,
          schema_digest: grant.request_schema_digest,
          schema: effectRequestSchemaFor(kind),
        },
      ],
      effects: [grant],
    });
    const definition = approveControllerDefinition(
      "run",
      parseControllerConfig({
        protocol_version: 1,
        controller_id: "controller",
        runtime_id: "runtime",
        executable: "/bin/bash",
        argv: [],
        adapters: [validator, promote],
        delegation: { allowed_subagents: ["worker"], max_children_per_session: 1, max_parallel: 1 },
      }),
      approval,
      1,
    );
    const activation = {
      type: "controller_activation_started" as const,
      schema_version: 1 as const,
      run_id: "run",
      controller_id: "controller",
      definition_digest: definition.record.definition_digest,
      activation_id: "activation",
      owner_epoch: 1,
      reason: "start" as const,
      previous_activation_id: null,
      ts: 2,
    };
    const validateAction = {
      kind: "adapter" as const,
      action_id: "validate",
      adapter_id: validator.id,
      input_refs: [],
    };
    const promoteAction = {
      kind: "adapter" as const,
      action_id: "promote",
      adapter_id: promote.id,
      input_refs: [],
    };
    const decision = {
      type: "controller_decision_committed" as const,
      schema_version: 1 as const,
      run_id: "run",
      controller_id: "controller",
      definition_digest: definition.record.definition_digest,
      activation_id: "activation",
      owner_epoch: 1,
      decision_id: "decision",
      prior_revision: 0,
      state_revision: 1,
      prior_cursor: null,
      consumed_cursor: { ordinal: 1, record_digest: sha256Canonical(activation) },
      response_kind: "plan" as const,
      controller_state: {},
      decision_payload: null,
      actions: [validateAction, promoteAction].map((request) => ({
        action_id: request.action_id,
        kind: request.kind,
        request_sha256: controllerActionRequestDigest(definition.record.definition_digest, request),
        request,
      })),
      ts: 3,
    };
    const log = new InMemoryRecordLog();
    log.append(definition.record);
    log.append(activation);
    log.append(decision);
    const artifacts = await ArtifactStore.open({ root: artifactRoot });
    const publish = async (
      action: typeof validateAction,
      operationId: string,
      value: unknown,
      schema: { id: string; digest: string },
      audience: readonly import("../../src/manifest/controller-output.js").ControllerOutputPrincipal[],
    ) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const staging = await artifacts.createStaging(action.action_id);
      await writeFile(staging.outputPath, bytes, { mode: 0o600 });
      return artifacts.publish({
        staging,
        binding: {
          runId: "run",
          definitionDigest: definition.record.definition_digest,
          actionId: action.action_id,
          requestDigest: controllerActionRequestDigest(definition.record.definition_digest, action),
          producer: {
            kind: "operation",
            operationId,
            requestDigest: controllerActionRequestDigest(
              definition.record.definition_digest,
              action,
            ),
          },
          outputSchema: schema,
          capabilityDigest: digest,
          mediaType: "application/json",
          allowedConsumerProfileIds: [],
          audience,
        },
        validate: () => undefined,
      });
    };
    const validation = await publish(
      validateAction,
      "validator-operation",
      { schema_version: 1, subject_head: head, verdict: "approved" },
      { id: validator.output_schema_id, digest: sha256Canonical(inputSchema) },
      [
        ...(inputAccess ? [{ kind: "effect" as const, effect_id: "promote" }] : []),
        ...(privateEvidence ? [] : [{ kind: "controller" as const }]),
      ],
    );
    log.append({
      type: "controller_action_receipt",
      schema_version: 1,
      run_id: "run",
      controller_id: "controller",
      definition_digest: definition.record.definition_digest,
      action_id: validateAction.action_id,
      activation_id: "activation",
      owner_epoch: 1,
      intent_activation_id: "activation",
      causal_revision: 1,
      request_sha256: controllerActionRequestDigest(
        definition.record.definition_digest,
        validateAction,
      ),
      kind: "adapter",
      outcome: "completed",
      operation_id: "validator-operation",
      result_refs: [validation.ref],
      diagnostic: null,
      ts: 4,
    });
    const request = {
      schema_version: 1 as const,
      kind,
      ...(kind === "local_program"
        ? { operation: "observe", payload: {} }
        : { expected_target_oid: null }),
      repository_id: "repository",
      source_ref: "refs/reviewed/main",
      reviewed_head: head,
      target_ref: "refs/releases/approved",
      evidence: [
        {
          artifact_ref: validation.ref,
          sha256: validation.sha256,
          producer_id: validator.id,
          schema_id: validator.output_schema_id,
          subject_head: head,
          verdict: "approved" as const,
        },
      ],
    };
    const requestArtifact = await publish(
      promoteAction,
      "promote-operation",
      request,
      { id: grant.request_schema_id, digest: grant.request_schema_digest },
      [{ kind: "effect", effect_id: "promote" }, { kind: "controller" }],
    );
    const resolver = createControllerOutputResolver({
      artifactStore: artifacts,
      childOutputStore: {} as never,
      records: () => log.records("run"),
      runId: "run",
      definitionDigest: definition.record.definition_digest,
    });
    const options = {
      definition,
      activation,
      artifacts,
      outputResolver: resolver,
      records: () => log.records("run"),
      persist: (
        record: import("../../src/persistence/controller-effect-records.js").ControllerEffectRecord,
      ) => log.append(record),
      loadApproval: async () => approval,
      runStateDir: root,
      assertOpen: () => undefined,
      credentialFiles: {},
    };
    const effects = await createProductionEffects(options);
    const outcome = await effects.runAdapterEffect(promoteAction, {
      operationId: "promote-operation",
      artifact: requestArtifact,
    });
    if (!inputAccess) {
      expect(outcome.outcome).toBe("failed");
      expect(
        log
          .records("run")
          .filter((record) => record.type === "controller_local_effect_process_admitted"),
      ).toHaveLength(0);
      return;
    }
    expect(outcome).toMatchObject({ outcome: "completed", result_refs: [expect.any(String)] });
    if (kind === "git_promote") {
      expect(
        (
          await execute("git", ["-C", repository, "rev-parse", "refs/releases/approved"])
        ).stdout.trim(),
      ).toBe(head);
    } else {
      const resultRef = outcome.result_refs[0];
      if (resultRef === undefined) throw new Error("missing result");
      if (privateEvidence) {
        await expect(resolver.resolveRef(resultRef, { kind: "controller" })).rejects.toThrow();
      } else {
        const output = await resolver.resolveRef(resultRef, { kind: "controller" });
        expect(JSON.parse(output.bytes.toString("utf8"))).toMatchObject({
          payload: { ci: "pending" },
        });
      }
      expect(
        log
          .records("run")
          .filter((record) => record.type === "controller_local_effect_process_admitted"),
      ).toHaveLength(1);
    }
    const action = (
      await import("../../src/persistence/controller-timeline.js")
    ).getControllerAction(
      (await import("../../src/persistence/controller-timeline.js")).reconstructControllerTimeline(
        log.records("run"),
      ),
      "promote",
    );
    if (action === null) throw new Error("missing promotion action");
    const settled = log
      .records("run")
      .filter((record) => record.type === "controller_effect_settled").length;
    const recovered = await (await createProductionEffects(options)).recoverEffectAction(
      action,
      requestArtifact,
    );
    expect(recovered.receipts[0]?.resultRefs).toEqual(outcome.result_refs);
    expect(
      log.records("run").filter((record) => record.type === "controller_effect_settled"),
    ).toHaveLength(settled);
  }, 30000);
});
