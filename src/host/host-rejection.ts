/** Structured host-driven emission rejection — issue #112, spec §11.7/§8.2. */

import { capErrorDiagnostic } from "./bounded-diagnostic.js";
import type { SessionTerminalReason } from "./host.js";

/** Cause reported when the host refuses a machine-event capture. */
export type HostRejectionCause =
  | Exclude<SessionTerminalReason, null>
  | "aborted"
  | "host_terminated";

/** Bounded, host-owned reason for rejecting a machine-event capture. */
export interface HostRejection {
  readonly cause: HostRejectionCause;
  readonly diagnostic?: string;
}

/** Structured terminating result returned by a rejected emission tool. */
export interface HostRejectionToolResult {
  readonly content: [{ readonly type: "text"; readonly text: string }];
  readonly details: {
    readonly ok: false;
    readonly reason: "host_terminated";
    readonly cause: HostRejectionCause;
    readonly diagnostic?: string;
  };
  readonly terminate: true;
}

/** Normalize a callback result while bounding diagnostics at the tool boundary. */
export function normalizeHostRejection(rejection: HostRejection): HostRejection {
  const diagnostic = rejection.diagnostic;
  if (diagnostic === undefined) return { cause: rejection.cause };
  const sanitized = sanitizeDiagnostic(diagnostic);
  const bounded = capErrorDiagnostic(sanitized).output;
  return bounded.length === 0
    ? { cause: rejection.cause }
    : { cause: rejection.cause, diagnostic: bounded };
}

/** Build the shared terminal tool result for a host-driven rejection. */
export function formatHostRejection(
  toolName: string,
  rejection: HostRejection,
): HostRejectionToolResult {
  const bounded = normalizeHostRejection(rejection);
  const diagnosticText =
    bounded.diagnostic === undefined ? "" : ` Diagnostic: ${bounded.diagnostic}`;
  return {
    content: [
      {
        type: "text",
        text: `${toolName} was rejected by the host: ${bounded.cause}.${diagnosticText} Stop retrying this invocation; the host handles failure/fallback.`,
      },
    ],
    details: {
      ok: false,
      reason: "host_terminated",
      cause: bounded.cause,
      ...(bounded.diagnostic === undefined ? {} : { diagnostic: bounded.diagnostic }),
    },
    terminate: true,
  };
}

function sanitizeDiagnostic(diagnostic: string): string {
  return diagnostic.replace(/\p{Cc}/gu, " ");
}
