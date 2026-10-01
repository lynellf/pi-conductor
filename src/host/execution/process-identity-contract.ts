/** Shared identity-only supervision contracts (#76 / #165); no platform I/O. */
export type ProcessObservationOperation =
  | "read_stat"
  | "read_environ"
  | "read_status"
  | "list_processes";

/** Sanitized evidence for a process observation failure. */
export class ProcessObservationError extends Error {
  readonly operation: ProcessObservationOperation;
  readonly code: string;
  readonly pid: number | undefined;
  readonly startTime: string | undefined;
  readonly processGroupId: number | undefined;
  readonly startTimeKind: "mach" | "wallclock" | undefined;
  constructor(
    operation: ProcessObservationOperation,
    error: unknown,
    pid?: number,
    identity?: {
      readonly startTime: string;
      readonly processGroupId: number;
      readonly startTimeKind?: "mach" | "wallclock";
    },
  ) {
    super("process observation failed");
    this.name = "ProcessObservationError";
    this.operation = operation;
    const candidate = (error as NodeJS.ErrnoException).code;
    this.code =
      typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(candidate)
        ? candidate
        : "UNKNOWN";
    this.pid = pid;
    this.startTime = identity?.startTime;
    this.processGroupId = identity?.processGroupId;
    this.startTimeKind = identity?.startTimeKind;
  }
}

/** Same-origin PID/start identity, with optional marker and session evidence. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly startTimeKind?: "mach" | "wallclock";
  readonly processGroupId: number;
  readonly sessionId?: number;
  readonly ownerToken?: string;
}

/** Original call-scoped evidence; never manufacture a replacement during recovery. */
export interface ProcessObservationScope {
  readonly preexisting: ReadonlyMap<number, ProcessIdentity>;
  readonly preexistingBefore?: string;
}

/** Verify a recorded leader still owns its original PID and group. */
export function ownsProcessGroup(
  current: ProcessIdentity | null,
  expected: ProcessIdentity,
): boolean {
  return (
    current?.pid === expected.pid &&
    current.startTime === expected.startTime &&
    current.startTimeKind === expected.startTimeKind &&
    current.processGroupId === expected.processGroupId &&
    current.processGroupId === expected.pid
  );
}

/** Verify a recorded member without treating it as a group leader. */
export function ownsProcessIdentity(
  current: ProcessIdentity | null,
  expected: ProcessIdentity,
): boolean {
  return (
    current?.pid === expected.pid &&
    current.startTime === expected.startTime &&
    current.startTimeKind === expected.startTimeKind &&
    current.processGroupId === expected.processGroupId
  );
}
