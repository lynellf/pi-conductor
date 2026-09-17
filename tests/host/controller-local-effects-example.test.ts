import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerActionDispatcher } from "../../src/host/controller/action-dispatcher.js";
import { createControllerEffectBroker } from "../../src/host/controller/effect-broker.js";
import type { EffectBrokerDependencies } from "../../src/host/controller/effect-broker-contract.js";
import { type EffectGrant, pinEffectAuthority } from "../../src/host/controller/effect-registry.js";
import { measureGitEffectRepository } from "../../src/host/controller/git-effect.js";
import { measureLocalProgramImplementation } from "../../src/host/controller/local-effect-measurement.js";
import {
  type LocalProgramEffectGrant,
  localProgramImplementationDigest,
  localProgramRuntimeDigest,
} from "../../src/host/controller/local-effect-registry.js";
import { createDelegationAdmissionService } from "../../src/host/delegation/admission-service.js";
import { DelegationScheduler } from "../../src/host/delegation/scheduler.js";
import {
  effectRequestSchemaDigest,
  effectResultSchemaDigest,
} from "../../src/manifest/controller-effect.js";
import type {
  ControllerAction,
  ControllerRequest,
} from "../../src/manifest/controller-protocol.js";
import type { LocalProgramRequest } from "../../src/manifest/local-effect.js";
import type {
  ControllerEffectRecord,
  ControllerEffectSettledRecord,
  EffectRequestArtifact,
} from "../../src/persistence/controller-effect-records.js";
import { controllerLogicalParentId } from "../../src/persistence/delegation-task.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import { child, completed, terminalRecord } from "./delegation-scheduler-review-fixture.js";
import { controllerSessionFixture, response } from "./fixtures/controller-role-session-fixture.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const forges: (() => Promise<void>)[] = [];
const hostDriverDigest = "d".repeat(64);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(forges.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fixed local Forge provider example", () => {
  it("creates or reuses one pull request, then records pending CI as a successful observation", async () => {
    const fixture = await createFixture();
    const published = await fixture.execute("publish_reviewed", "publish");
    const reused = await fixture.execute("publish_reviewed", "reuse");
    const observed = await fixture.execute("observe_ci", "observe");

    expect(published.outcome).toBe("applied");
    expect(reused.outcome).toBe("applied");
    expect(observed.outcome).toBe("applied");
    expect(observed.result).toMatchObject({ payload: { stage: "pending" } });
    expect(fixture.forge.pullRequestCount()).toBe(1);
    expect(fixture.forge.counts.create).toBe(2);
    expect(fixture.forge.counts.read).toBeGreaterThan(0);
  }, 15_000);

  it.each([
    "missing",
    "changed head",
    "missing required check",
    "failed checks",
  ] as const)("denies merge when the pull request is %s", async (caseName) => {
    const fixture = await createFixture();
    if (caseName === "changed head")
      fixture.forge.seed("publish", { head: "b".repeat(64), stage: "passed", merged: false });
    if (caseName === "failed checks")
      fixture.forge.seed("publish", {
        head: fixture.reviewedHead,
        stage: "failed",
        merged: false,
      });
    if (caseName === "missing required check")
      fixture.forge.seed("publish", {
        head: fixture.reviewedHead,
        stage: "pending",
        merged: false,
      });

    const merged = await fixture.execute("request_merge", "merge");

    expect(merged.outcome).toBe("not_applied");
    expect(fixture.forge.counts.merge).toBe(0);
  });

  it("checks the exact reviewed head, requests one passing merge, and verifies it", async () => {
    const fixture = await createFixture();
    await fixture.execute("publish_reviewed", "publish");
    fixture.forge.setStage("publish", "passed");

    const merged = await fixture.execute("request_merge", "merge");

    expect(merged.outcome).toBe("applied");
    expect(merged.result).toMatchObject({ payload: { merged: true, stage: "passed" } });
    expect(fixture.forge.counts.merge).toBe(1);
  });

  it("treats a malformed Forge merge response as uncertain", async () => {
    const fixture = await createFixture({ wrongMergeResponse: true });
    await fixture.execute("publish_reviewed", "publish");
    fixture.forge.setStage("publish", "passed");

    const merged = await fixture.execute("request_merge", "merge");

    expect(merged.outcome).toBe("uncertain");
    expect(fixture.forge.counts.merge).toBe(1);
  });

  it("finishes a native successor while CI is pending, then observes and merges", async () => {
    const fixture = await createFixture();
    await fixture.execute("publish_reviewed", "publish");
    const pending = await fixture.execute("observe_ci", "pending");
    expect(pending.result).toMatchObject({ payload: { stage: "pending" } });
    expect(fixture.forge.branchHead("refs/heads/target")).toBe(fixture.reviewedHead);

    const native = await completeNativeSuccessor();

    expect(native.waitAfterCTerminal).toBe(true);
    expect(native.noBusyPolling).toBe(true);
    expect(fixture.forge.stage("publish")).toBe("pending");
    expect(fixture.forge.counts.merge).toBe(0);

    fixture.forge.setStage("publish", "passed");
    const passed = await fixture.execute("observe_ci", "passed");
    const merged = await fixture.execute("request_merge", "merge");
    expect(passed.result).toMatchObject({ payload: { stage: "passed" } });
    expect(merged.outcome).toBe("applied");
  }, 15_000);

  it("recovers a crash after the Forge write through inspect without replaying it", async () => {
    const fixture = await createFixture();
    const crashed = await fixture.execute("publish_crash_after_remote", "crash");

    expect(crashed.outcome).toBe("uncertain");
    expect(fixture.forge.counts.create).toBe(1);

    const recovered = settled(await fixture.broker.reconcile(crashed.operation_id));

    expect(recovered.outcome).toBe("applied");
    expect(fixture.forge.counts.create).toBe(1);
    expect(fixture.forge.counts.read).toBeGreaterThan(0);
  });

  it("does not invoke the provider when admission fails before the effect", async () => {
    const fixture = await createFixture({ closed: true });

    await expect(fixture.execute("publish_reviewed", "closed")).rejects.toThrow("closed");
    expect(fixture.forge.counts.create).toBe(0);
  });

  it("inspects after settlement receipt persistence fails and never replays the write", async () => {
    const fixture = await createFixture({ failFirstSettlement: true });

    await expect(fixture.execute("publish_reviewed", "receipt")).rejects.toThrow(
      "effect journal persistence is ambiguous",
    );
    expect(fixture.forge.counts.create).toBe(1);

    const recovered = settled(await fixture.recoverWithFreshBroker());

    expect(recovered.outcome).toBe("applied");
    expect(fixture.forge.counts.create).toBe(1);
  });
});

