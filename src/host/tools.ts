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
import type { TSchema } from "@sinclair/typebox";

import { endArgsSchema, handoffArgsSchema } from "../seam/schema.js";
import { validateEmission } from "../seam/validate-emission.js";
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
  readonly reason?: "schema_invalid" | "extra_emission";
  readonly target_role?: string;
}

// ─── Internal factory: shared logic for handoff + end ──────────────────

interface EmissionToolFactoryOptions {
  readonly seam: SessionSeam;
  readonly toolName: "handoff" | "end";
  readonly schema: TSchema;
  readonly description: string;
  readonly label: string;
}

function createEmissionTool(opts: EmissionToolFactoryOptions): ToolDefinition {
  const { seam, toolName, schema, description, label } = opts;

  return defineTool({
    name: toolName,
    label,
    description,
    parameters: schema,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
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
      if (seam.read().length > 0) {
        seam.push({ toolName, args: params });
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

      // ── First machine-event call: validate at the seam ───────────
      const validated = validateEmission([{ toolName, args: params }]);

      // Always push the call's args to the buffer — both valid and
      // schema-invalid captures are recorded. The loop's
      // `validateEmission` re-derives the breach reason from the
      // single-element buffer, so the schema-invalid path stays
      // observable at the loop level.
      seam.push({ toolName, args: params });

      if (validated.kind === "ok") {
        // ── Valid capture. Set the sealed flag (§12.1). ───────────
        // Task 15.5 wires the host's tool wrappers to short-circuit
        // while this is true; the role's first valid emission is its
        // LAST chance to execute side-effecting tools.
        seam.seal();
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
export function createHandoffTool(seam: SessionSeam): ToolDefinition {
  return createEmissionTool({
    seam,
    toolName: "handoff",
    schema: handoffArgsSchema,
    label: "Handoff",
    description:
      "Terminate this role's session and route to another declared role. Workers may only hand off back to the orchestrator; the orchestrator may hand off to any declared worker (subject to visit caps).",
  });
}

/**
 * Build the `end` tool (spec §5.1). The orchestrator declares the run
 * complete; workers calling this tool trigger a rejected transition
 * (worker → end is illegal per §7.2) — but the tool itself only
 * records the emission; the loop's `reduce` call determines whether
 * the transition is accepted.
 */
export function createEndTool(seam: SessionSeam): ToolDefinition {
  return createEmissionTool({
    seam,
    toolName: "end",
    schema: endArgsSchema,
    label: "End",
    description:
      "Terminate this role's session and declare the run complete. Only legal from the orchestrator (§7.2); workers calling this tool produce a transition_rejected record with legal_targets surfaced.",
  });
}
