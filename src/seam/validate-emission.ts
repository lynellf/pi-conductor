/**
 * `validateEmission` — spec §3 (boundary contract), §11.3 (breach reasons).
 *
 * Enforces contract rules (1) and (2) of §3:
 *  1. Exactly one machine event in the capture buffer.
 *  2. The single emission's args match the TypeBox schema for that event.
 *
 * Maps breaches to the §11.3 vocabulary the host records as
 * `session_failed.failure_reason`:
 *  - `no_emission`     — empty buffer
 *  - `extra_emission`  — more than one emission
 *  - `schema_invalid`  — single emission, args failed the schema check
 *
 * The host MUST call this BEFORE deciding reduce-vs-lifecycle (§12.1):
 * a breach yields a `session_failed` and `reduce` is never called. The
 * reducer itself stays trusting of pre-validated input (MachineEvent with
 * `payload: unknown`, §12). Putting seam enforcement in the core means
 * both the test suite and any future host-side test double enforces the
 * same contract rules; the reducer cannot accidentally accept an emission
 * that the seam would have rejected.
 *
 * Precedence (tested): `extra_emission` > `schema_invalid` > `no_emission`.
 * A buffer with two schema-invalid captures is `extra_emission`, not
 * `schema_invalid` — once more than one capture exists the
 * single-emission assumption is already broken; the host records one
 * `session_failed` for the breach and does not double-count reasons.
 *
 * Pure. No I/O. No pi imports.
 */

import { Value } from "typebox/value";
import type { MachineEvent } from "../core/types.js";
import {
  type EndArgs,
  endArgsSchema,
  endArgsSchemaV2,
  type HandoffArgs,
  handoffArgsSchema,
  orchestratorHandoffArgsSchema,
  workerHandoffArgsSchema,
} from "./schema.js";

/**
 * A single capture from the role session's machine-event capture buffer.
 * Other tool calls are not in the buffer (§3 rule 3); only `handoff` and
 * `end` captures reach `validateEmission`.
 */
export type EmissionCapture =
  | { readonly toolName: "handoff"; readonly args: unknown }
  | { readonly toolName: "end"; readonly args: unknown };

/** §11.3 breach reasons surfaced by `validateEmission`. */
export type BreachFailureReason = "schema_invalid" | "extra_emission" | "no_emission";

/**
 * Result of `validateEmission`. The host dispatches on `kind`:
 *  - `ok` → call `reduce(checkpoint, event, def, meta)`
 *  - `breach` → call `reduceLifecycle(session_failed, …)` with `failure_reason`
 *    set to `reason`. `reduce` is NOT called (§11.3).
 */
export type ValidatedEmission =
  | { readonly kind: "ok"; readonly event: MachineEvent }
  | { readonly kind: "breach"; readonly reason: BreachFailureReason };

/** Role-aware schema selection for the v2 host-generated control contract. */
export interface ValidateEmissionOptions {
  readonly protocol?: "v1" | "v2" | "v2-orchestrator" | "v2-worker";
  /** Pinned hub target used when a worker returns control without a target. */
  readonly workerTargetRole?: string;
  /** Host authorization for optional worker end requests. */
  readonly workerRequestEndAuthorized?: boolean;
}

/**
 * Validate a role session's machine-event capture buffer against the §3
 * boundary contract.
 */
export function validateEmission(
  emissions: readonly EmissionCapture[],
  options: ValidateEmissionOptions = {},
): ValidatedEmission {
  // §3 rule 1: empty buffer → no_emission.
  if (emissions.length === 0) {
    return { kind: "breach", reason: "no_emission" };
  }

  // §3 rule 1: more than one capture → extra_emission (precedence over
  // schema_invalid: once the single-emission assumption is broken, the
  // host records one breach, not two).
  if (emissions.length > 1) {
    return { kind: "breach", reason: "extra_emission" };
  }

  // Exactly one capture. Schema check per §3 rule 2.
  // `noUncheckedIndexedAccess` widens `emissions[0]` to `T | undefined`; the
  // length-1 guards above narrow it back.
  const capture: EmissionCapture = emissions[0] as EmissionCapture;

  if (capture.toolName === "handoff") {
    const schema =
      options.protocol === "v2-orchestrator"
        ? orchestratorHandoffArgsSchema
        : options.protocol === "v2-worker"
          ? workerHandoffArgsSchema
          : handoffArgsSchema;
    if (!Value.Check(schema, capture.args)) {
      return { kind: "breach", reason: "schema_invalid" };
    }
    if (options.protocol === "v2-worker" && options.workerTargetRole === undefined) {
      return { kind: "breach", reason: "schema_invalid" };
    }
    const args = capture.args as HandoffArgs & { readonly target_role?: string };
    const target_role =
      options.protocol === "v2-worker" ? (options.workerTargetRole as string) : args.target_role;
    return {
      kind: "ok",
      event: {
        type: "handoff",
        request_end:
          options.protocol === "v2-orchestrator"
            ? false
            : options.protocol === "v2-worker"
              ? options.workerRequestEndAuthorized === true && args.request_end === true
              : args.request_end === true,
        target_role,
        payload: args,
      },
    };
  }

  if (capture.toolName === "end") {
    const schema = options.protocol?.startsWith("v2") === true ? endArgsSchemaV2 : endArgsSchema;
    if (!Value.Check(schema, capture.args)) {
      return { kind: "breach", reason: "schema_invalid" };
    }
    const args = capture.args as EndArgs;
    return {
      kind: "ok",
      event: { type: "end", authority: "role", payload: args },
    };
  }

  // Exhaustiveness: EmissionCapture's two variants are the only legal
  // machine events (§5.1). An unknown toolName should not be possible
  // because the capture buffer only records `handoff` / `end` calls.
  return { kind: "breach", reason: "schema_invalid" };
}
