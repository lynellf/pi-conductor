/** Real CLI smoke for the approved executable-controller example (issue #115 §7). */
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryRuntimeTree } from "../../src/host/execution/sandbox/runtime-files.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { preparedRuntimeInventoryDigest } from "../../src/persistence/sandbox-runtime.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import {
  createRealDelegationFixture,
  type RealDelegationFixture,
} from "./fixtures/bubblewrap-delegation-fixture.js";

const execute = promisify(execFile);
const fixtures: RealDelegationFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

describe("approved executable-controller Bubblewrap example", () => {
  it("runs preparation through native delegation, validation, read receipt, and finish via the built CLI", async () => {
    const fixture = await createRealDelegationFixture();
    fixtures.push(fixture);
    const runtime = join(fixture.root, "controller-runtime");
    await createControllerRuntime(join(fixture.checkout, ".pi/runtime"), runtime);
    const approvals = await writeApprovals(fixture, runtime);
    await copyExamples(fixture.checkout);
    await mkdir(join(fixture.root, "runs"), { recursive: true, mode: 0o700 });
    await chmod(join(fixture.root, "runs"), 0o700);

    const result = await runBuiltCli(fixture, approvals);
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, exits: [] });
    expect(result.exits).toEqual([]);
    expect(result.providerCalls).toBe(2);
    expect(result.sawHostArtifactContext).toBe(true);
    const cli = result.cli as { run_id: string; exit_reason: string };
    expect(cli.exit_reason).toBe("done");

    const records = new FileRecordLog({ baseDir: join(fixture.root, "runs") }).records(cli.run_id);
    const completed = records.filter(
      (record) => record.type === "controller_action_receipt" && record.outcome === "completed",
    );
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action_id: "prepare", outcome: "completed" }),
        expect.objectContaining({ action_id: "work", outcome: "completed" }),
        expect.objectContaining({ action_id: "validate", outcome: "completed" }),
        expect.objectContaining({ action_id: "read-validation", outcome: "completed" }),
      ]),
    );
    const validation = completed.find(
      (record) => record.type === "controller_action_receipt" && record.action_id === "validate",
    );
    const read = completed.find(
      (record) =>
        record.type === "controller_action_receipt" && record.action_id === "read-validation",
    );
    expect(validation).toMatchObject({ result_refs: [expect.stringMatching(/^artifact\/v1\//)] });
    expect(read).toMatchObject({
      result: {
        source_ref:
          validation?.type === "controller_action_receipt" ? validation.result_refs[0] : "",
      },
    });
    const worker = records.find((record) => record.type === "subagent_completed");
    expect(worker).toMatchObject({
      status: "completed",
      summary: expect.stringContaining("packet received"),
    });
    expect(
      records.filter(
        (record) => record.type === "tool_execution_started" && record.schema_version === 2,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: expect.objectContaining({ operation_kind: "preparation" }),
        }),
        expect.objectContaining({ origin: expect.objectContaining({ operation_kind: "planner" }) }),
        expect.objectContaining({ origin: expect.objectContaining({ operation_kind: "adapter" }) }),
      ]),
    );
  }, 90_000);
});

