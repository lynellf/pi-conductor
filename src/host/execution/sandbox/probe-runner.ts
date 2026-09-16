/** Execute only the approved inert probe through the production mount policy (#106 §5).
 * The shared probe/cleanup arbitration stays together to keep late authorization fenced;
 * filesystem publication helpers and pipe parsing remain separate boundaries.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { SandboxAdmissionRecord } from "../../../persistence/sandbox-admission.js";
import {
  parseSandboxCapabilityProbeReport,
  SANDBOX_CAPABILITY_PROBE_PATH,
  type SandboxCapabilityProbeReport,
} from "../../../persistence/sandbox-probe.js";
import type { SandboxProcessObservation } from "../../../persistence/sandbox-process.js";
import { readSandboxAdmission } from "./admission-store.js";
import { BUBBLEWRAP_BOOTSTRAP_SOURCE } from "./bootstrap.js";
import { buildSandboxMountPlan, type SandboxWritableMount } from "./mount-plan.js";
import { collectBubblewrapStaticObservation } from "./observation.js";
import {
  assessBubblewrapStaticPrerequisites,
  type HostApprovedBubblewrapBuild,
} from "./prerequisites.js";
import { assertSandboxProbeMounts } from "./probe-mounts.js";
import { captureProbePipes } from "./probe-pipes.js";
import {
  classifySandboxProcess,
  observeSandboxProcess,
  verifyFinalSandboxNamespaces,
} from "./process-observation.js";
import { canonicalTrustedSnapshotParent } from "./runtime-capture.js";
import type { HostApprovedBootstrapRuntime, PreparedRuntimeDescriptor } from "./runtime-types.js";

/** Explicit host-owned approvals and an already persisted private admission. */
export interface SandboxCapabilityProbeOptions {
  readonly binaryPath: string;
  readonly approvedBuilds: readonly HostApprovedBubblewrapBuild[];
  readonly getcapPath?: string;
  readonly admission: SandboxAdmissionRecord;
  readonly bootstrapApproval: HostApprovedBootstrapRuntime;
  readonly probeApproval: { readonly approvalId: string; readonly sha256: string };
  readonly runStateDir: string;
  readonly timeoutMs?: number;
  /** Deterministic pre-persistence fault injection; production callers omit it. */
  readonly testHookBeforeReadyPersistence?: (observation: {
    readonly final: SandboxProcessObservation;
    readonly artifactPath: string;
  }) => Promise<void>;
}

/** Successful fixed-probe evidence and its retained private artifact location. */
export interface SandboxCapabilityProbeResult {
  readonly report: SandboxCapabilityProbeReport;
  readonly final: SandboxProcessObservation;
  readonly artifactPath: string;
}

/** Cleanup certainty for a failed fixed probe; retained evidence is private host data. */
export class SandboxCapabilityProbeError extends Error {
  constructor(
    message: string,
    readonly cleanup: "confirmed" | "unconfirmed",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxCapabilityProbeError";
  }
}

/** Run the fixed probe; failures retain private evidence and never admit user code. */
export async function runSandboxCapabilityProbe(
  options: SandboxCapabilityProbeOptions,
): Promise<SandboxCapabilityProbeResult> {
  const admission = await readSandboxAdmission({
    runStateDir: options.runStateDir,
    expectedRunId: options.admission.runId,
    expectedChildId: options.admission.childId,
    expectedSandbox: options.admission.sandbox,
    bootstrapApproval: options.bootstrapApproval,
  });
  return runVerifiedSandboxCapabilityProbe({
    ...options,
    loadVerifiedContext: async () => ({
      runtime: admission.runtime,
      writableRoots: admission.policy.writableRoots,
      environment: admission.policy.execution.environment,
      artifactParent: join(options.runStateDir, "sandboxes", admission.sandbox.materialization_id),
      owner: admission.sandbox,
    }),
  });
}

/** Already-authorized runtime and private probe location; no synthetic native child identity. */
export interface VerifiedSandboxProbeContext {
  readonly runtime: PreparedRuntimeDescriptor;
  readonly writableRoots: readonly SandboxWritableMount[];
  readonly environment: Readonly<Record<string, string>>;
  readonly artifactParent: string;
  readonly owner: unknown;
}

/** Controller callers persist a preparation start before this owned, fixed inert probe. */
export interface VerifiedSandboxCapabilityProbeOptions
  extends Omit<SandboxCapabilityProbeOptions, "admission" | "bootstrapApproval" | "runStateDir"> {
  readonly loadVerifiedContext: () => Promise<VerifiedSandboxProbeContext>;
  readonly signal?: AbortSignal;
  readonly assertOpen?: () => void;
}

