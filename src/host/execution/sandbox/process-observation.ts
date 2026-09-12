/** Exact owned-process observations; never enumerate unrelated host processes (#106 §6). */
import { constants } from "node:fs";
import { open, readlink } from "node:fs/promises";
import { Value } from "typebox/value";
import { assertSandboxNamespaceLifecycle } from "../../../persistence/sandbox-execution.js";
import {
  type SandboxProcessObservation,
  sandboxProcessObservationSchema,
} from "../../../persistence/sandbox-process.js";

const namespaceNames = ["pid", "mnt", "user", "net", "ipc", "uts"] as const;
type ProcessIdentity = Pick<SandboxProcessObservation, "pid" | "startTime">;

/** Sanitized failing operation and safe process identity for actionable diagnostics. */
export class SandboxProcessObservationError extends Error {
  readonly code: string;
  constructor(
    readonly operation: "read_stat" | "read_status" | "read_namespace",
    readonly pid: number,
    cause: unknown,
  ) {
    const raw =
      typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
    const code =
      typeof raw === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(raw) ? raw : "INVALID_OBSERVATION";
    super(
      `sandbox process observation failed: operation=${operation} code=${code} pid=${pid}. Check procfs access on the original host; cleanup remains unconfirmed.`,
      { cause },
    );
    this.name = "SandboxProcessObservationError";
    this.code = code;
  }
}

/** Read-only seams for deterministic process-race tests. */
export interface SandboxProcessReader {
  readonly readText: (path: string) => Promise<string>;
  readonly readNamespace: (path: string) => Promise<string>;
}

/** Observe one exact PID, rejecting identity changes across namespace/status reads. */
export async function observeSandboxProcess(
  pid: number,
  reader: SandboxProcessReader = { readText: boundedProcText, readNamespace: readlink },
): Promise<SandboxProcessObservation> {
  assertPid(pid);
  const before = await readStat(pid, reader.readText);
  if (before.state === "Z" || before.state === "X")
    throw new Error("sandbox process is already settled");
  const namespaceValues = await Promise.all(
    namespaceNames.map(async (name) => {
      try {
        return [name, await reader.readNamespace(`/proc/${pid}/ns/${name}`)] as const;
      } catch (cause) {
        throw new SandboxProcessObservationError("read_namespace", pid, cause);
      }
    }),
  );
  let status: string;
  try {
    status = await reader.readText(`/proc/${pid}/status`);
  } catch (cause) {
    throw new SandboxProcessObservationError("read_status", pid, cause);
  }
  const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
  const after = await readStat(pid, reader.readText);
  if (before.startTime !== after.startTime || after.state === "Z" || after.state === "X")
    throw new Error("sandbox process identity changed during observation");
  const result: unknown = {
    pid,
    startTime: after.startTime,
    nspid,
    namespaces: Object.fromEntries(namespaceValues),
  };
  if (!Value.Check(sandboxProcessObservationSchema, result) || result.nspid[0] !== pid)
    throw new Error("invalid sandbox process namespace identity");
  Object.freeze(result.namespaces);
  Object.freeze(result.nspid);
  return Object.freeze(result);
}

/** Classify stat lifetime only; missing namespace links never establish death. */
export async function classifySandboxProcess(
  identity: ProcessIdentity,
  readText: (path: string) => Promise<string> = boundedProcText,
): Promise<"alive" | "settled" | "missing" | "reused"> {
  assertPid(identity.pid);
  let stat: Awaited<ReturnType<typeof readStat>>;
  try {
    stat = await readStat(identity.pid, readText);
  } catch (cause) {
    if (
      cause instanceof SandboxProcessObservationError &&
      (cause.code === "ENOENT" || cause.code === "ESRCH")
    )
      return "missing";
    throw cause;
  }
  if (stat.startTime !== identity.startTime) return "reused";
  return stat.state === "Z" || stat.state === "X" ? "settled" : "alive";
}

/** Bind the startup namespace-init to final isolated PID 1 before release. */
export function verifyFinalSandboxNamespaces(
  early: SandboxProcessObservation,
  final: SandboxProcessObservation,
  host: SandboxProcessObservation,
  startupPidNamespace: number,
): void {
  assertSandboxNamespaceLifecycle(early, final, startupPidNamespace, host);
}

async function readStat(
  pid: number,
  readText: (path: string) => Promise<string>,
): Promise<{ readonly state: string; readonly startTime: string }> {
  try {
    const text = await readText(`/proc/${pid}/stat`);
    const closing = text.lastIndexOf(") ");
    if (!text.startsWith(`${pid} (`) || closing < 0) throw new Error("invalid stat prefix");
    const fields = text
      .slice(closing + 2)
      .trim()
      .split(/\s+/);
    const state = fields[0],
      startTime = fields[19];
    if (
      state === undefined ||
      !/^[RSDZTWtXxKWPIN]$/.test(state) ||
      startTime === undefined ||
      !/^(0|[1-9][0-9]{0,63})$/.test(startTime)
    )
      throw new Error("invalid stat identity");
    return { state, startTime };
  } catch (cause) {
    throw new SandboxProcessObservationError("read_stat", pid, cause);
  }
}

async function boundedProcText(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.allocUnsafe(65537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) return buffer.subarray(0, length).toString("utf8");
      length += bytesRead;
    }
    throw new Error("procfs observation exceeds 64 KiB");
  } finally {
    await handle.close();
  }
}

function assertPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError("invalid sandbox PID");
}
