import { execFileSync } from "node:child_process";
import {
  type createPackedDelegationFixture,
  loaderUrl,
  writePackedDelegationProbe,
} from "./packed-delegation-cleanup-fixture.js";

export interface ProbeResult {
  readonly runId: string;
  readonly records: readonly Record<string, unknown>[];
  readonly resumeError?: string;
  readonly probeError?: string;
  readonly exitReason?: string;
  readonly leaseReleased?: boolean;
}

export function runProbe(
  fixture: ReturnType<typeof createPackedDelegationFixture>,
  inject = true,
): ProbeResult {
  writePackedDelegationProbe(fixture);
  const script = `
const { loadExtensions } = await import(${JSON.stringify(loaderUrl(fixture))});
const loaded = await loadExtensions([${JSON.stringify(`${fixture.packageRoot}/extensions/conduct.ts`)}, ${JSON.stringify(fixture.probe)}], ${JSON.stringify(fixture.worktree)});
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
const sdk = await import(${JSON.stringify(`${fixture.piRoot}/dist/index.js`)});
const { ModelRegistry } = sdk;
const { AuthStorage } = sdk.AuthStorage === undefined ? await import(${JSON.stringify(`${fixture.piRoot}/dist/core/auth-storage.js`)}) : sdk;
const { ModelRuntime } = sdk;
const { createAssistantMessageEventStream } = await import(${JSON.stringify(`${fixture.piAiRoot}/dist/index.js`)});
const { startRun, resumeRun, ProductionHost, FileRecordLog } = globalThis.__packedDelegationApi;
const { readFileSync, readdirSync } = await import("node:fs");
const registry = typeof ModelRegistry.inMemory === "function"
  ? ModelRegistry.inMemory(AuthStorage.inMemory())
  : new ModelRegistry(await ModelRuntime.create({ authPath: ${JSON.stringify(`${fixture.sandbox}/auth.json`)}, modelsPath: null, allowModelNetwork: false }));
const models = new Map([
  ["orchestrator", { id: "orchestrator", name: "orchestrator", api: "anthropic-messages", provider: "fixture", baseUrl: "fixture://local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 }],
  ["child", { id: "child", name: "child", api: "anthropic-messages", provider: "fixture", baseUrl: "fixture://local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 }],
]);
registry.registerProvider("fixture", { api: "anthropic-messages", apiKey: "fixture-key", baseUrl: "fixture://local", models: [...models.values()], streamSimple: (model, context, options) => {
  const stream = createAssistantMessageEventStream();
  const key = model.id;
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const hasDelegateResult = messages.some(
    message => message.role === "toolResult" && message.toolName === "delegate",
  );
  const hasEndResult = messages.some(
    message => message.role === "toolResult" && message.toolName === "end",
  );
  const hasEndEmission = messages.some(
    message =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(part => part.type === "toolCall" && part.name === "end"),
  );
  const hasFileToolResult = messages.some(
    message =>
      message.role === "toolResult" && ["read", "ls", "find"].includes(message.toolName),
  );
  const childHasToolResult = hasFileToolResult;
  const message = { role: "assistant", content: [], api: "anthropic-messages", provider: "fixture", model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() };
  if (key === "orchestrator" && !hasDelegateResult) {
    message.content = [{ type: "toolCall", id: "delegate-1", name: "delegate", arguments: { tasks: [
      { id: "read-child", subagent: "child", objective: "read", expected_output: "done" },
      { id: "ls-child", subagent: "child", objective: "list", expected_output: "done" },
      { id: "find-child", subagent: "child", objective: "find", expected_output: "done" },
    ] } }];
  } else if (key === "orchestrator" && !hasEndResult && !hasEndEmission) {
    message.content = [{ type: "toolCall", id: "end-1", name: "end", arguments: { reason: "delegation settled" } }];
  } else if (key === "child" && !childHasToolResult) {
    message.content = [
      { type: "toolCall", id: "read", name: "read", arguments: { path: "fixture.txt" } },
      { type: "toolCall", id: "ls", name: "ls", arguments: { path: "." } },
      { type: "toolCall", id: "find", name: "find", arguments: { path: ".", pattern: "*.txt" } },
    ];
  } else {
    message.content = [{ type: "text", text: "done" }];
    message.stopReason = "stop";
  }
  setTimeout(() => {
    if (options?.signal?.aborted) {
      message.content = [];
      message.stopReason = "aborted";
      stream.push({ type: "error", reason: "aborted", error: message });
      stream.end();
      return;
    }
    stream.push({ type: "start", partial: message });
  for (let index = 0; index < message.content.length; index += 1) {
    const call = message.content[index];
    if (call.type !== "toolCall") continue;
    stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
    stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: message });
    stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: message });
  }
  stream.push({ type: "done", reason: message.stopReason === "stop" ? "stop" : "toolUse", message });
    stream.end();
  }, 0);
  return stream;
} });
const manifestPath = ${JSON.stringify(`${fixture.worktree}/.pi/conductor.yaml`)};
const makeHost = ({ runId, log, loadedManifest }) => new ProductionHost({ modelRegistry: registry, cwd: ${JSON.stringify(fixture.worktree)}, runId, log, loadedManifest, sessionDir: ${JSON.stringify(`${fixture.sandbox}/sessions`)}, agentDir: ${JSON.stringify(`${fixture.sandbox}/pi-agent`)} });
let handle;
let completed;
let probeTimer;
try {
  completed = await Promise.race([
    (async () => {
      handle = await startRun(manifestPath, { goal: "issue 101", baseDir: ${JSON.stringify(`${fixture.sandbox}/runs`)}, modelRegistry: registry, hostFactory: makeHost });
      return handle.completion();
    })(),
    new Promise((_, reject) => {
      probeTimer = setTimeout(() => reject(new Error("probe completion timeout")), 20_000);
    }),
  ]);
  clearTimeout(probeTimer);
} catch (error) {
  clearTimeout(probeTimer);
  const files = readdirSync(${JSON.stringify(`${fixture.sandbox}/runs`)});
  const file = files.find(name => name.endsWith(".jsonl"));
  const records = file === undefined ? [] : readFileSync(${JSON.stringify(`${fixture.sandbox}/runs`)} + "/" + file, "utf8").trim().split("\\n").filter(Boolean).map(line => JSON.parse(line));
  const summary = records.map(record => ({
    type: record.type,
    tool_name: record.tool_name,
    outcome: record.outcome,
    cleanup: record.cleanup,
    child_id: record.child_id,
    status: record.status,
    failure_reason: record.failure_reason,
  }));
  const runId = records.find(record => typeof record.run_id === "string")?.run_id;
  let resumeError;
  if (runId !== undefined) {
    try {
      await resumeRun(manifestPath, runId, { goal: "issue 101", baseDir: ${JSON.stringify(`${fixture.sandbox}/runs`)}, modelRegistry: registry, hostFactory: makeHost });
    } catch (resumeFailure) {
      resumeError = resumeFailure instanceof Error ? resumeFailure.message : String(resumeFailure);
    }
  }
  console.log(JSON.stringify({ runId, resumeError, probeError: error instanceof Error ? error.message : String(error), records: summary, files }));
  process.exit(2);
}
const file = readdirSync(${JSON.stringify(`${fixture.sandbox}/runs`)}).find(name => name.endsWith(".jsonl"));
if (!file) throw new Error("run log missing");
const records = readFileSync(${JSON.stringify(`${fixture.sandbox}/runs`)} + "/" + file, "utf8").trim().split("\\n").map(line => JSON.parse(line));
let resumeError;
let leaseReleased = false;
const leaseProbe = new FileRecordLog({ baseDir: ${JSON.stringify(`${fixture.sandbox}/runs`)} });
const probeLease = await leaseProbe.acquireRunLease(completed.finalCheckpoint.run_id);
await probeLease.release();
leaseReleased = true;
if (${inject ? "true" : "false"}) {
  try {
    await resumeRun(manifestPath, completed.finalCheckpoint.run_id, { goal: "issue 101", baseDir: ${JSON.stringify(`${fixture.sandbox}/runs`)}, modelRegistry: registry, hostFactory: makeHost });
  } catch (resumeFailure) {
    resumeError = resumeFailure instanceof Error ? resumeFailure.message : String(resumeFailure);
  }
}
console.log(JSON.stringify({ runId: completed.finalCheckpoint.run_id, exitReason: completed.exitReason, resumeError, leaseReleased, records }));
`;
  let output: string;
  try {
    output = execFileSync(
      process.env.CONDUCTOR_SMOKE_NODE ?? process.execPath,
      ["--input-type=module", ...(inject ? ["--require", fixture.preload] : []), "-e", script],
      {
        cwd: fixture.sandbox,
        encoding: "utf8",
        timeout: 60_000,
        killSignal: "SIGKILL",
        env: { ...process.env, PI_CODING_AGENT_DIR: `${fixture.sandbox}/pi-user` },
      },
    );
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? error.stdout : "";
    output = typeof stdout === "string" ? stdout : Buffer.isBuffer(stdout) ? stdout.toString() : "";
  }
  const line = output.trim().split("\n").at(-1);
  if (line === undefined) throw new Error("packed delegation probe produced no JSON");
  return JSON.parse(line) as ProbeResult;
}
