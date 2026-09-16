import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createControllerActionDispatcher } from "../../src/host/controller/action-dispatcher.js";
import { ArtifactStore } from "../../src/host/controller/artifact-store.js";
import type { ChildOutputStore } from "../../src/host/controller/child-output-store.js";
import { createControllerEffectBroker } from "../../src/host/controller/effect-broker.js";
import { type EffectGrant, pinEffectAuthority } from "../../src/host/controller/effect-registry.js";
import {
  assertDeliverySource,
  integrateGitEffect,
  measureGitEffectRepository,
  promoteGitEffect,
  type VerifiedHeadEvidence,
  type VerifiedPatchEvidence,
} from "../../src/host/controller/git-effect.js";
import { reconcileRemoteEffect } from "../../src/host/controller/remote-effect.js";
import { parseControllerConfig } from "../../src/manifest/controller.js";
import {
  effectRequestSchemaDigest,
  effectResultSchemaDigest,
} from "../../src/manifest/controller-effect.js";
import type { ControllerAction } from "../../src/manifest/controller-protocol.js";
import { intersectOutputAudience } from "../../src/manifest/output-audience.js";
import type {
  ControllerEffectRecord,
  EffectRequestArtifact,
} from "../../src/persistence/controller-effect-records.js";
import {
  controllerActionRequestDigest,
  controllerDefinitionDigest,
} from "../../src/persistence/controller-records.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import { publishGatedChildren } from "./fixtures/controller-delivery-publication.js";