async function createFixture(
  options: {
    readonly closed?: boolean;
    readonly failFirstSettlement?: boolean;
    readonly wrongMergeResponse?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-local-forge-"));
  roots.push(root);
  await chmod(root, 0o700);
  const repository = join(root, "repository");
  const workspace = join(root, "workspace");
  const provider = join(root, "provider.mjs");
  const credential = join(root, "forge-token");
  await exec("git", ["init", "--quiet", repository]);
  await writeFile(join(repository, "README.md"), "reviewed\n");
  await exec("git", ["-C", repository, "add", "README.md"]);
  await exec("git", [
    "-C",
    repository,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "--quiet",
    "-m",
    "reviewed",
  ]);
  await exec("git", ["-C", repository, "branch", "-M", "source"]);
  await exec("git", ["-C", repository, "update-ref", "refs/heads/target", "HEAD"]);
  const reviewedHead = (await exec("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  await cp(join(process.cwd(), "examples/controller-local-effects/provider.mjs"), provider);
  await chmod(provider, 0o700);
  await writeFile(credential, "fixture-forge-token", { mode: 0o600 });
  await mkdir(workspace, { mode: 0o700 });
  const forge = await createFakeForge("fixture-forge-token", options.wrongMergeResponse === true);
  forges.push(forge.close);
  const canonicalNode = await realpath(process.execPath);
  const repositoryIdentity = await measureGitEffectRepository(repository);
  const runtime = {
    id: "example-provider-runtime",
    digest: "",
    dependencies: [{ canonical_path: provider, sha256: await fileSha(provider) }],
  };
  runtime.digest = localProgramRuntimeDigest(runtime);
  const inputDocument = {
    type: "object",
    properties: {
      pr_key: { type: "string", minLength: 1 },
      request_tag: { type: "string", minLength: 1 },
    },
    required: ["pr_key"],
    additionalProperties: false,
  };
  const resultDocument = {
    type: "object",
    properties: {
      stage: { type: "string" },
      pull_request_id: { anyOf: [{ type: "string" }, { type: "null" }] },
      head: { anyOf: [{ type: "string" }, { type: "null" }] },
      merged: { type: "boolean" },
    },
    required: ["stage", "pull_request_id", "head", "merged"],
    additionalProperties: false,
  };
  const providerApproval = {
    executable: { canonical_path: canonicalNode, sha256: await fileSha(canonicalNode) },
    argv: [provider, forge.origin],
    runtime,
    credential_source_ids: ["forge_token"],
    network: { allowed_origins: [forge.origin] },
  };
  const grant: LocalProgramEffectGrant = {
    schema_version: 1,
    id: "local-forge",
    adapter_id: "forge-adapter",
    kind: "local_program",
    implementation_id: "example-forge-provider-v1",
    implementation_digest: localProgramImplementationDigest(providerApproval, hostDriverDigest),
    host_driver_digest: hostDriverDigest,
    request_schema_id: "local-program-request-v1",
    request_schema_digest: effectRequestSchemaDigest("local_program"),
    output_schema_id: "local-program-result-v1",
    output_schema_digest: effectResultSchemaDigest("local_program"),
    repository: {
      id: "fixture-repository",
      canonical_path: repositoryIdentity.canonical_path,
      fingerprint: repositoryIdentity.fingerprint,
    },
    provider: providerApproval,
    operations: [
      "publish_reviewed",
      "publish_crash_after_remote",
      "observe_ci",
      "request_merge",
    ].map((operation) => ({
      operation,
      semantics: operation === "observe_ci" ? ("observe" as const) : ("write" as const),
      input_schema: {
        id: "forge-operation-input-v1",
        digest: sha256Canonical(inputDocument),
        document: inputDocument,
      },
      result_schema: {
        id: "forge-operation-result-v1",
        digest: sha256Canonical(resultDocument),
        document: resultDocument,
      },
      resource_conflict_keys: ["pull-request"],
    })),
    allowed_source_refs: ["refs/heads/source"],
    allowed_target_refs: ["refs/heads/target"],
    required_evidence: [{ producer_id: "reviewer", schema_id: "review-v1" }],
    max_input_bytes: 65_536,
    max_output_bytes: 65_536,
    timeout_seconds: 5,
  };
  const implementation = await measureLocalProgramImplementation(grant, hostDriverDigest);
  const authority = pinEffectAuthority(grant, [implementation]);
  const evidenceBytes = Buffer.from("approved fixture evidence");
  const evidenceSha = sha(evidenceBytes);
  const records: ControllerEffectRecord[] = [];
  let failSettlement = options.failFirstSettlement === true;
  const dependencies: EffectBrokerDependencies = {
    runId: "run-local-forge",
    controllerId: "controller-local-forge",
    definitionDigest: "e".repeat(64),
    activationId: "activation-local-forge",
    ownerEpoch: 1,
    isKnownOwner: (activationId, ownerEpoch) =>
      activationId === "activation-local-forge" && ownerEpoch === 1,
    records: () => records,
    append: (record) => {
      if (failSettlement && record.type === "controller_effect_settled") {
        failSettlement = false;
        throw new Error("receipt store unavailable");
      }
      records.push(record);
    },
    assertActionIntent: () => undefined,
    resolveRequestArtifact: async (artifact) => ({
      artifact,
      bytes: Buffer.from(artifactPayloads.get(artifact.ref) ?? ""),
    }),
    currentEffectGrants: async () => [grant],
    pinnedAuthority: () => authority,
    currentSupportedImplementations: async () => [implementation],
    resolvePatch: async () => {
      throw new Error("local provider does not resolve patches");
    },
    resolveHeadEvidence: async () => ({
      artifactRef: "artifact/review",
      sha256: evidenceSha,
      producerId: "reviewer",
      schemaId: "review-v1",
      subjectHead: reviewedHead,
      verdict: "approved",
    }),
    resolveEvidenceBytes: async () => Buffer.from(evidenceBytes),
    publishIntegratedSource: async () => {
      throw new Error("local provider does not publish Git source artifacts");
    },
    workspaceRoot: workspace,
    credentialFiles: { forge_token: credential },
    assertOpen: () => {
      if (options.closed === true) throw new Error("closed");
    },
  };
  const artifactPayloads = new Map<string, string>();
  const broker = createControllerEffectBroker(dependencies);
  const execute = async (operation: string, actionId: string) => {
    const request = localRequest(grant, reviewedHead, operation, actionId);
    const encoded = JSON.stringify(request);
    const artifact = requestArtifact(actionId, encoded, grant, dependencies);
    artifactPayloads.set(artifact.ref, encoded);
    const record = await broker.execute({
      actionId,
      adapterId: grant.adapter_id,
      effectId: grant.id,
      requestArtifact: artifact,
      pinnedAuthority: authority,
    });
    if (record.type !== "controller_effect_settled")
      throw new Error("broker did not return a settlement record");
    return record;
  };
  return {
    broker,
    forge,
    reviewedHead,
    execute,
    recoverWithFreshBroker: async () =>
      createControllerEffectBroker({
        ...dependencies,
        append: (record) => {
          records.push(record);
        },
      }).reconcile(
        records.find((record) => record.type === "controller_effect_intent")?.operation_id ?? "",
      ),
  };
}

function localRequest(
  grant: LocalProgramEffectGrant,
  reviewedHead: string,
  operation: string,
  requestTag: string,
): LocalProgramRequest {
  const evidence = {
    artifact_ref: "artifact/review",
    sha256: sha("approved fixture evidence"),
    producer_id: "reviewer",
    schema_id: "review-v1",
    subject_head: reviewedHead,
    verdict: "approved" as const,
  };
  return {
    schema_version: 1,
    kind: "local_program",
    repository_id: grant.repository.id,
    operation,
    source_ref: "refs/heads/source",
    target_ref: "refs/heads/target",
    reviewed_head: reviewedHead,
    evidence: [evidence],
    payload: { pr_key: "publish", request_tag: requestTag },
  };
}

function requestArtifact(
  actionId: string,
  encoded: string,
  grant: EffectGrant,
  dependencies: Pick<EffectBrokerDependencies, "runId" | "definitionDigest">,
): EffectRequestArtifact {
  const bytes = Buffer.from(encoded);
  return {
    ref: `artifact/${actionId}`,
    sha256: sha(bytes),
    byte_length: bytes.byteLength,
    producer: {
      adapter_id: grant.adapter_id,
      action_id: actionId,
      operation_id: `adapter-${actionId}`,
    },
    schema: { id: grant.request_schema_id, digest: grant.request_schema_digest },
    run_id: dependencies.runId,
    definition_digest: dependencies.definitionDigest,
  };
}

async function createFakeForge(token: string, wrongMergeResponse: boolean) {
  const pullRequests = new Map<string, PullRequest>();
  const branches = new Map<string, string>();
  const counts = { create: 0, read: 0, merge: 0 };
  let next = 1;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) return respond(response, 401, {});
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/v1\/pull-requests\/([^/]+)(\/merge)?$/);
    if (request.method === "POST" && url.pathname === "/v1/pull-requests") {
      counts.create += 1;
      const body = await jsonBody(request);
      const key = string(body.key);
      const head = string(body.head);
      const targetRef = string(body.target_ref);
      const prior = pullRequests.get(key);
      if (prior !== undefined) return respond(response, 200, prior);
      const created = {
        id: `pr-${next++}`,
        key,
        head,
        target_ref: targetRef,
        stage: "pending",
        merged: false,
      };
      pullRequests.set(key, created);
      branches.set(targetRef, head);
      return respond(response, 201, created);
    }
    if (match !== null && request.method === "GET") {
      counts.read += 1;
      const found = pullRequests.get(decodeURIComponent(match[1] ?? ""));
      return found === undefined ? respond(response, 404, {}) : respond(response, 200, found);
    }
    if (match !== null && match[2] === "/merge" && request.method === "POST") {
      counts.merge += 1;
      const key = decodeURIComponent(match[1] ?? "");
      const found = pullRequests.get(key);
      const body = await jsonBody(request);
      if (
        found === undefined ||
        string(body.expected_head) !== found.head ||
        found.stage !== "passed"
      )
        return respond(response, 409, {});
      const merged = { ...found, merged: true };
      pullRequests.set(key, merged);
      return respond(
        response,
        200,
        wrongMergeResponse ? { ...merged, head: "f".repeat(64) } : merged,
      );
    }
    return respond(response, 404, {});
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fake Forge did not bind TCP");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    counts,
    pullRequestCount: () => pullRequests.size,
    branchHead: (targetRef: string) => branches.get(targetRef) ?? null,
    stage: (key: string) => pullRequests.get(key)?.stage ?? null,
    seed: (key: string, value: Omit<PullRequest, "id" | "key" | "target_ref">) =>
      pullRequests.set(key, { id: `pr-${next++}`, key, target_ref: "refs/heads/target", ...value }),
    setStage: (key: string, stage: string) => {
      const prior = pullRequests.get(key);
      if (prior === undefined) throw new Error("cannot stage a missing fake pull request");
      pullRequests.set(key, { ...prior, stage });
    },
    close: () => close(server),
  };
}