/** Run the same namespace, mount and process-cleanup probe against a verified controller runtime. */
export async function runVerifiedSandboxCapabilityProbe(
  options: VerifiedSandboxCapabilityProbeOptions,
): Promise<SandboxCapabilityProbeResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new TypeError("invalid capability probe deadline");
  const context = await options.loadVerifiedContext();
  options.signal?.throwIfAborted();
  options.assertOpen?.();
  await canonicalTrustedSnapshotParent(context.artifactParent);
  const probe = context.runtime.inventory.find(
    (entry) => entry.path === SANDBOX_CAPABILITY_PROBE_PATH.slice(1),
  );
  if (
    options.probeApproval.approvalId.length === 0 ||
    options.probeApproval.approvalId.length > 256 ||
    options.probeApproval.approvalId.trim() !== options.probeApproval.approvalId ||
    [...options.probeApproval.approvalId].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    !/^[a-f0-9]{64}$/.test(options.probeApproval.sha256) ||
    probe?.type !== "file" ||
    probe.sha256 !== options.probeApproval.sha256 ||
    (probe.executableMode & 0o100) === 0
  )
    throw new Error("runtime requires the exact host-approved executable capability probe");
  const artifactPath = await mkdtemp(join(context.artifactParent, "probe-"));
  const base = join(artifactPath, "base"),
    writable = join(artifactPath, "writable"),
    bootstrap = join(artifactPath, "bootstrap.sh");
  await prepareProbeFiles(base, writable, bootstrap, context.writableRoots);
  const sentinel = join(artifactPath, "host-only-sentinel");
  await durableFile(sentinel, "private host probe sentinel\n");
  const connections = new Set<Socket>();
  let rejectListener!: (cause: unknown) => void;
  const listenerFault = new Promise<never>((_resolve, reject) => {
    rejectListener = reject;
  });
  void listenerFault.catch(() => undefined);
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.end();
    if (connections.size > 16) socket.destroy();
  });
  server.on("error", rejectListener);
  let child: ChildProcess | undefined;
  let directClose: Promise<void> | undefined;
  let pipes: ReturnType<typeof captureProbePipes> | undefined;
  let init: SandboxProcessObservation | undefined;
  let verifiedInit: SandboxProcessObservation | undefined;
  let primaryFailure: Error | undefined;
  let completed: SandboxCapabilityProbeResult | undefined;
  let timer: NodeJS.Timeout | undefined;
  let failed = false;
  let rejectAbort!: (cause: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  void aborted.catch(() => undefined);
  const onAbort = () => {
    failed = true;
    rejectAbort(new Error("capability probe aborted"));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const port = await listenAndVerify(server);
    const host = await observeSandboxProcess(process.pid);
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId))
      throw new Error("invalid host boot identity");
    const observation = await collectBubblewrapStaticObservation({
      binaryPath: options.binaryPath,
      approvedBuilds: options.approvedBuilds,
      ...(options.getcapPath === undefined ? {} : { getcapPath: options.getcapPath }),
    });
    const assessed = assessBubblewrapStaticPrerequisites(observation, options.approvedBuilds);
    if (assessed.status !== "accepted")
      throw new Error(`Bubblewrap prerequisite rejected: ${assessed.reason}`);
    options.signal?.throwIfAborted();
    options.assertOpen?.();
    const args = buildSandboxMountPlan({
      runtime: context.runtime,
      immutableWorkspaceRoot: base,
      privateWritableRoot: writable,
      bootstrapPath: bootstrap,
      writableRoots: context.writableRoots,
      environment: context.environment,
    });
    // Static collection rechecks the protected binary immediately before this direct spawn.
    child = spawn(
      options.binaryPath,
      [
        "--json-status-fd",
        "5",
        ...args,
        "--",
        "/bin/bash",
        "/bootstrap/bootstrap.sh",
        SANDBOX_CAPABILITY_PROBE_PATH,
        String(port),
        sentinel,
      ],
      { env: {}, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"] },
    );
    const launched = child;
    directClose = new Promise<void>((resolve) => {
      launched.once("close", () => resolve());
      launched.once("error", () => {
        /* close is still required after a spawn error. */
      });
    });
    pipes = captureProbePipes(child);
    const captured = pipes;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("capability probe deadline exceeded")), timeoutMs);
    });
    const operation = async () => {
      const early = await captured.startup;
      init = early.observation;
      await captured.ready;
      const final = await observeSandboxProcess(init.pid);
      verifyFinalSandboxNamespaces(init, final, host, early.pidNamespace);
      verifiedInit = final;
      await options.testHookBeforeReadyPersistence?.({ final, artifactPath });
      if (failed) throw new Error("capability probe setup was cancelled");
      options.assertOpen?.();
      await durableFile(
        join(artifactPath, "ready.json"),
        JSON.stringify({
          schemaVersion: 1,
          bootId,
          host,
          early: init,
          final,
          binary: assessed.evidence,
          sandbox: context.owner,
          probeApproval: options.probeApproval,
        }),
      );
      if (failed) throw new Error("capability probe release was cancelled");
      options.assertOpen?.();
      await captured.release();
      const result = await captured.settle();
      if (failed) throw new Error("capability probe settlement was cancelled");
      await durableFile(join(artifactPath, "stdout.txt"), result.stdout);
      if ((await classifySandboxProcess(final)) === "alive")
        throw new Error("probe namespace-init did not settle");
      const report = parseSandboxCapabilityProbeReport(result.stdout, host.namespaces);
      for (const name of ["pid", "mnt", "user", "net", "ipc", "uts"] as const)
        if (report.namespace[name] !== final.namespaces[name])
          throw new Error("probe executed in a different final namespace");
      assertSandboxProbeMounts(report.mountinfo, {
        runtimeDirectories: context.runtime.inventory
          .filter((entry) => entry.type === "directory" && !entry.path.includes("/"))
          .map((entry) => entry.path),
        writablePaths: context.writableRoots.map((root) => root.path),
      });
      await durableFile(
        join(artifactPath, "result.json"),
        JSON.stringify({ schemaVersion: 1, sandbox: context.owner, final, report }),
      );
      return Object.freeze({ report, final, artifactPath });
    };
    const running = operation();
    completed = await Promise.race([running, pipes.fault, timeout, listenerFault, aborted]);
  } catch (cause) {
    failed = true;
    pipes?.deny();
    if (verifiedInit !== undefined) {
      // Same-PID/start recheck is the fallback when Node exposes no pidfd signal API.
      if ((await classifySandboxProcess(verifiedInit).catch(() => "unknown")) === "alive") {
        try {
          process.kill(verifiedInit.pid, "SIGKILL");
        } catch {
          // Still terminate the directly owned launcher; settlement below decides certainty.
        }
      }
    }
    try {
      if (child !== undefined && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    } catch {
      /* The retained native handle failed to signal; final evidence remains authoritative. */
    }
    let launcherSettled = child === undefined;
    if (directClose !== undefined)
      launcherSettled = await deadline(directClose, 2000).then(
        () => true,
        () => false,
      );
    const cleanup: "confirmed" | "unconfirmed" =
      verifiedInit === undefined || !launcherSettled
        ? "unconfirmed"
        : await classifySandboxProcess(verifiedInit).then<
            "confirmed" | "unconfirmed",
            "unconfirmed"
          >(
            (state) => (state === "alive" ? "unconfirmed" : "confirmed"),
            () => "unconfirmed",
          );
    if (pipes !== undefined)
      await deadline(
        durableFile(join(artifactPath, "diagnostics.json"), JSON.stringify(pipes.diagnostics())),
        1000,
      ).catch(() => undefined);
    const detail = cause instanceof Error ? cause.message : "unknown observation failure";
    primaryFailure = new SandboxCapabilityProbeError(
      `sandbox capability probe failed: ${detail}; cleanup=${cleanup}; inspect ${artifactPath}`,
      cleanup,
      { cause },
    );
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
    for (const connection of connections) connection.destroy();
    try {
      await deadline(closeServer(server), 1000);
    } catch (cause) {
      primaryFailure = new SandboxCapabilityProbeError(
        "capability probe listener cleanup is unconfirmed",
        "unconfirmed",
        { cause },
      );
    }
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (completed === undefined) throw new Error("capability probe did not produce a result");
  return completed;
}

async function prepareProbeFiles(
  base: string,
  writable: string,
  bootstrap: string,
  writableRoots: readonly SandboxWritableMount[],
): Promise<void> {
  await mkdir(base, { mode: 0o700 });
  await mkdir(writable, { mode: 0o700 });
  for (const root of writableRoots) {
    for (const parent of [base, writable]) {
      const destination = join(parent, root.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      if (root.kind === "directory") await mkdir(destination, { mode: 0o700 });
      else await durableFile(destination, "");
    }
  }
  await durableFile(bootstrap, BUBBLEWRAP_BOOTSTRAP_SOURCE);
}

async function durableFile(path: string, text: string): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

async function listenAndVerify(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("probe listener has no port");
  const connection = createConnection({ host: "127.0.0.1", port: address.port });
  try {
    await deadline(once(connection, "connect"), 1000);
  } finally {
    connection.destroy();
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("probe settlement deadline exceeded")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
