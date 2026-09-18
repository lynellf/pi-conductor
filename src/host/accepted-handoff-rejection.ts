/** Persist correctable handoff seam rejections without invoking the reducer. */
import type { Role } from "../core/types.js";
import type { Host } from "./host.js";
import { isTransportHandoffValidationFailure } from "./seam.js";

/** Persist all correctable handoff rejections observed during one role turn. */
export function persistHandoffValidationFailures(args: {
  readonly failures: readonly {
    readonly missingFields: readonly string[];
    readonly invalidFields: readonly string[];
  }[];
  readonly host: Host;
  readonly runId: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly sessionFile: string;
}): void {
  for (const failure of args.failures) {
    const transport = isTransportHandoffValidationFailure(failure)
      ? {
          transport_error: failure.transportError,
          actual_utf8_bytes: failure.actualUtf8Bytes,
        }
      : {};
    args.host.persistRecord({
      type: "handoff_validation_rejected",
      run_id: args.runId,
      role: args.role,
      session_id: args.sessionId,
      session_file: args.sessionFile,
      missing_fields: failure.missingFields,
      invalid_fields: failure.invalidFields,
      ...transport,
      ts: Date.now(),
    });
  }
}
