import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runner: vi.fn(),
  probe: vi.fn(),
  readOutput: vi.fn(),
  onContext: undefined as
    | ((context: { readonly privateWritableRoot: string }) => Promise<void>)
    | undefined,
}));

vi.mock("../../src/host/controller/controller-command-runner.js", () => ({
  createControllerCommandRunner: mocks.runner,
}));
vi.mock("../../src/host/execution/sandbox/probe-runner.js", () => ({
  runVerifiedSandboxCapabilityProbe: mocks.probe,
  SandboxCapabilityProbeError: class SandboxCapabilityProbeError extends Error {
    constructor(
      message: string,
      readonly cleanup: "confirmed" | "unconfirmed",
      options?: ErrorOptions,
    ) {
      super(message, options);
    }
  },
}));
vi.mock("../../src/host/execution/sandbox/output-retrieval.js", () => ({
  readSandboxExecutionOutput: mocks.readOutput,
}));

import {
  type ApprovedControllerDefinition,
  approveControllerDefinition,
} from "../../src/host/controller/approved-definition.js";
import { ArtifactStore } from "../../src/host/controller/artifact-store.js";
import type { ControllerExecutionDriver } from "../../src/host/controller/executable-host.js";
import { validateControllerHostApproval } from "../../src/host/controller/host-approval.js";
import { inventoryRuntimeTree } from "../../src/host/execution/sandbox/runtime-files.js";
import type { ToolExecutionScope } from "../../src/host/execution/tool-execution-controller.js";
import type { SandboxToolExecutionAdapter } from "../../src/host/execution/tool-execution-lifecycle.js";
import { parseControllerConfig } from "../../src/manifest/controller.js";
import type { ControllerRequest } from "../../src/manifest/controller-protocol.js";
import { controllerActionRequestDigest } from "../../src/persistence/controller-records.js";
import type { ControllerSandboxExecutionOwner } from "../../src/persistence/sandbox-execution.js";
import { preparedRuntimeInventoryDigest } from "../../src/persistence/sandbox-runtime.js";
import type { ControllerExecutionOrigin } from "../../src/persistence/tool-execution-origin.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const roots: string[] = [];

let createExecutableControllerHost: typeof import("../../src/host/controller/executable-host.js").createExecutableControllerHost;

beforeEach(async () => {
  vi.resetModules();
  ({ createExecutableControllerHost } = await import(
    "../../src/host/controller/executable-host.js"
  ));
});

