/**
 * `handoff` and `end` emission tools — spec §3, §5.1, §11.3, §12.1.
 *
 * Two `defineTool()` entries registered via `customTools` in
 * `createAgentSession` (sdk-surface.md §1, §2). The TypeBox schemas
 * are reused from `src/seam/schema.ts` (Phase 3 Task 9) — single
 * source of truth for tool-arg shape, seam validation, and the
 * derived TS type (no double schema).
 *
 * ## What a tool call does (and does NOT do)
 *
 * On call, the tool does **three** things and nothing else
 * (per plan Task 14):
 *
 *   1. Validate the args at the seam (`validateEmission`, Phase 3).
 *   2. Append a `EmissionCapture` to the session's `SessionSeam`
 *      buffer — the first machine-event call writes its own args
 *      (valid or schema-invalid); a second machine-event call writes
 *      a marker that pushes buffer length to 2, which the loop's
 *      `validateEmission` reads as `extra_emission`.
 *   3. Return a terminating tool result (`terminate: true`) that
 *      instructs the role to stop calling tools. On a valid capture,
 *      also flips `SessionSeam.seal()` so the post-emission wrapper
 *      (Task 15.5) refuses to execute side-effecting tools while
 *      sealed (§12.1).
 *
 * The tool does **not** call `reduce`, does **not** persist, and
 * does **not** spawn. Those are the loop's exclusive
 * responsibilities (Task 15). There is exactly one reduce path and
 * one persist path per role session — both in the loop, not the
 * tool. This is the "single-owner" rule that prevents double-reduce
 * / double-persist (§9.5 / sdk-surface.md §2).
 *
 * ## Buffer state machine
 *
 *   - 0 entries, call with valid args     → buffer becomes [valid_capture]; seal(); return ok
 *   - 0 entries, call with invalid args   → buffer becomes [invalid_capture]; return schema_invalid
 *   - ≥1 entries, any call                → buffer length becomes 2+; return extra_emission
 *
 * After `prompt()` resolves, the loop reads `seam.read()` and feeds
 * it to `validateEmission` (Phase 3). The validateEmission precedence
 * is `extra_emission` > `schema_invalid` > `no_emission`; the buffer
 * shape produced by this tool matches that precedence by construction.
 *
 * ## Sealed flag
 *
 * `SessionSeam.seal()` is called only on the FIRST valid capture.
 * Subsequent extra-emission calls do not flip the flag (it stays
 * sealed from the first call). Schema-invalid first calls do not
 * seal — the role may still produce a valid machine event later
 * (though by the contract a second call after a schema-invalid is
 * itself an extra_emission; the loop records exactly one
 * `session_failed` for the breach regardless).
 *
 * `handoff`/`end` themselves remain callable while sealed — they
 * don't execute side effects, they only write the capture buffer.
 * The post-emission wrapper (Task 15.5) short-circuits BUILT-IN and
 * CUSTOM side-effecting tools, NOT `handoff`/`end`.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { createAcceptedHandoffEnvelope } from "../core/accepted-handoff.js";
import {
  type RawControlArgumentRejection,
  readRawControlArguments,
} from "../seam/control-arguments.js";
import {
  endArgsSchema,
  endArgsSchemaV2,
  type HandoffCandidate,
  handoffArgsSchema,
  orchestratorHandoffArgsSchema,
  workerHandoffArgsSchema,
} from "../seam/schema.js";
import { validateEmission } from "../seam/validate-emission.js";
import {
  formatHandoffCorrection,
  formatHandoffDescription,
  type HandoffContractContext,
  validateRoleHandoff,
} from "./handoff-contract.js";
import { formatHostRejection, type HostRejection } from "./host-rejection.js";
import type { SessionSeam } from "./seam.js";

// ─── Structured details for the tool result ────────────────────────────

/**
 * The `details` payload on the tool's `AgentToolResult`. Lets
 * callers (tests, future observability layer) inspect what the
 * tool decided without re-parsing the text content.
 *
 *  - `ok: true`               — capture recorded + sealed.
 *  - `ok: false, reason`      — contract breach (no `reduce` call).
 */
