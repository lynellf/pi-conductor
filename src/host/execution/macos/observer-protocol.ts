/** Closed identity-only native protocol shared by preflight and async observation (#165). */
import { constants } from "node:os";
/** Sanitized process metadata; arguments/environments never cross the native protocol. */
export interface MacProcessObservation {
  readonly pid: number;
  /** Effective UID determines native visibility, not the ownership trust boundary. */
  readonly uid: number;
  /** Real UID matches Linux's denied-environment same-account boundary. */
  readonly realUid: number;
  readonly startTime: string;
  readonly startKind: "mach" | "wallclock";
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly marker: "present" | "absent" | "unknown";
}
/** Complete observation in a single original boot context. */
export interface MacObservation {
  readonly version: 1;
  readonly bootId: string;
  readonly uid: number;
  readonly processes: readonly MacProcessObservation[];
}

function failure(): Error {
  return Object.assign(new Error("invalid native observation protocol"), { code: "EIO" });
}
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function integer(value: unknown, minimum: number, maximum = 2147483647): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

/** Decode only fixed native errno/PID evidence; never expose raw helper stderr. */
export function nativeObservationFailure(stderr: unknown): Error & { readonly code: string } {
  let code: string = "EIO";
  let nativePid: number | undefined;
  let nativeOperation: "read_stat" | "list_processes" = "list_processes";
  try {
    if (typeof stderr !== "string" || Buffer.byteLength(stderr) > 4096) throw failure();
    const value: unknown = JSON.parse(stderr);
    if (
      !record(value, ["version", "error"]) ||
      value.version !== 1 ||
      !record(value.error, ["operation", "errno", "pid"]) ||
      !integer(value.error.pid, 0) ||
      !integer(value.error.errno, 1) ||
      (value.error.operation !== "read_stat" && value.error.operation !== "list_processes")
    )
      throw failure();
    const codes = [
      "EAGAIN",
      "EACCES",
      "EPERM",
      "ENOMEM",
      "EIO",
      "EINVAL",
      "EOVERFLOW",
      "ESRCH",
      "ENOENT",
      "EINTR",
    ] as const;
    const errno = value.error.errno;
    code = codes.find((name) => constants.errno[name] === errno) ?? "EIO";
    nativePid = value.error.pid === 0 ? undefined : value.error.pid;
    nativeOperation = value.error.operation;
  } catch {
    /* Keep the generic bounded failure; malformed stderr is never evidence. */
  }
  return Object.assign(new Error("native process observation incomplete"), {
    code,
    nativePid,
    nativeOperation,
  });
}

/** Validate a closed native reply without importing a peer SDK into standalone supervision. */
export function parseMacObservation(value: unknown): MacObservation {
  if (
    !record(value, ["version", "bootId", "uid", "processes"]) ||
    value.version !== 1 ||
    typeof value.bootId !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.bootId) ||
    !integer(value.uid, 0, 4294967295) ||
    !Array.isArray(value.processes) ||
    value.processes.length > 16384
  )
    throw failure();
  const processes: MacProcessObservation[] = [];
  const seen = new Set<number>();
  for (const entry of value.processes as unknown[]) {
    if (
      !record(entry, [
        "pid",
        "uid",
        "realUid",
        "startTime",
        "startKind",
        "processGroupId",
        "sessionId",
        "marker",
      ]) ||
      !integer(entry.pid, 1) ||
      !integer(entry.uid, 0, 4294967295) ||
      !integer(entry.realUid, 0, 4294967295) ||
      !integer(entry.processGroupId, 1) ||
      !integer(entry.sessionId, 1) ||
      typeof entry.startTime !== "string" ||
      !/^[1-9][0-9]{0,63}$/.test(entry.startTime) ||
      entry.startKind !== (entry.uid === value.uid ? "mach" : "wallclock") ||
      (entry.marker !== "present" && entry.marker !== "absent" && entry.marker !== "unknown") ||
      (entry.uid !== value.uid && entry.marker !== "unknown") ||
      seen.has(entry.pid)
    )
      throw failure();
    seen.add(entry.pid);
    processes.push({
      pid: entry.pid,
      uid: entry.uid,
      realUid: entry.realUid,
      startTime: entry.startTime,
      startKind: entry.uid === value.uid ? "mach" : "wallclock",
      processGroupId: entry.processGroupId,
      sessionId: entry.sessionId,
      marker: entry.marker,
    });
  }
  return { version: 1, bootId: value.bootId, uid: value.uid, processes };
}
