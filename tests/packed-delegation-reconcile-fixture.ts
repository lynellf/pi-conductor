import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loaderUrl, type PackedDelegationFixture } from "./packed-delegation-cleanup-fixture.js";

interface PackedInspectionEntry {
  readonly executionId: string;
  readonly toolName: string;
  readonly finishedOutcome: string | null;
  readonly currentProcesses: readonly Record<string, unknown>[];
}

interface PackedInspection {
  readonly runId: string;
  readonly unresolved: readonly PackedInspectionEntry[];
  readonly currentProcesses: readonly Record<string, unknown>[];
}

interface PackedConfirmation {
  readonly executionId: string;
  readonly supervisionId: string;
  readonly toolName: string;
  readonly cleanup: "confirmed";
}

/** Evidence returned after a fresh-process inspection and operator confirmation pass. */
export interface PackedDelegationReconciliationEvidence {
  readonly runId: string;
  readonly before: PackedInspection;
  readonly confirmations: readonly PackedConfirmation[];
  readonly after: PackedInspection;
  readonly durableConfirmationExecutionIds: readonly string[];
  readonly resumeExitReason: string;
  readonly toolStartsBeforeResume: number;
  readonly toolStartsAfterResume: number;
}

/**
 * Inspect and reconcile only the packed run's unconfirmed tool terminals.
 *
 * The helper deliberately starts a new Node process. The process first acquires
 * the run lease through the public inspection API, proves that no owner-marked
 * process is live, and only then appends explicit operator confirmations. It
 * never signals a process; a live marker fails the helper closed.
 */