export interface EmissionToolDetails {
  readonly ok: boolean;
  readonly reason?:
    | "schema_invalid"
    | "extra_emission"
    | "handoff_incomplete"
    | "handoff_envelope_not_json"
    | "handoff_envelope_too_large"
    | "host_terminated"
    | RawControlArgumentRejection;
  readonly cause?: HostRejection["cause"];
  readonly diagnostic?: string;
  readonly target_role?: string;
  readonly missing_fields?: readonly string[];
  readonly invalid_fields?: readonly string[];
}

// ─── Internal factory: shared logic for handoff + end ──────────────────

interface EmissionToolFactoryOptions {
  readonly seam: SessionSeam | (() => SessionSeam);
  readonly toolName: "handoff" | "end";
  readonly schema: TSchema;
  readonly protocol?: "v1" | "v2" | "v2-orchestrator" | "v2-worker";
  readonly description: string;
  readonly label: string;
  readonly handoffContext?: HandoffContractContext | (() => HandoffContractContext);
  /**
   * Optional: host-supplied predicate consulted at the start of
   * `execute`. When the predicate returns `true`, the tool returns
   * a terminating error result WITHOUT writing to the capture
   * buffer. The host uses this to honor cap / model-failure
   * decisions (Task 17 / Task 18) that fire *during* the session:
   * the per-session cap may trip on a `message_end` *before* the
   * tool-execution phase, and we want the tool to refuse the
   * write so the loop records `session_failed(cap_reason)`
   * instead of reducing a captured handoff that was racing the
   * abort.
   *
   * The predicate runs synchronously inside the tool's `execute`,
   * so the cap decision is visible to the tool at call time
   * (the SDK fires tool calls synchronously from the agent loop,
   * after the host's `message_end` listener has had a chance to
   * set the cap state).
   *
   * Default: no predicate (the tool always writes — backward
   * compat with Phase 4 / Task 14 behavior).
   */
  readonly shouldRejectCapture?: () => boolean | HostRejection;
}