interface PullRequest {
  readonly id: string;
  readonly key: string;
  readonly head: string;
  readonly target_ref: string;
  readonly stage: string;
  readonly merged: boolean;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("fake Forge received malformed JSON");
  return value;
}
async function jsonBody(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("fake Forge body is not an object");
  return value as Record<string, unknown>;
}
function respond(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", (error?: Error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
async function exec(file: string, args: readonly string[]) {
  return execFile(file, args, { encoding: "utf8" });
}
async function fileSha(path: string): Promise<string> {
  return sha(await (await import("node:fs/promises")).readFile(path));
}

function settled(record: ControllerEffectRecord): ControllerEffectSettledRecord {
  if (record.type !== "controller_effect_settled")
    throw new Error("broker did not return a settlement record");
  return record;
}

async function completeNativeSuccessor(): Promise<{
  readonly waitAfterCTerminal: boolean;
  readonly noBusyPolling: boolean;
}> {
  const started: string[] = [];
  let plannerCalls = 0;
  const fixture = await controllerSessionFixture({
    runtime: ({ activation, records, persist, fence, wake }) => {
      const scheduler = new DelegationScheduler({
        identity: {
          runId: activation.run_id,
          logicalParentId: controllerLogicalParentId(
            activation.run_id,
            activation.controller_id,
            activation.definition_digest,
          ),
          parentRole: "orchestrator",
          parentVisitIndex: 1,
          origin: {
            kind: "controller",
            controllerId: activation.controller_id,
            definitionDigest: activation.definition_digest,
          },
        },
        maxParallel: 1,
        maxChildren: 2,
        records: () => records,
        persistRecord: persist,
        prepareSubmission: async (input) => ({
          baseCommit: "base",
          materializedParentPaths: [],
          tasks: input.tasks.map((task) => child(task.id)),
        }),
        runTask: async (task) => {
          const actionId = task.taskId.replace(/^task-/, "");
          started.push(actionId);
          persist({
            type: "subagent_started",
            run_id: activation.run_id,
            child_id: task.childId,
            task_id: task.taskId,
            subagent: task.profile.name,
            parent_role: "orchestrator",
            parent_visit_index: 1,
            model: "stub:model",
            session_file: `/tmp/${task.childId}.jsonl`,
            worktree_path: task.worktreePath,
            branch: task.branch,
            base_commit: task.baseCommit,
            ts: Date.now(),
          });
          return completed(task);
        },
        onTerminal: (result) => {
          const terminal = terminalRecord(result);
          if (terminal.type !== "subagent_completed") throw new Error("native child must complete");
          persist({ ...terminal, run_id: activation.run_id });
        },
      });
      const admission = createDelegationAdmissionService(scheduler);
      const unused = async () => {
        throw new Error("local Forge acceptance fixture does not invoke adapters");
      };
      const dispatcher = createControllerActionDispatcher({
        activation,
        readRecords: () => records,
        persist,
        admission,
        executables: { invokeAdapter: unused },
        artifacts: { rangeReadForController: unused, createStaging: unused, publish: unused },
        assertOpen: () => fence.assertOpen(),
        runNativePreparation: async (_action, operation) => operation(),
        wake,
        onFatal: (cause) => {
          throw cause;
        },
      });
      return { dispatcher, admission };
    },
    invokePlanner: async (request) => {
      plannerCalls += 1;
      if (plannerCalls === 1) return nativePlan(request, [nativeDelegate("B")]);
      const bTerminal = request.events.some(
        (event) =>
          event.kind === "child_terminal" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          "child_id" in event.payload &&
          event.payload.child_id === "child-B",
      );
      if (bTerminal && !started.includes("C")) return nativePlan(request, [nativeDelegate("C")]);
      return { ...response(request, "wait"), decision: "wait", wake_after_ms: 1_000 };
    },
  });
  roots.push(fixture.root);
  const prompting = fixture.session.prompt("no model");
  try {
    await until(() =>
      fixture.records.some(
        (record) => record.type === "subagent_completed" && record.child_id === "child-C",
      ),
    );
    const cTerminal = fixture.records.findIndex(
      (record) => record.type === "subagent_completed" && record.child_id === "child-C",
    );
    await until(() =>
      fixture.records.some(
        (record, index) =>
          record.type === "controller_decision_committed" &&
          record.response_kind === "wait" &&
          index > cTerminal,
      ),
    );
    const wait = fixture.records.findIndex(
      (record, index) =>
        record.type === "controller_decision_committed" &&
        record.response_kind === "wait" &&
        index > cTerminal,
    );
    const callsBeforeQuietPeriod = plannerCalls;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await fixture.session.abortOwnedWork?.();
    await prompting;
    return {
      waitAfterCTerminal: cTerminal >= 0 && wait > cTerminal,
      noBusyPolling: plannerCalls === callsBeforeQuietPeriod,
    };
  } finally {
    await fixture.session.dispose();
  }
}

function nativeDelegate(
  action_id: string,
): Extract<ControllerAction, { readonly kind: "delegate" }> {
  return {
    kind: "delegate",
    action_id,
    tasks: [{ id: action_id, subagent: "worker", objective: "continue", expected_output: "done" }],
  };
}

function nativePlan(request: ControllerRequest, actions: readonly ControllerAction[]) {
  return {
    protocol_version: 1 as const,
    run_id: request.run_id,
    controller_id: request.controller_id,
    definition_digest: request.definition_digest,
    activation_id: request.activation_id,
    owner_epoch: request.owner_epoch,
    state_revision: request.state_revision,
    event_cursor: request.page_cursor,
    state: request.state,
    decision: "plan" as const,
    actions: [...actions],
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 1_000; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("native successor did not reach the expected state");
}
