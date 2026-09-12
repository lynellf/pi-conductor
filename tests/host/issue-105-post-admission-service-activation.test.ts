/** Issue #105: a post-admission protected service-shaped process remains unresolved. */
import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { runSupervisedProcess } from "../../src/host/execution/supervised-process.js";
import { captureToolAdmission } from "../../src/host/execution/tool-admission.js";

interface FixtureIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly sessionId: number;
  readonly uid: number;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await wait(10);
    }
  }
  throw new Error(`fixture did not create ${path}`);
}

async function readIdentity(path: string): Promise<FixtureIdentity> {
  await waitForFile(path);
  return JSON.parse(await readFile(path, "utf8")) as FixtureIdentity;
}

function fixtureManagerSource(): string {
  return [
    "import ctypes, json, os, pathlib, socket, sys, time",
    "root = pathlib.Path(sys.argv[1])",
    "socket_path = root / 'manager.sock'",
    "server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
    "server.bind(str(socket_path))",
    "server.listen(1)",
    "(root / 'manager-ready').write_text('ready')",
    "connection, _ = server.accept()",
    "connection.recv(1)",
    "child = os.fork()",
    "if child == 0:",
    "    connection.close()",
    "    server.close()",
    "    os.setsid()",
    "    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0: raise OSError(ctypes.get_errno(), 'PR_SET_DUMPABLE failed')",
    "    fields = pathlib.Path('/proc/self/stat').read_text().rsplit(') ', 1)[1].split()",
    "    identity = {'pid': os.getpid(), 'startTime': fields[19], 'sessionId': os.getsid(0), 'uid': os.getuid()}",
    "    temporary = root / 'protected.tmp'",
    "    temporary.write_text(json.dumps(identity))",
    "    temporary.rename(root / 'protected.json')",
    "    deadline = time.monotonic() + 30",
    "    while not (root / 'release').exists() and time.monotonic() < deadline: time.sleep(0.02)",
    "    os._exit(0)",
    "connection.close()",
    "server.close()",
    "deadline = time.monotonic() + 30",
    "while not (root / 'release').exists() and time.monotonic() < deadline: time.sleep(0.02)",
    "os.waitpid(child, 0)",
  ].join("\n");
}

async function startFixtureManager(directory: string): Promise<ChildProcess> {
  const manager = spawn("python3", ["-c", fixtureManagerSource(), directory], {
    stdio: "ignore",
  });
  try {
    await new Promise<void>((resolve, reject) => {
      manager.once("spawn", resolve);
      manager.once("error", reject);
    });
    await waitForFile(join(directory, "manager-ready"));
    return manager;
  } catch (error) {
    if (manager.exitCode === null && manager.signalCode === null) manager.kill("SIGTERM");
    throw error;
  }
}

async function environmentIsDenied(pid: number): Promise<boolean> {
  try {
    await readFile(`/proc/${pid}/environ`, "utf8");
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EACCES";
  }
}

async function releaseFixture(directory: string, manager: ChildProcess | undefined): Promise<void> {
  await writeFile(join(directory, "release"), "release");
  if (manager !== undefined && manager.exitCode === null && manager.signalCode === null) {
    const closed = new Promise<void>((resolve) => manager.once("close", () => resolve()));
    const settled = await Promise.race([closed.then(() => true), wait(1_000).then(() => false)]);
    if (!settled && manager.exitCode === null && manager.signalCode === null) {
      manager.kill("SIGTERM");
      await Promise.race([closed, wait(1_000)]);
    }
  }
}

async function waitForGone(identity: FixtureIdentity): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      if (fields[0] === "Z" || fields[19] !== identity.startTime) return;
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await wait(20);
  }
  throw new Error(`fixture-owned protected process ${identity.pid} did not stop`);
}

it("fails closed when a socket manager starts a protected same-UID session after admission", async ({
  skip,
}) => {
  if (process.platform !== "linux") skip("issue #105 requires Linux procfs semantics");
  const directory = await mkdtemp("/tmp/pi-conductor-issue-105-");
  let manager: ChildProcess | undefined;
  let protectedIdentity: FixtureIdentity | undefined;
  let settled: Promise<unknown> | undefined;
  const abort = new AbortController();
  try {
    try {
      manager = await startFixtureManager(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        skip("python3 fixture unavailable");
        return;
      }
      throw error;
    }
    const socketPath = join(directory, "manager.sock");
    const protectedPath = join(directory, "protected.json");
    const client = [
      "const net=require('node:net'),fs=require('node:fs');",
      `const socket=net.createConnection(${JSON.stringify(socketPath)});`,
      "socket.on('error',()=>undefined);",
      "socket.once('connect',()=>socket.end('start'));",
      "socket.once('close',()=>{const deadline=Date.now()+2000;const poll=()=>{if(fs.existsSync(process.argv[1])){console.log('foreground-complete');process.exit(0)}if(Date.now()>=deadline)process.exit(2);setTimeout(poll,10)};poll();});",
    ].join("");
    let admissionCutoff: string | undefined;
    let output = "";
    const execution = runSupervisedProcess({
      executionId: `issue-105-service-activation-${process.pid}`,
      file: process.execPath,
      args: ["-e", client, protectedPath],
      cwd: directory,
      timeoutMs: 10_000,
      graceMs: 50,
      signal: abort.signal,
      onStart: async () => {
        admissionCutoff = (await captureToolAdmission()).preexisting_before;
        await wait(20);
      },
      onOutput: (_stream, chunk) => {
        output += chunk.toString("utf8");
      },
    });
    settled = execution.then(
      () => new Error("fixture tool unexpectedly completed"),
      (error: unknown) => error,
    );
    protectedIdentity = await readIdentity(protectedPath);
    if (!(await environmentIsDenied(protectedIdentity.pid))) {
      await settled;
      skip("kernel did not expose the fixture environment as EACCES");
      return;
    }
    const failure = await settled;
    expect(failure).toMatchObject({
      code: "supervised-process-spawn-failed",
      cleanup: "unconfirmed",
      diagnostic: {
        cleanup_cause: "cleanup_observation_failed",
        observation_error: {
          operation: "read_environ",
          code: "EACCES",
          pid: protectedIdentity.pid,
          start_time: protectedIdentity.startTime,
        },
      },
    });
    expect(output).toContain("foreground-complete");
    expect(protectedIdentity.sessionId).toBe(protectedIdentity.pid);
    expect(protectedIdentity.uid).toBe(process.getuid?.());
    expect(admissionCutoff).toBeDefined();
    expect(BigInt(protectedIdentity.startTime)).toBeGreaterThan(BigInt(admissionCutoff ?? "0"));
  } finally {
    abort.abort();
    await settled;
    await releaseFixture(directory, manager);
    if (protectedIdentity !== undefined) await waitForGone(protectedIdentity);
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