function createEmissionTool(opts: EmissionToolFactoryOptions): ToolDefinition {
  const {
    seam,
    toolName,
    schema,
    description,
    label,
    handoffContext,
    shouldRejectCapture,
    protocol,
  } = opts;
  const activeSeam = (): SessionSeam => (typeof seam === "function" ? seam() : seam);
  const activeHandoffContext = (): HandoffContractContext | undefined =>
    typeof handoffContext === "function" ? handoffContext() : handoffContext;

  return defineTool({
    name: toolName,
    label,
    description,
    parameters: schema,
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      // ── Host rejection and abort-signal checks (issue #112) ──
      // The host calls `session.abort()` from its message_end
      // listener when the per-session cap trips. The SDK
      // propagates the abort via the tool's `signal` parameter.
      // If the signal is already aborted at execute time, the
      // cap (or model error) tripped *before* the tool was
      // invoked, and we refuse the write so the loop records
      // `session_failed(cap_reason)` instead of reducing a
      // captured handoff that was racing the abort. The check
      // is synchronous: by the time `execute` runs, the
      // message_end event that fired the cap has already been
      // processed (SDK events flow in order), so the abort
      // signal is the authoritative cross-event visibility
      // for the cap decision.
      // A specific host reason wins over a concurrently aborted SDK signal.
      const hostRejection = shouldRejectCapture?.();
      if (hostRejection !== undefined && hostRejection !== false) {
        const rejection: HostRejection =
          hostRejection === true ? { cause: "host_terminated" } : hostRejection;
        return formatHostRejection(toolName, rejection);
      }
      if (signal?.aborted === true) {
        return formatHostRejection(toolName, { cause: "aborted" });
      }

      // The complete raw argument object crosses the bounded JSON boundary
      // before extra-emission checks, semantic validation, or capture.
      const raw = readRawControlArguments(params);
      if (raw.kind === "rejected") {
        return {
          content: [
            {
              type: "text" as const,
              text:
                raw.reason === "tool_arguments_too_large"
                  ? "tool arguments exceed the 65536-byte UTF-8 transport limit; no partial fields were inspected."
                  : "tool arguments are not exactly JSON-representable; no partial fields were inspected.",
            },
          ],
          details: { ok: false, reason: raw.reason } satisfies EmissionToolDetails,
          terminate: false,
        };
      }

      // ── §3 rule 1, §11.3: extra emission ────────────────────────────
      // A second machine-event call in the same session is a contract
      // breach. Push this call's args as a marker so the buffer length
      // goes from 1 to 2 — the loop's validateEmission reads length > 1
      // as `extra_emission` (precedence over schema_invalid per
      // Phase 3 validate-emission.ts).
      //
      // We do NOT set the sealed flag here: it was either set on the
      // first valid capture (and stays set), or it wasn't (first call
      // was schema-invalid). Either way the buffer state is what the
      // loop reads; the flag is only flipped on a *valid* first
      // capture (Task 15.5 reads it to short-circuit side-effecting
      // tools).
      if (activeSeam().read().length > 0) {
        activeSeam().push({ toolName, args: raw.value });
        return {
          content: [
            {
              type: "text" as const,
              text: `extra emission: a machine-event was already recorded in this session. The role must emit exactly one machine event (§3). The loop will record this as a contract breach.`,
            },
          ],
          details: { ok: false, reason: "extra_emission" } satisfies EmissionToolDetails,
          terminate: true,
        };
      }

      // ── First handoff call: same-session routing correction ────────
      if (toolName === "handoff" && protocol?.startsWith("v2") === true) {
        const roleContext = activeHandoffContext();
        const isOrchestrator =
          roleContext !== undefined && roleContext.role === roleContext.def.orchestrator;
        if (
          isOrchestrator &&
          (!isObject(raw.value) ||
            typeof raw.value.target_role !== "string" ||
            raw.value.target_role.trim().length === 0)
        ) {
          const failure = {
            missingFields: [],
            invalidFields: [] as const,
          };
          activeSeam().rejectHandoff(failure);
          return {
            content: [
              {
                type: "text" as const,
                text: formatHandoffCorrection(failure, roleContext),
              },
            ],
            details: {
              ok: false,
              reason: "handoff_incomplete",
              invalid_fields: ["target_role"],
            } satisfies EmissionToolDetails,
            terminate: false,
          };
        }
      }
      if (
        toolName === "handoff" &&
        protocol !== "v2-orchestrator" &&
        protocol !== "v2-worker" &&
        isObject(params) &&
        typeof params.target_role === "string"
      ) {
        const roleContext = activeHandoffContext();
        const failure = validateRoleHandoff(params as HandoffCandidate, roleContext);
        if (failure !== null) {
          activeSeam().rejectHandoff(failure);
          return {
            content: [
              {
                type: "text" as const,
                text: formatHandoffCorrection(failure, roleContext),
              },
            ],
            details: {
              ok: false,
              reason: "handoff_incomplete",
              missing_fields: failure.missingFields,
              invalid_fields: failure.invalidFields,
            } satisfies EmissionToolDetails,
            terminate: false,
          };
        }
      }

      // ── First machine-event call: validate at the seam ───────────
      const validated = validateEmission(
        [{ toolName, args: raw.value }],
        protocol === undefined ? {} : { protocol },
      );

      // A durable envelope must be snapshotted before capture and sealing.
      // Rejecting here leaves the role live for an explicit repair and makes
      // it impossible to accept a transition whose payload cannot persist.
      let captureArgs: unknown = raw.value;
      if (protocol === undefined || protocol === "v1") {
        if (validated.kind === "ok" && validated.event.type === "handoff") {
          const envelope = createAcceptedHandoffEnvelope(
            validated.event.payload,
            validated.event.target_role,
          );
          if (envelope.kind === "rejected") {
            activeSeam().rejectHandoff({
              missingFields: [],
              invalidFields: [],
              transportError: envelope.reason,
              actualUtf8Bytes: envelope.actual_utf8_bytes,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    envelope.reason === "handoff_envelope_too_large"
                      ? "handoff payload is too large for durable recipient delivery. Reduce it below 65536 UTF-8 bytes and try again."
                      : "handoff payload cannot be represented exactly as JSON for durable recipient delivery. Correct it and try again.",
                },
              ],
              details: { ok: false, reason: envelope.reason } satisfies EmissionToolDetails,
              terminate: false,
            };
          }
          captureArgs = envelope.envelope.payload;
        }
      }

      // Always push the call's args to the buffer — both valid and
      // schema-invalid captures are recorded. The loop's
      // `validateEmission` re-derives the breach reason from the
      // single-element buffer, so the schema-invalid path stays
      // observable at the loop level.
      activeSeam().push({ toolName, args: captureArgs });

      if (validated.kind === "ok") {
        // ── Valid capture. Set the sealed flag (§12.1). ───────────
        // Task 15.5 wires the host's tool wrappers to short-circuit
        // while this is true; the role's first valid emission is its
        // LAST chance to execute side-effecting tools.
        activeSeam().seal();
        const targetText =
          validated.event.type === "handoff" ? ` → ${validated.event.target_role}` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `emission recorded: ${toolName}${targetText}. Do not call further tools; the loop will end this session.`,
            },
          ],
          details: {
            ok: true,
            ...(validated.event.type === "handoff"
              ? { target_role: validated.event.target_role }
              : {}),
          } satisfies EmissionToolDetails,
          terminate: true,
        };
      }

      // ── Schema-invalid. Buffer has 1 entry with invalid args → ──
      // validateEmission returns breach: schema_invalid at the loop.
      // The loop records exactly one session_failed record with
      // failure_reason: "schema_invalid"; reduce is NOT called.
      // (Spec §11.3: contract breaches are session_failed, not
      // transition_rejected.)
      return {
        content: [
          {
            type: "text" as const,
            text: `schema-invalid ${toolName}: payload did not match the TypeBox schema. The loop will record this as a contract breach (failure_reason: schema_invalid, §11.3).`,
          },
        ],
        details: { ok: false, reason: "schema_invalid" } satisfies EmissionToolDetails,
        terminate: true,
      };
    },
  });
}

