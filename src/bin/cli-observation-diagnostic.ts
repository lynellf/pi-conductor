import { constants } from "node:os";
import type { ProcessObservationError } from "../host/execution/supervised-process-identity.js";

const PROC_FILES = {
  read_stat: "stat",
  read_environ: "environ",
  read_status: "status",
  list_processes: "",
} as const;

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Render identity-only evidence and recovery steps for the approved §76 cleanup contract. */
export function formatObservationDiagnostic(error: ProcessObservationError): string {
  const operation = Object.hasOwn(PROC_FILES, error.operation) ? error.operation : undefined;
  const code = Object.hasOwn(constants.errno, error.code) ? error.code : "UNKNOWN";
  const pid = positiveInteger(error.pid);
  const group = positiveInteger(error.processGroupId);
  const start =
    typeof error.startTime === "string" && /^[0-9]{1,64}$/.test(error.startTime)
      ? error.startTime
      : undefined;
  const evidence = [`operation=${operation ?? "unknown"}`, `code=${code}`];
  if (pid !== undefined) evidence.push(`pid=${pid}`);
  if (start !== undefined) evidence.push(`start_time=${start}`);
  if (group !== undefined) evidence.push(`process_group_id=${group}`);
  const procPath =
    operation === "list_processes"
      ? "/proc"
      : operation !== undefined && pid !== undefined
        ? `/proc/${pid}/${PROC_FILES[operation]}`
        : undefined;

  // Do not interpolate error.message, stack, cause, environment, command, or marker.
  const lines = [
    `Process observation failed: ${evidence.join(" ")}`,
    "Cleanup remains unconfirmed; no confirmation was written.",
    "The scan is incomplete and ownership is unverified. Do not stop a process based on this diagnostic alone.",
  ];
  if (start !== undefined)
    lines.push(
      "start_time is the observed start tick count since boot; verify it again because PIDs can be reused.",
    );
  if (procPath !== undefined) lines.push(`Failed access: ${procPath}`);
  if (pid !== undefined) {
    lines.push(`Inspect process metadata only: ps -p ${pid} -o pid=,ppid=,pgid=,sid=,uid=,stat=`);
  }
  if (procPath !== undefined) lines.push(`Inspect access metadata only: ls -ld ${procPath}`);
  if (code === "EACCES" || code === "EPERM") {
    lines.push(
      "Access was denied. Check the observing account, procfs access restrictions, and process inspection permissions with the host administrator; do not dump environment contents or weaken host security settings.",
    );
  }
  lines.push(
    "Restore observation access on the original Linux host, in the original PID/network namespaces, using the canonical run storage.",
    "After visibility is restored, retry the inspection form: conduct reconcile-tools --log-dir <path> <run-id>",
    "Omit --execution, --confirm-cleanup, and --note. A vanished PID alone does not prove cleanup.",
    "Only after inspection succeeds, verify all original processes (including unmarked descendants) have stopped and inspect partial effects before confirming an execution with --confirm-cleanup and an operator note.",
  );
  return lines.join("\n");
}
