import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";

import {
  createPackedBashFixture,
  disposePackedBashFixture,
  loaderUrl,
} from "./packed-bash-supervision-fixture.js";

interface SmokeResult {
  readonly skip?: string;
  readonly first: Invocation;
  readonly second: Invocation;
  readonly protectedPid: number;
  readonly protectedIdentityBefore: ProcessIdentity;
  readonly protectedIdentityAfter: ProcessIdentity;
  readonly injectedDelayApplied: boolean;
  readonly records: readonly RecordEntry[];
}

interface Invocation {
  readonly error?: { readonly code?: string; readonly cleanup?: string; readonly message?: string };
  readonly result?: string;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly processGroupId: number;
}

interface RecordEntry {
  readonly type?: string;
  readonly outcome?: string;
  readonly cleanup?: string;
  readonly supervision_id?: string;
}

const inaccessibleProcessScript = [
  "import ctypes, os, time",
  "if ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0: raise SystemExit(2)",
  "print(os.getpid(), flush=True)",
  "time.sleep(30)",
].join("\n");

function writePermissionProbe(fixture: ReturnType<typeof createPackedBashFixture>): void {
  writeFileSync(
    fixture.probe,
    `import { writeFileSync } from "node:fs";
import { createSupervisedTools } from ${JSON.stringify(`${fixture.packageRoot}/src/host/execution/supervised-tools.ts`)};
import { ToolExecutionController } from ${JSON.stringify(`${fixture.packageRoot}/src/host/execution/tool-execution-controller.ts`)};
import { resolveToolExecutionPolicy } from ${JSON.stringify(`${fixture.packageRoot}/src/manifest/execution-policy.ts`)};

const policy = resolveToolExecutionPolicy({ timeout_seconds: 5, max_recoverable_timeouts: 2, termination_grace_seconds: 1 });
const records = [];
const controller = new ToolExecutionController({
  runId: "packed-issue-102",
  logicalSessionId: "packed-issue-102:session",
  roleSessionId: "packed-issue-102:role",
  policy,
  persist: record => { records.push(record); writeFileSync(${JSON.stringify(fixture.state)}, JSON.stringify(records)); },
});
const tools = createSupervisedTools({ cwd: process.cwd(), declaredTools: ["bash"], getController: () => controller, getPolicy: () => policy });
const bash = tools[0];
if (!bash) throw new Error("missing packaged bash tool");
export default function probe(pi) { for (const tool of tools) pi.registerTool(tool); }
`,
  );
}