// ─── Public factories ──────────────────────────────────────────────────

/**
 * Build the `handoff` tool (spec §5.1). The host wires one instance
 * per role session, closing over a per-session `SessionSeam`.
 *
 * The TypeBox parameter schema is the seam contract — the same
 * schema `validateEmission` (Phase 3) checks, and the same schema
 * that derives the host's typed view of the validated payload
 * (`HandoffArgs`). No second schema.
 */
export function createHandoffTool(
  seam: SessionSeam | (() => SessionSeam),
  shouldRejectCapture?: () => boolean | HostRejection,
  context?: HandoffContractContext | (() => HandoffContractContext),
  /** Use when a shared session may later change roles; no source authority leaks into the schema description. */
  transportNeutralDescription = false,
): ToolDefinition {
  const resolvedContext = typeof context === "function" ? context() : context;
  const protocol =
    resolvedContext?.protocol === "v2"
      ? resolvedContext.role === resolvedContext.def.orchestrator
        ? ("v2-orchestrator" as const)
        : ("v2-worker" as const)
      : "v1";
  const schema =
    protocol === "v2-orchestrator"
      ? orchestratorHandoffArgsSchema
      : protocol === "v2-worker"
        ? workerHandoffArgsSchema
        : handoffArgsSchema;
  return createEmissionTool({
    seam,
    toolName: "handoff",
    schema,
    protocol,
    label: "Handoff",
    description: formatHandoffDescription(
      transportNeutralDescription ? undefined : resolvedContext,
    ),
    ...(context !== undefined && { handoffContext: context }),
    ...(shouldRejectCapture !== undefined && { shouldRejectCapture }),
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the `end` tool (spec §5.1). The orchestrator declares the run
 * complete; workers calling this tool trigger a rejected transition
 * (worker → end is illegal per §7.2) — but the tool itself only
 * records the emission; the loop's `reduce` call determines whether
 * the transition is accepted.
 */
export function createEndTool(
  seam: SessionSeam | (() => SessionSeam),
  shouldRejectCapture?: () => boolean | HostRejection,
  protocol: "v1" | "v2" = "v1",
): ToolDefinition {
  return createEmissionTool({
    seam,
    toolName: "end",
    schema: protocol === "v2" ? endArgsSchemaV2 : endArgsSchema,
    protocol,
    label: "End",
    description:
      protocol === "v2"
        ? "Terminate this role's session. Optional fields are untrusted hints; legal end authority and guards are host-owned."
        : "Terminate this role's session and declare the run complete. Only legal from the orchestrator (§7.2); workers calling this tool produce a transition_rejected record with legal_targets surfaced.",
    ...(shouldRejectCapture !== undefined && { shouldRejectCapture }),
  });
}