const execute = promisify(execFile);
const roots: string[] = [];
const children: ChildProcess[] = [];
const digest = "d".repeat(64);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(roots.map(makeWritable));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("controller delivery example", () => {
  it("ships a parseable review-to-delivery request graph", async () => {
    const source = await readFile(
      join(process.cwd(), "examples/controller-delivery/controller.yaml"),
      "utf8",
    );
    const config = parseControllerConfig(parseYaml(source));
    expect(config.adapters.map((adapter) => [adapter.id, adapter.effect_id ?? null])).toEqual([
      ["fixed-reviewer", null],
      ["choose-integrate", "integrate"],
      ["fixed-validator", null],
      ["choose-promote", "promote"],
      ["choose-deliver", "deliver"],
    ]);
    const reviewer = config.adapters.find((adapter) => adapter.id === "fixed-reviewer");
    const validator = config.adapters.find((adapter) => adapter.id === "fixed-validator");
    const integrate = config.adapters.find((adapter) => adapter.id === "choose-integrate");
    expect(reviewer?.output_consumers).toEqual([{ kind: "effect", effect_id: "integrate" }]);
    expect(validator?.output_consumers).toEqual([
      { kind: "effect", effect_id: "promote" },
      { kind: "effect", effect_id: "deliver" },
    ]);
    expect(integrate?.source_consumers).toEqual([
      { kind: "adapter", adapter_id: "fixed-validator" },
      { kind: "effect", effect_id: "promote" },
      { kind: "effect", effect_id: "deliver" },
    ]);
    expect(integrate?.result_consumers).toEqual([{ kind: "controller" }]);
    const worker = config.child_outputs?.find((entry) => entry.profile_id === "worker");
    const report = worker?.reports.find((entry) => entry.id === "report");
    if (
      worker?.patch === undefined ||
      report === undefined ||
      reviewer === undefined ||
      validator === undefined ||
      integrate === undefined
    )
      throw new Error("delivery request graph is incomplete");
    expect(intersectOutputAudience(reviewer.output_consumers ?? [], report.consumers)).toEqual([
      { kind: "effect", effect_id: "integrate" },
    ]);
    const selectedSourceAudience = intersectOutputAudience(
      integrate.source_consumers ?? [],
      worker.patch.consumers,
    );
    expect(selectedSourceAudience).toEqual([
      { kind: "adapter", adapter_id: "fixed-validator" },
      { kind: "effect", effect_id: "promote" },
      { kind: "effect", effect_id: "deliver" },
    ]);
    expect(
      intersectOutputAudience(validator.output_consumers ?? [], selectedSourceAudience),
    ).toEqual([
      { kind: "effect", effect_id: "promote" },
      { kind: "effect", effect_id: "deliver" },
    ]);
  });

  it("publishes real child evidence, integrates, validates, promotes, and delivers while intake stays live", async () => {
    const startedAt = performance.now();
    const preparedJournal: unknown[] = [];
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-delivery-example-"));
    roots.push(root);
    const repository = join(root, "repository");
    const privateRoot = join(root, "private");
    await mkdir(repository);
    await mkdir(privateRoot, { mode: 0o700 });
    await execute("git", ["-C", repository, "init", "-q", "-b", "main"]);
    await execute("git", ["-C", repository, "config", "user.name", "Example"]);
    await execute("git", ["-C", repository, "config", "user.email", "example@invalid"]);
    const baseLines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(repository, "value.txt"), `${baseLines.join("\n")}\n`);
    await execute("git", ["-C", repository, "add", "."]);
    await execute("git", ["-C", repository, "commit", "-qm", "base"]);
    const base = await git(repository, "rev-parse", "HEAD");
    const aLines = [...baseLines];
    aLines[1] = "child-a-change";
    const bLines = [...baseLines];
    bLines[10] = "child-b-change";
    let reviewB: Review | undefined;
    const publication = await publishGatedChildren({
      root,
      repository,
      base,
      aContent: `${aLines.join("\n")}\n`,
      bContent: `${bLines.join("\n")}\n`,
      onBPublished: async (store, published, records) => {
        expect(
          records.some(
            (record) => record.type === "subagent_completed" && record.child_id === "child-a",
          ),
        ).toBe(false);
        reviewB = await consumeAndReview(
          store,
          base,
          childOutput(published, "report"),
          childOutput(published, "patch"),
        );
      },
    });
    const definitionDigest = publication.definition.definition_digest;
    const aReport = childOutput(publication.publishedA, "report");
    const aPatch = childOutput(publication.publishedA, "patch");
    const bPatch = childOutput(publication.publishedB, "patch");
    if (reviewB === undefined) throw new Error("B was not reviewed while A remained unresolved");
    const bPublicationOrdinal = publication.records.indexOf(publication.publishedB);
    const aTerminalOrdinal = publication.records.findIndex(
      (record) => record.type === "subagent_completed" && record.child_id === "child-a",
    );
    expect(bPublicationOrdinal).toBeGreaterThan(0);
    expect(aTerminalOrdinal).toBeGreaterThan(bPublicationOrdinal);
    const reviewA = await consumeAndReview(publication.store, base, aReport, aPatch);
    const outputsPublishedAt = performance.now();

    const measured = await measureGitEffectRepository(repository);
    const integrateAuthority = authority("git_integrate", measured, {
      allowed_integration_refs: ["refs/pi-conductor/integration/reviewed"],
      allowed_source_paths: ["value.txt"],
      required_patch_evidence: [{ producer_id: "fixed-reviewer", schema_id: "delivery-review-v1" }],
    });
    const artifactRoot = join(privateRoot, "artifacts");
    await mkdir(artifactRoot, { mode: 0o700 });
    const sourceArtifacts = await ArtifactStore.open({ root: artifactRoot });
    const reviewArtifactA = await publishArtifact(
      sourceArtifacts,
      definitionDigest,
      "review-a",
      Buffer.from(JSON.stringify(reviewA)),
      "delivery-review-v1",
      [{ kind: "effect", effect_id: "integrate" }],
    );
    const reviewArtifactB = await publishArtifact(
      sourceArtifacts,
      definitionDigest,
      "review-b",
      Buffer.from(JSON.stringify(reviewB)),
      "delivery-review-v1",
      [{ kind: "effect", effect_id: "integrate" }],
    );
    let selectedBytes: Buffer | undefined;
    const integration = await integrateGitEffect({
      authority: integrateAuthority,
      request: {
        schema_version: 1,
        kind: "git_integrate",
        repository_id: "example",
        accepted_base: base,
        integration_ref: "refs/pi-conductor/integration/reviewed",
        expected_ref_oid: null,
        patches: [
          patchClaim(aPatch, reviewA, reviewArtifactA),
          patchClaim(bPatch, reviewB, reviewArtifactB),
        ],
        selected_source_paths: ["value.txt"],
      },
      workspaceRoot: privateRoot,
      resolvePatch: async (claim) => {
        const published = claim.artifact_ref === aPatch.ref ? aPatch : bPatch;
        const bytes = (
          await publication.store.read({
            ref: published.ref,
            principal: { kind: "effect", effect_id: "integrate" },
            expectedBinding: published.binding,
          })
        ).bytes;
        const evidence = claim.evidence[0];
        if (evidence === undefined) throw new Error("missing review evidence");
        const reviewArtifact =
          evidence.artifact_ref === reviewArtifactA.ref ? reviewArtifactA : reviewArtifactB;
        const stored = await sourceArtifacts.rangeReadForPrincipal({
          ref: evidence.artifact_ref,
          runId: "run",
          definitionDigest,
          principal: { kind: "effect", effect_id: "integrate" },
          offset: 0,
          length: reviewArtifact.byteLength,
        });
        const actualReview = JSON.parse(stored.bytes.toString("utf8")) as Review;
        if (
          stored.sha256 !== evidence.sha256 ||
          actualReview.subject_digest !== evidence.subject_digest ||
          actualReview.verdict !== "approved"
        )
          throw new Error("stored review evidence does not prove this patch");
        return {
          bytes,
          sha256: sha256(bytes),
          baseCommit: base,
          allowedPaths: ["value.txt"],
          evidence: [verifiedPatch(evidence)],
        };
      },
      publishSelectedSource: async (source) => {
        selectedBytes = Buffer.from(
          JSON.stringify({
            head: source.integratedHead,
            files: source.files.map((file) => ({
              path: file.path,
              sha256: file.sha256,
              bytes_b64: file.bytes.toString("base64"),
            })),
          }),
        );
        const artifact = await publishArtifact(
          sourceArtifacts,
          definitionDigest,
          "selected-source",
          selectedBytes,
          "selected-source-v1",
          [{ kind: "adapter", adapter_id: "fixed-validator" }],
        );
        return { ref: artifact.ref, sha256: artifact.sha256 };
      },
      persistPrepared: async (record) => {
        preparedJournal.push(record);
      },
      assertOpen: () => undefined,
      assertEffectOpen: async () => undefined,
    });
    const integratedValue = await git(
      repository,
      "show",
      `${integration.integratedHead}:value.txt`,
    );
    expect(integratedValue).toContain("child-a-change");
    expect(integratedValue).toContain("child-b-change");
    expect(JSON.parse(selectedBytes?.toString() ?? "null").head).toBe(integration.integratedHead);
    const integratedAt = performance.now();

    if (selectedBytes === undefined) throw new Error("selected source was not published");
    const selectedRead = await sourceArtifacts.rangeReadForPrincipal({
      ref: integration.sourceArtifact.ref,
      runId: "run",
      definitionDigest,
      principal: { kind: "adapter", adapter_id: "fixed-validator" },
      offset: 0,
      length: selectedBytes.byteLength,
    });
    const selectedDocument = JSON.parse(selectedRead.bytes.toString("utf8")) as {
      readonly head: string;
      readonly files: readonly { readonly path: string; readonly bytes_b64: string }[];
    };
    expect(selectedDocument.head).toBe(integration.integratedHead);
    const validation = await validateSource(
      selectedDocument.head,
      selectedDocument.files.map((file) => ({
        path: file.path,
        bytes: Buffer.from(file.bytes_b64, "base64"),
      })),
    );
    const validationArtifact = await publishArtifact(
      sourceArtifacts,
      definitionDigest,
      "validation",
      Buffer.from(JSON.stringify(validation)),
      "delivery-validation-v1",
      [
        { kind: "effect", effect_id: "promote" },
        { kind: "effect", effect_id: "deliver" },
      ],
    );
    const evidenceClaim = {
      artifact_ref: validationArtifact.ref,
      sha256: validationArtifact.sha256,
      producer_id: "fixed-validator",
      schema_id: "delivery-validation-v1",
      subject_head: integration.integratedHead,
      verdict: "approved" as const,
    };
    const verifiedHead: VerifiedHeadEvidence = {
      artifactRef: evidenceClaim.artifact_ref,
      sha256: evidenceClaim.sha256,
      producerId: evidenceClaim.producer_id,
      schemaId: evidenceClaim.schema_id,
      subjectHead: evidenceClaim.subject_head,
      verdict: "approved",
    };
    const resolveValidation = async (effectId: "promote" | "deliver") => {
      const stored = await sourceArtifacts.rangeReadForPrincipal({
        ref: validationArtifact.ref,
        runId: "run",
        definitionDigest,
        principal: { kind: "effect", effect_id: effectId },
        offset: 0,
        length: validationArtifact.byteLength,
      });
      const actual = JSON.parse(stored.bytes.toString("utf8")) as typeof validation;
      if (
        stored.sha256 !== evidenceClaim.sha256 ||
        actual.subject_head !== integration.integratedHead ||
        actual.verdict !== "approved"
      )
        throw new Error("stored validation does not prove the integrated head");
      return verifiedHead;
    };
    const promoteAuthority = authority("git_promote", measured, {
      allowed_source_refs: ["refs/pi-conductor/integration/reviewed"],
      allowed_target_refs: ["refs/heads/delivered"],
      required_evidence: [{ producer_id: "fixed-validator", schema_id: "delivery-validation-v1" }],
    });
    await promoteGitEffect({
      authority: promoteAuthority,
      request: {
        schema_version: 1,
        kind: "git_promote",
        repository_id: "example",
        source_ref: "refs/pi-conductor/integration/reviewed",
        reviewed_head: integration.integratedHead,
        target_ref: "refs/heads/delivered",
        expected_target_oid: null,
        evidence: [evidenceClaim],
      },
      resolveEvidence: async () => resolveValidation("promote"),
      persistPrepared: async (record) => {
        preparedJournal.push(record);
      },
      assertOpen: () => undefined,
    });

    const tokenPath = join(privateRoot, "delivery-token");
    await writeFile(tokenPath, "example-secret", { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    const holdPath = join(root, "hold");
    const receivedPath = join(root, "received");
    await writeFile(holdPath, "hold");
    const endpoint = await startEndpoint(tokenPath, holdPath, receivedPath);
    const deliverAuthority = authority("deliver_ref", measured, {
      allowed_source_refs: ["refs/heads/delivered"],
      allowed_target_refs: ["refs/heads/main"],
      required_evidence: [{ producer_id: "fixed-validator", schema_id: "delivery-validation-v1" }],
      remote: {
        id: "fake",
        exact_origin: endpoint.origin,
        exact_path: "/delivery",
        method: "PUT",
        credential_source_id: "token",
      },
    });
    const request = {
      schema_version: 1 as const,
      kind: "deliver_ref" as const,
      repository_id: "example",
      source_ref: "refs/heads/delivered",
      reviewed_head: integration.integratedHead,
      remote_id: "fake",
      target_ref: "refs/heads/main",
      expected_remote_oid: null,
      idempotency_key: "delivery-1",
      evidence: [evidenceClaim],
    };
    await assertDeliverySource({
      authority: deliverAuthority,
      request,
      resolveEvidence: async () => resolveValidation("deliver"),
    });
    const requestBytes = Buffer.from(JSON.stringify(request));
    const requestArtifact: EffectRequestArtifact = {
      ref: "artifact/v1/delivery-request",
      sha256: sha256(requestBytes),
      byte_length: requestBytes.byteLength,
      producer: {
        adapter_id: "choose-deliver",
        action_id: "deliver-action",
        operation_id: "delivery-adapter-operation",
      },
      schema: {
        id: deliverAuthority.grant.request_schema_id,
        digest: deliverAuthority.grant.request_schema_digest,
      },
      run_id: "run",
      definition_digest: definitionDigest,
    };
    const effectRecords: ControllerEffectRecord[] = [];
    const broker = createControllerEffectBroker({
      runId: "run",
      controllerId: "controller",
      definitionDigest,
      activationId: "activation",
      ownerEpoch: 1,
      isKnownOwner: () => true,
      records: () => effectRecords,
      append: (record) => {
        effectRecords.push(record);
      },
      assertActionIntent: (actionId, adapterId) => {
        expect([actionId, adapterId]).toEqual(["deliver-action", "choose-deliver"]);
      },
      resolveRequestArtifact: async () => ({ artifact: requestArtifact, bytes: requestBytes }),
      currentEffectGrants: async () => [deliverAuthority.grant],
      pinnedAuthority: () => deliverAuthority,
      currentSupportedImplementations: async () => [implementation("deliver_ref")],
      resolvePatch: async () => {
        throw new Error("unexpected patch resolution");
      },
      resolveHeadEvidence: async () => resolveValidation("deliver"),
      publishIntegratedSource: async () => {
        throw new Error("unexpected source publication");
      },
      workspaceRoot: privateRoot,
      credentialFiles: { token: tokenPath },
      assertOpen: () => undefined,
    });
    const delivery = broker.execute({
      actionId: "deliver-action",
      adapterId: "choose-deliver",
      effectId: "deliver",
      requestArtifact,
      pinnedAuthority: deliverAuthority,
    });
    let deliverySettled = false;
    void delivery.then(
      () => {
        deliverySettled = true;
      },
      () => {
        deliverySettled = true;
      },
    );
    await Promise.race([
      waitForFile(receivedPath),
      delivery.then(() => {
        throw new Error("delivery settled before the endpoint observed its request");
      }),
    ]);
    const successor = successorDispatcher();
    successor.dispatcher.dispatchCommitted("successor");
    await until(() =>
      successor.records.some(
        (record) =>
          record.type === "controller_action_receipt" &&
          record.action_id === "successor" &&
          record.outcome === "accepted",
      ),
    );
    expect(
      successor.records.some((record) => record.type === "delegation_submission_accepted"),
    ).toBe(true);
    successor.release();
    await successor.dispatcher.settle();
    expect(
      successor.records.some(
        (record) =>
          record.type === "controller_action_receipt" &&
          record.action_id === "successor" &&
          record.outcome === "completed",
      ),
    ).toBe(true);
    expect(deliverySettled).toBe(false);
    await unlink(holdPath);
    await expect(delivery).resolves.toMatchObject({
      type: "controller_effect_settled",
      outcome: "applied",
      result: { remote_object_oid: integration.integratedHead },
    });
    await expect(
      reconcileRemoteEffect({
        authority: deliverAuthority,
        request,
        operationId: "delivery-operation",
        credentialFiles: { token: tokenPath },
        assertOpen: () => undefined,
      }),
    ).resolves.toMatchObject({ kind: "applied", remoteObjectOid: integration.integratedHead });
    expect(preparedJournal).toHaveLength(2);
    expect(effectRecords.map((record) => record.type)).toEqual([
      "controller_effect_intent",
      "controller_effect_prepared",
      "controller_effect_settled",
    ]);
    const deliveredAt = performance.now();
    const measurements = {
      output_ms: outputsPublishedAt - startedAt,
      integration_ms: integratedAt - outputsPublishedAt,
      delivery_ms: deliveredAt - integratedAt,
    };
    for (const [stage, duration] of Object.entries(measurements)) {
      expect(duration, `${stage} must be positive`).toBeGreaterThan(0);
      expect(duration, `${stage} exceeded the smoke-test deadline`).toBeLessThan(15_000);
    }
    expect(deliveredAt).toBeGreaterThan(integratedAt);
    expect(integratedAt).toBeGreaterThan(outputsPublishedAt);
    console.info("controller-delivery measurements", JSON.stringify(measurements));
  }, 15_000);
});

function childOutput(
  publication: Extract<PersistedRecord, { type: "controller_child_output_published" }>,
  id: string,
) {
  const output = publication.outputs.find((candidate) => candidate.binding.output.id === id);
  if (output === undefined) throw new Error(`${id} output missing`);
  return output;
}

async function consumeAndReview(
  store: ChildOutputStore,
  base: string,
  report: ReturnType<typeof childOutput>,
  patch: ReturnType<typeof childOutput>,
) {
  const principal = { kind: "adapter" as const, adapter_id: "fixed-reviewer" };
  const reportBytes = (
    await store.read({ ref: report.ref, principal, expectedBinding: report.binding })
  ).bytes;
  const patchBytes = (
    await store.read({ ref: patch.ref, principal, expectedBinding: patch.binding })
  ).bytes;
  return runProgram("review.mjs", {
    schema_version: 1,
    reviewed_head: base,
    report_b64: reportBytes.toString("base64"),
    patch_b64: patchBytes.toString("base64"),
  }) as Promise<Review>;
}

type Review = {
  readonly subject_digest: string;
  readonly verdict: "approved";
};
function patchClaim(
  patch: ReturnType<typeof childOutput>,
  review: Review,
  artifact: Awaited<ReturnType<typeof publishArtifact>>,
) {
  return {
    artifact_ref: patch.ref,
    sha256: patch.sha256,
    base_commit: patch.binding.acceptedBase,
    evidence: [
      {
        artifact_ref: artifact.ref,
        sha256: artifact.sha256,
        producer_id: "fixed-reviewer",
        schema_id: "delivery-review-v1",
        subject_digest: review.subject_digest,
        verdict: review.verdict,
      },
    ],
  };
}
function verifiedPatch(
  evidence: ReturnType<typeof patchClaim>["evidence"][number],
): VerifiedPatchEvidence {
  return {
    artifactRef: evidence.artifact_ref,
    sha256: evidence.sha256,
    producerId: evidence.producer_id,
    schemaId: evidence.schema_id,
    subjectDigest: evidence.subject_digest,
    verdict: evidence.verdict,
  };
}
async function git(repository: string, ...args: string[]) {
  return (await execute("git", ["-C", repository, ...args])).stdout.trim();
}
function implementation(kind: "git_integrate" | "git_promote" | "deliver_ref") {
  return {
    id: `builtin-${kind.replace("_", "-")}-v1`,
    kind,
    digest,
    request_schema_id: `${kind}-request-v1`,
    request_schema_digest: effectRequestSchemaDigest(kind),
    output_schema_id: `${kind}-result-v1`,
    output_schema_digest: effectResultSchemaDigest(kind),
  };
}
function authority(
  kind: "git_integrate" | "git_promote" | "deliver_ref",
  repository: Awaited<ReturnType<typeof measureGitEffectRepository>>,
  fields: Record<string, unknown>,
) {
  const impl = implementation(kind);
  return pinEffectAuthority(
    {
      schema_version: 1,
      id: kind === "git_integrate" ? "integrate" : kind === "git_promote" ? "promote" : "deliver",
      adapter_id: adapterIdFor(kind),
      kind,
      implementation_id: impl.id,
      implementation_digest: impl.digest,
      request_schema_id: impl.request_schema_id,
      request_schema_digest: impl.request_schema_digest,
      output_schema_id: impl.output_schema_id,
      output_schema_digest: impl.output_schema_digest,
      repository: {
        id: "example",
        canonical_path: repository.canonical_path,
        fingerprint: repository.fingerprint,
      },
      max_input_bytes: 524288,
      max_output_bytes: 524288,
      timeout_seconds: 30,
      ...fields,
    } as EffectGrant,
    [impl],
  );
}
function adapterIdFor(kind: "git_integrate" | "git_promote" | "deliver_ref"): string {
  return kind === "git_integrate"
    ? "choose-integrate"
    : kind === "git_promote"
      ? "choose-promote"
      : "choose-deliver";
}
async function publishArtifact(
  store: ArtifactStore,
  definitionDigest: string,
  actionId: string,
  bytes: Buffer,
  schemaId: string,
  audience: readonly (
    | { kind: "adapter"; adapter_id: string }
    | { kind: "effect"; effect_id: string }
  )[],
) {
  const staging = await store.createStaging(actionId);
  await writeFile(staging.outputPath, bytes);
  return store.publish({
    staging,
    binding: {
      runId: "run",
      definitionDigest,
      actionId,
      requestDigest: sha256(bytes),
      producer: {
        kind: "operation",
        operationId: `${actionId}-operation`,
        requestDigest: sha256(bytes),
      },
      outputSchema: { id: schemaId, digest },
      capabilityDigest: digest,
      mediaType: "application/json",
      allowedConsumerProfileIds: [],
      audience,
    },
    validate: () => undefined,
  });
}
async function validateSource(head: string, files: readonly { path: string; bytes: Buffer }[]) {
  return runProgram("validate.mjs", {
    schema_version: 1,
    head,
    files: files.map((file) => ({ path: file.path, bytes_b64: file.bytes.toString("base64") })),
  }) as Promise<{
    subject_head: string;
    verdict: "approved";
  }>;
}
async function runProgram(name: string, input: unknown): Promise<unknown> {
  const script = join(process.cwd(), "examples/controller-delivery", name);
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [script]);
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(error || `${name} failed`)),
    );
    child.stdin.end(JSON.stringify(input));
  });
  return JSON.parse(stdout);
}
async function startEndpoint(tokenPath: string, holdPath: string, receivedPath: string) {
  const token = await readFile(tokenPath, "utf8");
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "examples/controller-delivery/fake-delivery-endpoint.mjs")],
    {
      env: {
        ...process.env,
        PI_CONDUCTOR_EXAMPLE_TOKEN: token,
        PI_CONDUCTOR_EXAMPLE_HOLD_FILE: holdPath,
        PI_CONDUCTOR_EXAMPLE_RECEIVED_FILE: receivedPath,
      },
    },
  );
  children.push(child);
  const port = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk;
      if (output.includes("\n")) resolve(output.trim());
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`endpoint exited ${code}`)));
  });
  return { origin: `http://127.0.0.1:${port}` };
}
async function waitForFile(path: string) {
  for (let count = 0; count < 200; count += 1) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("delivery request was not observed");
}
function successorDispatcher() {
  const action: Extract<ControllerAction, { kind: "delegate" }> = {
    kind: "delegate",
    action_id: "successor",
    tasks: [
      { id: "successor-task", subagent: "worker", objective: "continue", expected_output: "done" },
    ],
  };
  const definitionBase = {
    type: "controller_definition_pinned" as const,
    schema_version: 1 as const,
    run_id: "delivery-run",
    controller_id: "controller",
    pinned_definition: { protocol_version: 1 },
    controller_authority: {
      registration_id: "runtime",
      approval_id: "operator",
      runtime_digest: digest,
      executable_digest: digest,
      capability_digest: digest,
    },
    adapter_authorities: [],
    limits: { max_decisions: 4, max_actions: 4, max_outstanding_actions: 4 },
    ts: 1,
  };
  const definition = {
    ...definitionBase,
    definition_digest: controllerDefinitionDigest(definitionBase),
  };
  const activation = {
    type: "controller_activation_started" as const,
    schema_version: 1 as const,
    run_id: definition.run_id,
    controller_id: definition.controller_id,
    definition_digest: definition.definition_digest,
    activation_id: "activation",
    owner_epoch: 1,
    reason: "start" as const,
    previous_activation_id: null,
    ts: 2,
  };
  const decision = {
    type: "controller_decision_committed" as const,
    schema_version: 1 as const,
    run_id: definition.run_id,
    controller_id: definition.controller_id,
    definition_digest: definition.definition_digest,
    activation_id: activation.activation_id,
    owner_epoch: 1,
    decision_id: "successor-decision",
    prior_revision: 0,
    state_revision: 1,
    prior_cursor: null,
    consumed_cursor: { ordinal: 1, record_digest: sha256Canonical(activation) },
    response_kind: "plan" as const,
    controller_state: {},
    decision_payload: null,
    actions: [
      {
        action_id: action.action_id,
        kind: action.kind,
        request: action,
        request_sha256: controllerActionRequestDigest(definition.definition_digest, action),
      },
    ],
    ts: 3,
  };
  const records: PersistedRecord[] = [definition, activation, decision];
  let release: (() => void) | undefined;
  const waiter = new Promise<void>((resolve) => {
    release = resolve;
  });
  const accepted = {
    type: "delegation_submission_accepted",
    schema_version: 2,
    run_id: definition.run_id,
    submission_id: "successor-submission",
    logical_parent_id: "successor-parent",
    parent_role: "orchestrator",
    parent_visit_index: 1,
    origin: {
      kind: "controller_action",
      controller_id: definition.controller_id,
      definition_digest: definition.definition_digest,
      action_id: action.action_id,
      activation_id: activation.activation_id,
    },
    accepted_args: { mode: "nonblocking", tasks: action.tasks },
    input_fingerprint: digest,
    children: [],
    ts: Date.now(),
  } as unknown as PersistedRecord;
  const dispatcher = createControllerActionDispatcher({
    activation,
    readRecords: () => records,
    persist: (record) => records.push(record),
    assertOpen: () => undefined,
    wake: () => undefined,
    onFatal: (cause) => {
      throw cause;
    },
    runNativePreparation: async (_request, operation) => operation(),
    admission: {
      submit: async () => {
        records.push(accepted);
        return ["successor-child"];
      },
      acceptedSubmission: () => accepted as never,
      status: () => [],
      remainingChildren: () => 1,
      cancel: async () => undefined,
      wait: async () => {
        await waiter;
        return { status: "completed" } as never;
      },
    },
    executables: {
      invokeAdapter: async () => {
        throw new Error("unexpected adapter");
      },
    },
    artifacts: {
      rangeReadForController: async () => {
        throw new Error("unexpected read");
      },
      createStaging: async () => {
        throw new Error("unexpected staging");
      },
      publish: async () => {
        throw new Error("unexpected publication");
      },
    },
  });
  return { dispatcher, records, release: () => release?.() };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 1000; count += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}
async function makeWritable(path: string): Promise<void> {
  const entries = await readdir(path).catch(() => [] as string[]);
  await chmod(path, 0o700).catch(() => undefined);
  await Promise.all(entries.map((entry) => makeWritable(join(path, entry))));
}