function runSmoke(fixture: ReturnType<typeof createPackedBashFixture>): SmokeResult {
  const script = `
const { createRequire, syncBuiltinESMExports } = await import("node:module");
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const fsPromises = require("node:fs/promises");
const originalSpawn = childProcess.spawn;
const originalReadFile = fsPromises.readFile;
let trackedToolPid;
let delayedToolStat = false;
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  const command = typeof args[0] === "string" ? args[0] : "";
  if (command.includes("date") && trackedToolPid === undefined) trackedToolPid = child.pid;
  return child;
};
fsPromises.readFile = async (...args) => {
  const path = String(args[0]);
  if (trackedToolPid !== undefined && !delayedToolStat && path === "/proc/" + trackedToolPid + "/stat") {
    delayedToolStat = true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return originalReadFile(...args);
};
syncBuiltinESMExports();
const { loadExtensions } = await import(${JSON.stringify(loaderUrl(fixture))});
const loaded = await loadExtensions([${JSON.stringify(`${fixture.packageRoot}/extensions/conduct.ts`)}, ${JSON.stringify(fixture.probe)}], ${JSON.stringify(fixture.sandbox)});
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
const tool = loaded.extensions[1]?.tools.get("bash")?.definition;
if (!tool) throw new Error("missing packaged bash tool");
const { spawn } = await import("node:child_process");
const { readFile } = await import("node:fs/promises");
const { readFileSync } = await import("node:fs");
const protectedScript = ${JSON.stringify(inaccessibleProcessScript)};
function identity(pid) {
  const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
  const closing = stat.lastIndexOf(") ");
  const fields = stat.slice(closing + 2).split(" ");
  return { pid, startTime: fields[19], processGroupId: Number(fields[2]) };
}
function inaccessible(pid) { return readFile("/proc/" + pid + "/environ", "utf8").then(() => false, error => error?.code === "EACCES"); }
function output(value) { return value.content.map(part => part.type === "text" ? part.text : "").join(""); }
let invocationCount = 0;
async function invoke(command) {
  try {
    invocationCount += 1;
    const value = await tool.execute("packed-issue-102-" + invocationCount, { command }, undefined, undefined, { model: undefined, sessionManager: { getSessionId: () => "packed-issue-102", getSessionFile: () => undefined } });
    return { result: output(value) };
  } catch (error) { return { error: { code: error?.code, cleanup: error?.cleanup, message: error?.message } }; }
}
let protectedChild;
let result;
try {
  try { protectedChild = spawn("python3", ["-c", protectedScript], { stdio: ["ignore", "pipe", "ignore"] }); }
  catch (error) { result = { skip: "python3 unavailable: " + (error?.message ?? "spawn failed") }; }
  if (result === undefined && protectedChild.stdout === null) result = { skip: "python3 stdout unavailable" };
  const pid = result === undefined ? await new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), 3_000);
    protectedChild.stdout.once("data", chunk => { clearTimeout(timer); resolve(Number(String(chunk).trim())); });
    protectedChild.once("error", () => { clearTimeout(timer); resolve(undefined); });
    protectedChild.once("close", () => { clearTimeout(timer); resolve(undefined); });
  }) : undefined;
  if (result === undefined && (typeof pid !== "number" || !Number.isInteger(pid))) result = { skip: "protected fixture did not report a PID" };
  if (result === undefined && !(await inaccessible(pid))) result = { skip: "kernel did not expose protected /proc/environ as EACCES" };
  if (result === undefined) {
    const before = identity(pid);
    const first = await invoke("date -u +%Y-%m-%dT%H:%M:%S.%3NZ");
    const second = await invoke("date -u +%Y-%m-%dT%H:%M:%S.%3NZ");
    result = { first, second, protectedPid: pid, protectedIdentityBefore: before, protectedIdentityAfter: identity(pid), injectedDelayApplied: delayedToolStat, records: JSON.parse(readFileSync(${JSON.stringify(fixture.state)}, "utf8")) };
  }
} finally { if (protectedChild !== undefined && protectedChild.exitCode === null && protectedChild.signalCode === null) protectedChild.kill("SIGKILL"); }
console.log(JSON.stringify(result));
`;
  const output = execFileSync(
    process.env.CONDUCTOR_SMOKE_NODE ?? process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: fixture.sandbox,
      encoding: "utf8",
      timeout: 120_000,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: `${fixture.sandbox}/pi-user`,
        CONDUCTOR_SMOKE_RECORDS: fixture.state,
      },
    },
  );
  const line = output.trim().split("\n").at(-1);
  if (line === undefined) throw new Error("packed issue-102 smoke produced no JSON output");
  return JSON.parse(line) as SmokeResult;
}

it("packed fast foreground date survives an unrelated protected same-UID process", async ({
  skip,
}) => {
  if (process.platform !== "linux") skip("issue 102 requires Linux /proc semantics");
  const fixture = createPackedBashFixture();
  try {
    writePermissionProbe(fixture);
    const smoke = runSmoke(fixture);
    if (smoke.skip !== undefined) {
      skip(smoke.skip);
      return;
    }
    expect(smoke.first.error).toBeUndefined();
    expect(smoke.first.result).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(smoke.second.error).toBeUndefined();
    expect(smoke.second.result).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(smoke.protectedIdentityAfter).toEqual(smoke.protectedIdentityBefore);
    expect(smoke.injectedDelayApplied).toBe(true);
    const finished = smoke.records.filter((record) => record.type === "tool_execution_finished");
    expect(finished).toHaveLength(2);
    expect(
      finished.every((record) => record.outcome === "completed" && record.cleanup === "confirmed"),
    ).toBe(true);
    expect(finished.some((record) => record.outcome === "cleanup_unconfirmed")).toBe(false);
  } finally {
    disposePackedBashFixture(fixture);
  }
}, 180_000);