async function copyExamples(checkout: string): Promise<void> {
  const source = join(process.cwd(), "examples", "controller");
  await copyFile(join(source, "worker-output.txt"), join(checkout, "worker-output.txt"));
  await copyFile(join(source, "worker.md"), join(checkout, "worker.md"));
  await copyFile(join(source, "manifest.yaml"), join(checkout, "controller-example.yaml"));
  await execute(
    "/usr/bin/git",
    [
      "-C",
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "add",
      "controller-example.yaml",
      "worker-output.txt",
      "worker.md",
    ],
    { env: { LANG: "C", PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" } },
  );
  await execute(
    "/usr/bin/git",
    [
      "-C",
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "controller example",
    ],
    { env: { LANG: "C", PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" } },
  );
  await chmod(join(checkout, ".git", "index"), 0o600);
}

async function createControllerRuntime(nativeRuntime: string, destination: string): Promise<void> {
  await copyTree(nativeRuntime, destination);
  const node = await realpath(process.execPath);
  await copyRuntimeFile(node, join(destination, "usr/bin/node"), 0o700);
  for (const library of await nodeLibraries(node))
    await copyRuntimeFile(library, join(destination, library.slice(1)), 0o700);
  const source = join(process.cwd(), "examples", "controller");
  await copyRuntimeFile(
    join(source, "planner.mjs"),
    join(destination, "opt/pi-conductor-example/planner.mjs"),
    0o600,
  );
  await copyRuntimeFile(
    join(source, "adapter.mjs"),
    join(destination, "opt/pi-conductor-example/adapter.mjs"),
    0o600,
  );
}

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyRuntimeFile(from, to, 0o700);
    else throw new Error(`unsupported runtime entry '${entry.name}'`);
  }
}

async function copyRuntimeFile(source: string, destination: string, mode: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, mode);
}

async function nodeLibraries(node: string): Promise<readonly string[]> {
  const { stdout } = await execute("/usr/bin/ldd", [node], { env: { LANG: "C" } });
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /=>\s+(\/\S+)/u.exec(line) ?? /^\s*(\/\S+)\s+\(/u.exec(line);
    if (match?.[1] !== undefined) paths.add(match[1]);
  }
  if (paths.size === 0) throw new Error("ldd did not report Node runtime libraries");
  return [...paths].sort();
}

async function writeApprovals(fixture: RealDelegationFixture, runtime: string) {
  const inventory = await inventoryRuntimeTree(runtime);
  const files = inventory
    .filter(
      (entry): entry is Extract<(typeof inventory)[number], { readonly type: "file" }> =>
        entry.type === "file",
    )
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const inputSchema = adapterInputSchema();
  const outputSchema = packetSchema();
  const adapters = ["prepare", "validate"].map((id) => ({
    id,
    runtime_id: "controller-example-v1",
    executable: "/usr/bin/node",
    argv: ["/opt/pi-conductor-example/adapter.mjs"],
    input_schema_id: "adapter-input-v1",
    output_schema_id: "packet-v1",
    capability: "private_staging" as const,
  }));
  const controllerApproval = {
    schema_version: 1,
    approval_id: "controller-example-approval",
    runtimes: [
      {
        runtime_id: "controller-example-v1",
        source_root: runtime,
        inventory_sha256: preparedRuntimeInventoryDigest(inventory),
        bootstrap_approval: { approvalId: "controller-example-runtime", files },
      },
    ],
    controllers: [
      {
        controller_id: "packet-controller",
        runtime_id: "controller-example-v1",
        executable: "/usr/bin/node",
        argv: ["/opt/pi-conductor-example/planner.mjs"],
      },
    ],
    adapters,
    schemas: [
      {
        schema_id: "adapter-input-v1",
        schema_digest: sha256Canonical(inputSchema),
        schema: inputSchema,
      },
      {
        schema_id: "packet-v1",
        schema_digest: sha256Canonical(outputSchema),
        schema: outputSchema,
      },
    ],
  };
  const sandbox = join(fixture.root, "sandbox-approval.json");
  const controller = join(fixture.root, "controller-approval.json");
  await writePrivateJson(sandbox, fixture.hostApproval);
  await writePrivateJson(controller, controllerApproval);
  return { sandbox: `../${basename(sandbox)}`, controller: `../${basename(controller)}` };
}

function adapterInputSchema() {
  return Type.Object(
    {
      protocol_version: Type.Literal(1),
      run_id: Type.String({ minLength: 1 }),
      controller_id: Type.String({ minLength: 1 }),
      definition_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      action_id: Type.String({ minLength: 1, maxLength: 128 }),
      input_refs: Type.Array(
        Type.Object(
          { ref: Type.String({ minLength: 1, maxLength: 256 }), value: Type.Unknown() },
          { additionalProperties: false },
        ),
        { maxItems: 64 },
      ),
    },
    { additionalProperties: false },
  );
}

function packetSchema() {
  return Type.Object(
    {
      packet: Type.Literal("prepared"),
      stage: Type.Union([Type.Literal("prepare"), Type.Literal("validated")]),
      native_status: Type.Optional(Type.Literal("completed")),
    },
    { additionalProperties: false },
  );
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function runBuiltCli(
  fixture: RealDelegationFixture,
  approvals: { readonly sandbox: string; readonly controller: string },
): Promise<{
  readonly code: number;
  readonly exits: readonly number[];
  readonly providerCalls: number;
  readonly sawHostArtifactContext: boolean;
  readonly cli: unknown;
}> {
  const root = process.cwd();
  const script = join(fixture.root, "run-controller-example.mjs");
  const values = {
    conduct: join(root, "dist/bin/conduct.js"),
    api: join(root, "dist/host/api.js"),
    log: join(root, "dist/host/log-file.js"),
    stub: join(root, "dist/host/stub-provider.js"),
    sdk: join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    cwd: fixture.checkout,
    sandbox: approvals.sandbox,
    controller: approvals.controller,
    manifest: join(fixture.checkout, "controller-example.yaml"),
  };
  await writeFile(
    script,
    `
import { AuthStorage, ModelRegistry } from ${JSON.stringify(values.sdk)};
import { Console } from "node:console";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { runCli } from ${JSON.stringify(values.conduct)};
import { startRun } from ${JSON.stringify(values.api)};
import { FileRecordLog } from ${JSON.stringify(values.log)};
import { makeStubModel, makeStubStreamFunction } from ${JSON.stringify(values.stub)};
const model = makeStubModel();
let providerCalls = 0;
let sawHostArtifactContext = false;
const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
registry.registerProvider("stub", {
  api: "anthropic-messages",
  apiKey: "stub-dummy-key-not-used",
  baseUrl: model.baseUrl,
  streamSimple: makeStubStreamFunction({
    steps: [
      {
        kind: "emit_tool_calls",
        calls: [{ name: "write", arguments: { path: "worker-output.txt", content: "packet received\\n" } }],
      },
      { kind: "emit_text", text: "packet received" },
    ],
    onRequest: (context) => {
      providerCalls += 1;
      const systemPrompt = context !== null && typeof context === "object" && "systemPrompt" in context
        ? context.systemPrompt
        : undefined;
      sawHostArtifactContext ||= typeof systemPrompt === "string" &&
        systemPrompt.includes('"source":"host_artifact"') && systemPrompt.includes("prepared");
    },
  }),
  models: [{ ...model, id: "worker", name: "worker" }],
});
const exits = [];
const output = [];
const diagnostics = [];
const stdout = new Writable({ write: (chunk, _encoding, done) => { output.push(String(chunk)); done(); } });
const diagnostic = new Writable({ write: (chunk, _encoding, done) => { diagnostics.push(String(chunk)); done(); } });
const code = await runCli([
  "--non-interactive", "--json", "--log-dir", "../runs",
  "--sandbox-approval", ${JSON.stringify(values.sandbox)},
  "--controller-approval", ${JSON.stringify(values.controller)},
  ${JSON.stringify(values.manifest)}, "exercise", "the", "approved", "controller",
], {
  startRun,
  modelRegistry: registry,
  console: new Console({ stdout: diagnostic, stderr: diagnostic }),
  exit: (status) => exits.push(status),
  cwd: ${JSON.stringify(values.cwd)},
  stdout,
});
if (output.join("").trim().length === 0) throw new Error(JSON.stringify({ code, exits, diagnostics }));
const cli = JSON.parse(output.join(""));
const records = new FileRecordLog({ baseDir: ${JSON.stringify(join(fixture.root, "runs"))} }).records(cli.run_id);
const failed = records.find((record) => record.type === "session_failed");
const audit = failed?.type === "session_failed" ? (await readFile(failed.session_file, "utf8")).slice(-8192) : "";
process.stdout.write(JSON.stringify({
  marker: "controller-example", code, exits, providerCalls, sawHostArtifactContext,
  messages: diagnostics.join(""), cli, tail: records.slice(-12), audit,
}) + "\\n");
`,
    { mode: 0o600 },
  );
  const result = await execute(process.execPath, [script], {
    cwd: fixture.checkout,
    env: {
      ...process.env,
      PI_PACKAGE_DIR: join(root, "node_modules/@earendil-works/pi-coding-agent"),
    },
    maxBuffer: 2 * 1024 * 1024,
  });
  const lines = result.stdout.trim().split("\n");
  const marker = lines.pop();
  if (marker === undefined) throw new Error(`built CLI emitted no result: ${result.stderr}`);
  return JSON.parse(marker) as Awaited<ReturnType<typeof runBuiltCli>>;
}