export function reconcilePackedDelegationCleanup(
  fixture: PackedDelegationFixture,
  runId: string,
): PackedDelegationReconciliationEvidence {
  // The caller's process predates the run and every test-owned worker. The
  // fresh inspector uses this fixed cutoff to hide only proven older PIDs from
  // its fixture-only /proc view; it never changes production observation.
  const runnerStartTime = readProcessStartTime(process.pid);
  const probe = join(fixture.sandbox, "packed-delegation-reconcile-probe.ts");
  writeFileSync(
    probe,
    `import { inspectToolExecutionCleanup, reconcileToolExecutionCleanup } from ${JSON.stringify(`${fixture.packageRoot}/src/host/execution/tool-execution-reconciliation.ts`)};
import { resumeRun } from ${JSON.stringify(`${fixture.packageRoot}/src/host/api.ts`)};
import { ProductionHost } from ${JSON.stringify(`${fixture.packageRoot}/src/host/production-host.ts`)};
import { FileRecordLog } from ${JSON.stringify(`${fixture.packageRoot}/src/host/log-file.ts`)};
globalThis.__packedDelegationReconcileApi = { inspectToolExecutionCleanup, reconcileToolExecutionCleanup, resumeRun, ProductionHost, FileRecordLog };
export default function probe() {}
`,
    "utf8",
  );

  const script = `
const { createRequire, syncBuiltinESMExports } = await import("node:module");
const fsPromises = createRequire(import.meta.url)("node:fs/promises");
const originalReaddir = fsPromises.readdir;
const originalReadFile = fsPromises.readFile;
const runnerStartTime = BigInt(${JSON.stringify(runnerStartTime)});
const parseStartTime = (stat) => {
  const closing = stat.lastIndexOf(") ");
  if (closing < 0) throw new Error("invalid /proc stat");
  const startTime = stat.slice(closing + 2).split(" ")[19];
  if (startTime === undefined) throw new Error("invalid /proc stat fields");
  return BigInt(startTime);
};
fsPromises.readdir = async function fixtureScopedReaddir(path, ...rest) {
  const entries = await originalReaddir.call(this, path, ...rest);
  if (path !== "/proc") return entries;
  const recent = [];
  for (const entry of entries) {
    if (!/^\\d+$/.test(entry)) {
      recent.push(entry);
      continue;
    }
    let stat;
    try {
      stat = await originalReadFile.call(this, "/proc/" + entry + "/stat", "utf8");
    } catch (error) {
      const code = error?.code;
      if (code === "ENOENT" || code === "ESRCH") continue;
      throw error;
    }
    if (parseStartTime(stat) >= runnerStartTime) recent.push(entry);
  }
  return recent;
};
syncBuiltinESMExports();
const { loadExtensions } = await import(${JSON.stringify(loaderUrl(fixture))});
const loaded = await loadExtensions([
  ${JSON.stringify(`${fixture.packageRoot}/extensions/conduct.ts`)},
  ${JSON.stringify(probe)},
], ${JSON.stringify(fixture.worktree)});
if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
const api = globalThis.__packedDelegationReconcileApi;
if (api === undefined) throw new Error("packed reconciliation probe did not load");
const options = { baseDir: ${JSON.stringify(`${fixture.sandbox}/runs`)} };
const manifestPath = ${JSON.stringify(`${fixture.worktree}/.pi/conductor.yaml`)};
const { readFileSync } = await import("node:fs");
const fixturePath = ${JSON.stringify(join(fixture.worktree, "fixture.txt"))};
const fixtureBefore = readFileSync(fixturePath, "utf8");
if (fixtureBefore !== "packed delegation fixture\\n") {
  throw new Error("packed reconciliation fixture.txt baseline changed before inspection");
}
const summarize = (inspection) => ({
  runId: inspection.runId,
  unresolved: inspection.unresolved.map((entry) => ({
    executionId: entry.executionId,
    toolName: entry.toolName,
    finishedOutcome: entry.entry.finished?.outcome ?? null,
    currentProcesses: entry.currentProcesses,
  })),
  currentProcesses: inspection.currentProcesses,
});
const beforeRaw = await api.inspectToolExecutionCleanup(${JSON.stringify(runId)}, options);
const before = summarize(beforeRaw);
if (before.currentProcesses.length > 0 || before.unresolved.some((entry) => entry.currentProcesses.length > 0)) {
  throw new Error("packed reconciliation refused: owner-marked processes remain live");
}
if (before.unresolved.some((entry) => !["read", "ls", "find"].includes(entry.toolName))) {
  throw new Error("packed reconciliation refused: an unresolved non-read-only tool was found");
}
const confirmations = [];
for (const entry of before.unresolved) {
  if (entry.finishedOutcome !== "cleanup_unconfirmed") {
    throw new Error("packed reconciliation found non-confirmable execution " + entry.executionId);
  }
  const confirmed = await api.reconcileToolExecutionCleanup(${JSON.stringify(runId)}, entry.executionId, {
    ...options,
    acknowledgment: true,
    operatorNote: "Test fixture operator inspected original host and effects; all marked processes are stopped.",
  });
  confirmations.push({
    executionId: confirmed.execution_id,
    supervisionId: confirmed.supervision_id,
    toolName: confirmed.tool_name,
    cleanup: confirmed.cleanup,
  });
}
const afterRaw = await api.inspectToolExecutionCleanup(${JSON.stringify(runId)}, options);
const after = summarize(afterRaw);
const fixtureAfter = readFileSync(fixturePath, "utf8");
if (fixtureAfter !== fixtureBefore) {
  throw new Error("packed reconciliation changed fixture.txt");
}
if (after.currentProcesses.length > 0 || after.unresolved.length > 0) {
  throw new Error("packed reconciliation did not produce a clean inspection");
}
const logPath = ${JSON.stringify(`${fixture.sandbox}/runs`)} + "/" + ${JSON.stringify(runId)} + ".jsonl";
const durable = readFileSync(logPath, "utf8")
  .trim()
  .split("\\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((record) => record.type === "tool_execution_cleanup_confirmed" && confirmations.some((item) => item.executionId === record.execution_id));
const durableIds = durable.map((record) => record.execution_id);
const expectedIds = confirmations.map((item) => item.executionId);
if (durableIds.length !== expectedIds.length || new Set(durableIds).size !== expectedIds.length || expectedIds.some((id) => !durableIds.includes(id))) {
  throw new Error("packed reconciliation confirmation records were not durable");
}
const toolStartsBeforeResume = readFileSync(logPath, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.type === "tool_execution_started").length;
const { FileRecordLog } = api;
const sdk = await import(${JSON.stringify(`${fixture.piRoot}/dist/index.js`)});
const { ModelRegistry } = sdk;
const { AuthStorage } = sdk.AuthStorage === undefined ? await import(${JSON.stringify(`${fixture.piRoot}/dist/core/auth-storage.js`)}) : sdk;
const { ModelRuntime } = sdk;
const { createAssistantMessageEventStream } = await import(${JSON.stringify(`${fixture.piAiRoot}/dist/index.js`)});
const registry = typeof ModelRegistry.inMemory === "function"
  ? ModelRegistry.inMemory(AuthStorage.inMemory())
  : new ModelRegistry(await ModelRuntime.create({ authPath: ${JSON.stringify(`${fixture.sandbox}/auth.json`)}, modelsPath: null, allowModelNetwork: false }));
const models = [
  { id: "orchestrator", name: "orchestrator", api: "anthropic-messages", provider: "fixture", baseUrl: "fixture://local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 },
  { id: "child", name: "child", api: "anthropic-messages", provider: "fixture", baseUrl: "fixture://local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 },
];
registry.registerProvider("fixture", { api: "anthropic-messages", apiKey: "fixture-key", baseUrl: "fixture://local", models, streamSimple: (model) => {
  const stream = createAssistantMessageEventStream();
  const message = { role: "assistant", content: [{ type: "toolCall", id: "resume-end", name: "end", arguments: { reason: "reconciled" } }], api: "anthropic-messages", provider: "fixture", model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
  stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(message.content[0].arguments), partial: message });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
  stream.push({ type: "done", reason: "toolUse", message });
  stream.end();
  return stream;
} });
const makeHost = ({ runId: resumedRunId, log, loadedManifest }) => new api.ProductionHost({ modelRegistry: registry, cwd: ${JSON.stringify(fixture.worktree)}, runId: resumedRunId, log, loadedManifest, sessionDir: ${JSON.stringify(`${fixture.sandbox}/sessions`)}, agentDir: ${JSON.stringify(`${fixture.sandbox}/pi-agent`)} });
const resumed = await api.resumeRun(manifestPath, ${JSON.stringify(runId)}, { goal: "issue 101 reconciled", ...options, modelRegistry: registry, hostFactory: makeHost });
const resumedResult = await resumed.completion();
const toolStartsAfterResume = readFileSync(logPath, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.type === "tool_execution_started").length;
if (resumedResult.exitReason !== "done") throw new Error("packed reconciliation resume did not complete: " + resumedResult.exitReason);
if (toolStartsAfterResume !== toolStartsBeforeResume) throw new Error("reconciliation resume replayed a tool execution");
console.log(JSON.stringify({ runId: ${JSON.stringify(runId)}, before, confirmations, after, durableConfirmationExecutionIds: durableIds, resumeExitReason: resumedResult.exitReason, toolStartsBeforeResume, toolStartsAfterResume }));
`;

  const smokeNode = process.env.CONDUCTOR_SMOKE_NODE ?? process.execPath;
  const output = execFileSync(smokeNode, ["--input-type=module", "-e", script], {
    cwd: fixture.sandbox,
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      CONDUCTOR_SMOKE_NODE: smokeNode,
      CONDUCTOR_SMOKE_PI_ROOT: fixture.piRoot,
      PI_CODING_AGENT_DIR: join(fixture.sandbox, "pi-user"),
    },
  });
  const line = output.trim().split("\n").at(-1);
  if (line === undefined) throw new Error("packed reconciliation produced no JSON evidence");
  return JSON.parse(line) as PackedDelegationReconciliationEvidence;
}

function readProcessStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const closing = stat.lastIndexOf(") ");
  if (closing < 0) throw new Error("could not parse Vitest runner /proc stat");
  const startTime = stat.slice(closing + 2).split(" ")[19];
  if (startTime === undefined) throw new Error("Vitest runner /proc stat omitted start time");
  return startTime;
}
