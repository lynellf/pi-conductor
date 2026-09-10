/** Real subprocess fixture for issue #103; all logs and release files are test-owned. */
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureToolAdmission } from "../src/host/execution/tool-admission.js";
import { ToolExecutionController } from "../src/host/execution/tool-execution-controller.js";
import {
  inspectToolExecutionCleanup,
  reconcileToolExecutionCleanup,
} from "../src/host/execution/tool-execution-reconciliation.js";
import { FileRecordLog } from "../src/host/log-file.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../src/manifest/execution-policy.js";

const execFileAsync = promisify(execFile);
export const runId = "issue-103-synthetic";
export const executionId = "execution-restart";
export const operatorNote =
  "Synthetic regression fixture only: all test-owned executable processes have stopped; inspected the original namespace and partial effects. No user processes or real run logs are involved.";

export interface SleeperIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly sessionId: number;
  readonly parentPid: number;
}

export type ObserverResult =
  | {
      readonly ok: true;
      readonly observerPid: number;
      readonly executionIds: readonly string[];
      readonly processPids: readonly number[];
      readonly confirmed: boolean;
    }
  | {
      readonly ok: false;
      readonly observerPid: number;
      readonly code: unknown;
      readonly operation: unknown;
      readonly pid: unknown;
    };

/** Wait only for a fixture-owned file or identity, with an explicit deadline. */
export async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("restart fixture did not become ready or stop within 3 seconds");
}

export async function sleeperIdentity(directory: string, name: string): Promise<SleeperIdentity> {
  return until(async () => {
    try {
      return JSON.parse(await readFile(join(directory, `${name}.json`), "utf8")) as SleeperIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  });
}

/** The sleeper exits on its private release file or after a 30-second failsafe. */
export async function startSleeper(
  directory: string,
  name: string,
  inaccessible: boolean,
  marker?: string,
): Promise<SleeperIdentity> {
  const program = `
import ctypes, json, os, pathlib, sys, time
root, name, inaccessible = sys.argv[1:]
if inaccessible == "yes":
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_DUMPABLE failed")
fields = pathlib.Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()
identity = {"pid": os.getpid(), "startTime": fields[19], "sessionId": os.getsid(0), "parentPid": os.getppid()}
ready = pathlib.Path(root, name + ".json")
temporary = ready.with_suffix(".tmp")
temporary.write_text(json.dumps(identity))
temporary.rename(ready)
release = pathlib.Path(root, name + ".release")
deadline = time.monotonic() + 30
while not release.exists() and time.monotonic() < deadline:
    time.sleep(0.02)
`;
  const env = { ...process.env };
  delete env.PI_CONDUCTOR_EXECUTION_ID;
  if (marker !== undefined) env.PI_CONDUCTOR_EXECUTION_ID = marker;
  const child = spawn("python3", ["-c", program, directory, name, inaccessible ? "yes" : "no"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return sleeperIdentity(directory, name);
}

/** Release the private sleeper; never signal a PID or process group. */
export async function releaseSleeper(directory: string, name: string): Promise<void> {
  await writeFile(join(directory, `${name}.release`), "release");
  let identity: SleeperIdentity;
  try {
    identity = JSON.parse(
      await readFile(join(directory, `${name}.json`), "utf8"),
    ) as SleeperIdentity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await until(async () => {
    try {
      const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      return fields[0] === "Z" || fields[19] !== identity.startTime ? true : undefined;
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return true;
      throw error;
    }
  });
}

/** Invoked by fresh Node processes through the SDK's existing TypeScript loader. */
export async function main(mode: string, directory: string, supervisionId: string): Promise<void> {
  if (mode === "produce" || mode === "produce-descendant") {
    const log = new FileRecordLog({ baseDir: directory });
    const ids = [executionId, supervisionId];
    const controller = new ToolExecutionController({
      runId,
      logicalSessionId: "logical-restart",
      roleSessionId: "role-restart",
      policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 10 },
      persist: (record) => log.append(record),
      idFactory: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error("unexpected fixture identity allocation");
        return id;
      },
    });
    await controller.run(
      "bash",
      "call-restart",
      async () => {
        const started = log
          .records(runId)
          .find((record) => record.type === "tool_execution_started");
        if (started?.type !== "tool_execution_started" || started.admission === undefined)
          throw new Error("tool side effects admitted before durable admission evidence");
        if (mode === "produce-descendant") await startSleeper(directory, "descendant", true);
        else await execFileAsync("/bin/true");
        // Simulate the owner disappearing before its terminal record, leaving the
        // real started record on disk for an entirely new observer process.
        process.stdout.write(JSON.stringify({ producerPid: process.pid }), () => process.exit(0));
        await new Promise<never>(() => {});
      },
      { captureAdmission: captureToolAdmission },
    );
    return;
  }
  let result: ObserverResult;
  try {
    if (mode === "confirm") {
      await reconcileToolExecutionCleanup(runId, executionId, {
        baseDir: directory,
        acknowledgment: true,
        operatorNote,
      });
    }
    const inspection = await inspectToolExecutionCleanup(runId, { baseDir: directory });
    result = {
      ok: true,
      observerPid: process.pid,
      executionIds: inspection.unresolved.map((entry) => entry.executionId),
      processPids: inspection.currentProcesses.map((identity) => identity.pid),
      confirmed: mode === "confirm",
    };
  } catch (error) {
    const failure = error as { code?: unknown; operation?: unknown; pid?: unknown };
    result = {
      ok: false,
      observerPid: process.pid,
      code: failure.code,
      operation: failure.operation,
      pid: failure.pid,
    };
  }
  process.stdout.write(JSON.stringify(result));
}