afterEach(async () => {
  mocks.runner.mockReset();
  mocks.probe.mockReset();
  mocks.readOutput.mockReset();
  mocks.onContext = undefined;
  await Promise.all(
    roots.splice(0).map(async (root) => {
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve, reject) =>
        execFile("chmod", ["-R", "u+w", root], (error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }),
  );
});

afterAll(() => {
  vi.doUnmock("../../src/host/controller/controller-command-runner.js");
  vi.doUnmock("../../src/host/execution/sandbox/probe-runner.js");
  vi.doUnmock("../../src/host/execution/sandbox/output-retrieval.js");
  vi.resetModules();
});

describe("Issue #115 executable controller host", () => {
  it("records preparation before its planner, probes the verified runtime, and decodes retained stdout", async () => {
    const fixture = await makeFixture();
    const request = plannerRequest(fixture.definition);
    const response = {
      protocol_version: 1,
      run_id: request.run_id,
      controller_id: request.controller_id,
      owner_epoch: request.owner_epoch,
      definition_digest: request.definition_digest,
      activation_id: request.activation_id,
      state_revision: request.state_revision,
      event_cursor: request.page_cursor,
      state: {},
      decision: "wait",
    };
    const stdout = Buffer.from(JSON.stringify(response));
    mocks.probe.mockImplementation(
      async (input: { loadVerifiedContext: () => Promise<unknown> }) => {
        await input.loadVerifiedContext();
        return {};
      },
    );
    mocks.runner.mockImplementation(fakeRunner);
    mocks.readOutput.mockResolvedValue({
      capture: "complete",
      retainedByteCount: stdout.length,
      encoding: "utf8",
      data: stdout.toString("utf8"),
      byteCount: stdout.length,
      nextOffset: stdout.length,
      eof: true,
    });
    const execution = fakeExecution();
    const host = createExecutableControllerHost({
      ...fixture,
      toolExecutionController: execution.driver,
    });

    await expect(host.invokePlanner(request)).resolves.toEqual(response);
    expect(execution.origins.map((origin) => origin.operation_kind)).toEqual([
      "preparation",
      "planner",
    ]);
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(mocks.runner).toHaveBeenCalledTimes(1);
    expect(mocks.readOutput).toHaveBeenCalledWith(
      expect.objectContaining({ expectedControllerOrigin: execution.origins[1] }),
    );
  });

  it("gives a private adapter only staging output and publishes the validated immutable result", async () => {
    const fixture = await makeFixture({ adapter: true });
    const stdout = Buffer.from('{"output":"result.json"}');
    mocks.probe.mockImplementation(
      async (input: { loadVerifiedContext: () => Promise<unknown> }) => {
        await input.loadVerifiedContext();
        return {};
      },
    );
    mocks.runner.mockImplementation(fakeRunner);
    mocks.readOutput.mockResolvedValue({
      capture: "complete",
      retainedByteCount: stdout.length,
      encoding: "utf8",
      data: stdout.toString("utf8"),
      byteCount: stdout.length,
      nextOffset: stdout.length,
      eof: true,
    });
    mocks.onContext = async (context) => {
      await writeFile(
        join(context.privateWritableRoot, "output", "result.json"),
        '{"packet":"ready"}',
      );
    };
    const execution = fakeExecution();
    const host = createExecutableControllerHost({
      ...fixture,
      toolExecutionController: execution.driver,
    });

    const result = await host.invokeAdapter(
      { kind: "adapter", action_id: "prepare", adapter_id: "prepare", input_refs: ["input/1"] },
      controllerActionRequestDigest(fixture.definition.record.definition_digest, {
        kind: "adapter",
        action_id: "prepare",
        adapter_id: "prepare",
        input_refs: ["input/1"],
      }),
    );
    expect(result.artifact.binding).toMatchObject({
      actionId: "prepare",
      requestDigest: controllerActionRequestDigest(fixture.definition.record.definition_digest, {
        kind: "adapter",
        action_id: "prepare",
        adapter_id: "prepare",
        input_refs: ["input/1"],
      }),
      allowedConsumerProfileIds: ["worker"],
    });
    await expect(
      fixture.artifactStore.rangeRead({
        ref: result.artifact.ref,
        runId: fixture.definition.record.run_id,
        definitionDigest: fixture.definition.record.definition_digest,
        consumerProfileId: "worker",
        offset: 0,
        length: 1024,
      }),
    ).resolves.toMatchObject({ bytes: Buffer.from('{"packet":"ready"}') });
    expect(execution.origins.map((origin) => origin.operation_kind)).toEqual([
      "preparation",
      "adapter",
    ]);
  });

  it("rejects a caller-supplied adapter digest before preparation can create private effects", async () => {
    const fixture = await makeFixture({ adapter: true });
    const execution = fakeExecution();
    const host = createExecutableControllerHost({
      ...fixture,
      toolExecutionController: execution.driver,
    });

    await expect(
      host.invokeAdapter(
        { kind: "adapter", action_id: "prepare", adapter_id: "prepare", input_refs: ["input/1"] },
        "d".repeat(64),
      ),
    ).rejects.toThrow("does not match the pinned action");
    expect(execution.origins).toEqual([]);
  });

  it("uses the exact pinned authority when adapters share a runtime, executable, and capability", async () => {
    const fixture = await makeFixture({ adapter: true, secondAdapter: true });
    const stdout = Buffer.from('{"output":"result.json"}');
    mocks.probe.mockImplementation(
      async (input: { loadVerifiedContext: () => Promise<unknown> }) => {
        await input.loadVerifiedContext();
        return {};
      },
    );
    mocks.runner.mockImplementation(fakeRunner);
    mocks.readOutput.mockResolvedValue({
      capture: "complete",
      retainedByteCount: stdout.length,
      encoding: "utf8",
      data: stdout.toString("utf8"),
      byteCount: stdout.length,
      nextOffset: stdout.length,
      eof: true,
    });
    mocks.onContext = async (context) => {
      await writeFile(
        join(context.privateWritableRoot, "output", "result.json"),
        '{"packet":"two"}',
      );
    };
    const execution = fakeExecution();
    const host = createExecutableControllerHost({
      ...fixture,
      toolExecutionController: execution.driver,
    });
    const action = {
      kind: "adapter" as const,
      action_id: "second",
      adapter_id: "prepare-two",
      input_refs: ["input/2"],
    };

    await expect(
      host.invokeAdapter(
        action,
        controllerActionRequestDigest(fixture.definition.record.definition_digest, action),
      ),
    ).resolves.toMatchObject({ artifact: { binding: { actionId: "second" } } });
    const authority = fixture.definition.record.adapter_authorities.find(
      (entry) => entry.adapter_id === "prepare-two",
    );
    if (authority === undefined) throw new Error("second adapter authority is missing");
    expect(execution.owners.at(-1)?.runtime).toEqual({
      runtime_id: "runtime",
      approval_id: authority.approval_id,
      runtime_digest: authority.runtime_digest,
      executable_digest: authority.executable_digest,
      capability_digest: authority.capability_digest,
    });
  });
});

async function makeFixture(
  options: { readonly adapter?: boolean; readonly secondAdapter?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-executable-host-"));
  roots.push(root);
  const source = join(root, "source");
  const state = join(root, "state");
  const checkout = join(root, "checkout");
  const artifactsRoot = join(root, "artifacts");
  await mkdir(join(source, "bin"), { recursive: true });
  await Promise.all([
    mkdir(state, { mode: 0o700 }),
    mkdir(checkout),
    mkdir(artifactsRoot, { mode: 0o700 }),
  ]);
  const bytes = Buffer.from("approved executable");
  await Promise.all([
    writeFile(join(source, "bin", "bash"), bytes, { mode: 0o700 }),
    writeFile(join(source, "bin", "planner"), bytes, { mode: 0o700 }),
    writeFile(join(source, "bin", "adapter"), bytes, { mode: 0o700 }),
  ]);
  const packetSchema = Type.Object({ packet: Type.String() }, { additionalProperties: false });
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
  const config = parseControllerConfig({
    protocol_version: 1,
    controller_id: "planner",
    runtime_id: "runtime",
    executable: "/bin/planner",
    argv: ["--literal"],
    adapters: options.adapter
      ? [
          {
            id: "prepare",
            runtime_id: "runtime",
            executable: "/bin/adapter",
            argv: [],
            input_schema_id: "adapter-input",
            output_schema_id: "packet",
            capability: "private_staging",
          },
          ...(options.secondAdapter
            ? [
                {
                  id: "prepare-two",
                  runtime_id: "runtime",
                  executable: "/bin/adapter",
                  argv: [],
                  input_schema_id: "adapter-input",
                  output_schema_id: "packet",
                  capability: "private_staging" as const,
                },
              ]
            : []),
        ]
      : [],
    delegation: { allowed_subagents: ["worker"], max_children_per_session: 2, max_parallel: 1 },
  });
  const inventory = await inventoryRuntimeTree(source);
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const approval = validateControllerHostApproval({
    schema_version: 1,
    approval_id: "approval",
    runtimes: [
      {
        runtime_id: "runtime",
        source_root: source,
        inventory_sha256: preparedRuntimeInventoryDigest(inventory),
        bootstrap_approval: {
          approvalId: "runtime-bootstrap",
          files: [
            { path: "bin/bash", sha256: digest(bytes) },
            { path: "bin/planner", sha256: digest(bytes) },
            { path: "bin/adapter", sha256: digest(bytes) },
          ],
        },
      },
    ],
    controllers: [
      {
        controller_id: "planner",
        runtime_id: "runtime",
        executable: "/bin/planner",
        argv: ["--literal"],
      },
    ],
    adapters: options.adapter ? config.adapters : [],
    schemas: options.adapter
      ? [
          {
            schema_id: "adapter-input",
            schema_digest: sha256Canonical(inputSchema),
            schema: inputSchema,
          },
          {
            schema_id: "packet",
            schema_digest: sha256Canonical(packetSchema),
            schema: packetSchema,
          },
        ]
      : [],
  });
  const definition = approveControllerDefinition("run", config, approval, 1);
  const artifactStore = await ArtifactStore.open({ root: artifactsRoot });
  return {
    approvedDefinition: definition,
    definition,
    getCurrentApproval: async () => approval,
    runStateDir: state,
    protection: { primaryCheckout: checkout, stateRoots: [state], childWorkspaceRoots: [] },
    sandboxHostApproval: {
      binaryPath: "/bin/false",
      approvedBuilds: [],
      probeApproval: { approvalId: "probe", sha256: "a".repeat(64) },
    },
    activationId: "activation",
    ownerEpoch: 1,
    assertOpen: () => {},
    artifactStore,
    resolveRef: async (ref: string) => ({ ref, value: "resolved" }),
  };
}

function plannerRequest(definition: ApprovedControllerDefinition): ControllerRequest {
  return {
    protocol_version: 1,
    run_id: definition.record.run_id,
    controller_id: definition.record.controller_id,
    owner_epoch: 1,
    definition_digest: definition.record.definition_digest,
    activation_id: "activation",
    state_revision: 0,
    event_cursor: null,
    state: {},
    events: [],
    page_cursor: null,
    pending_operations: [],
    capacity: { running: 0, queued: 0, remaining_allowance: 2, max_parallel: 1 },
  };
}

function fakeExecution() {
  const origins: ControllerExecutionOrigin[] = [];
  const owners: ControllerSandboxExecutionOwner[] = [];
  const scope = {
    executionId: "execution",
    supervisionId: "supervision",
    signal: new AbortController().signal,
    graceMs: 10,
    remainingTimeoutMs: () => 30_000,
    assertOpen: () => {},
  };
  const driver: ControllerExecutionDriver = {
    async runController(origin, operation) {
      origins.push(origin);
      return operation(scope);
    },
    async runControllerLifecycle<T>(
      origin: ControllerExecutionOrigin,
      owner: ControllerSandboxExecutionOwner,
      adapter: SandboxToolExecutionAdapter<T>,
    ) {
      origins.push(origin);
      owners.push(owner);
      await adapter.prepare(scope);
      await adapter.authorize();
      return {
        executionId: scope.executionId,
        normalizedStatus: 0,
        signal: "unknown" as const,
        output: {
          schemaVersion: 1 as const,
          outputRef: "00000000-0000-4000-8000-000000000000",
          capture: "complete" as const,
          stdout: { byteCount: 1, retainedVerified: true as const, sha256: "a".repeat(64) },
          stderr: { byteCount: 0, retainedVerified: true as const, sha256: "b".repeat(64) },
        },
        previews: {
          stdout: { text: "", truncated: false },
          stderr: { text: "", truncated: false },
        },
      } as T;
    },
  };
  return { driver, origins, owners };
}

function fakeRunner(input: {
  readonly loadVerifiedContext: (scope: ToolExecutionScope) => Promise<{
    readonly privateWritableRoot: string;
  }>;
}) {
  return {
    async prepare(scope: ToolExecutionScope) {
      const context = await input.loadVerifiedContext(scope);
      await mocks.onContext?.(context);
      return {};
    },
    async authorize() {},
    async settle() {
      throw new Error("fake execution settles through its durable driver");
    },
    async terminate() {
      return "confirmed" as const;
    },
    terminalEvidence() {
      return {
        category: "setup_failed" as const,
        normalized_status: null,
        signal: "unknown" as const,
        termination_requested: false,
        cleanup: "confirmed" as const,
      };
    },
  };
}
