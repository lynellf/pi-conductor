# Spec: Handoff cards in the TUI stream (Phase 9)

> Status: **Draft — awaiting overseer acknowledgment.** Open questions
> Q1–Q5 resolved with planner defaults (see Overseer decisions at the
> bottom). Implementation may NOT begin until the overseer acknowledges.
> Authority chain: `docs/orchestrator-fsm-spec.md` (FSM/records,
> untouched) → `docs/extension-pivot-plan.md` (delivery shape) →
> `docs/handoff-visibility-spec.md` (Phase 8, acknowledged + tick-boxed)
> → this spec (UX-only change, builds on Phase 8).
> Author: planner role. Date: 2026-06-20.

## Objective

Phase 8 (handoff-visibility) shipped live `conduct: <from> → <to>`
notifications, a `handoffs=<N>` status counter, and a `/conduct:list`
transition trace. The user's screenshots (2026-06-20) show that while
those features work, the **TUI stream** still renders the handoff as
raw JSON — the LLM's own text narration of its tool call (`handoff:
{"target_role":"worker","reason":"…","suggests_next":"…","payload":"…"}`)
appears verbatim in the stream because `.pi/roles/orchestrator.md` (2
lines, no behavioral constraints) does not tell the LLM not to narrate
tool calls, and the display sink suppresses the structured tool event
that could replace the narration with a readable card.

**User goal (verbatim):** "I'd like to be able to see handoffs
displayed between the orchestrator and other agent roles. At the moment,
I'm unable to see handoffs. How can we improve this experience for the
end user?"

The user wants to **read the handoff content** — the reason, the
request being passed (`payload`), the suggested next step — not just
the role transition. Phase 8's `notify` line carries only `from → to`;
it does not surface `reason` / `suggests_next` / `payload`. Those
fields ARE available in the handoff **tool call args** (the LLM emits
them as JSON when it calls the `handoff` tool), but the display sink
currently throws them away (it suppresses all `tool_call`/`tool_result`
events per Phase 5.5).

**Success looks like:** during a `/conduct` (or `/conduct:resume`) run,
each accepted `handoff` (and `end`) tool call renders a **handoff card**
in the TUI stream — a compact, structured block showing the emitting
role, the target role, and the `reason` / `suggests_next` / `payload`
fields from the tool args. The card is model-independent (it reads the
tool call args, not the LLM's text narration). A complementary
prompt-side change (Lever B) instructs the LLM not to narrate tool
calls in text, so the user sees the card instead of the JSON.

### Assumptions I'm making

1. **The `tool_execution_start` event carries `event.toolName` and
   `event.args`** (structured, not stringified). The existing
   `session-event-handler.ts` already reads `event.toolName` and
   `event.args` (lines 113–116) and stringifies them into the `text`
   field of the display event. I am widening the `DisplayEvent` type
   to also carry the raw `toolName` and `args` as optional structured
   fields, so the sink can read them without parsing JSON out of
   `text`. This is a host-layer change (`src/host/display-sink.ts` +
   `src/host/session-event-handler.ts`), which is permitted — both
   files are in `src/host/` where pi imports are allowed, and the
   orchestrator's charter explicitly permits touching
   `src/host/display-sink.ts`.

2. **The handoff tool args are the authoritative source of `reason` /
   `suggests_next` / `payload`.** The Phase 8 spec said
   `payload_summary.reason` was "not reliably available" (the reducer
   emits a placeholder, the host never enriches it). That is true for
   the **persisted record**. But the **tool call args** — observed at
   the `tool_execution_start` event — DO carry `reason`, `suggests_next`,
   and `payload` as fields the LLM provides when it calls the `handoff`
   tool (see `src/seam/schema.ts:42-50`: `target_role` is required;
   `reason` and `suggests_next` are optional strings; `additionalProperties:
   true` permits `payload` and other role-defined fields). This spec
   reads the tool args, NOT the persisted record's `payload_summary`.

3. **The `typebox` `Value.Check` validator** (from `typebox/value`,
   the same import used in `src/seam/validate-emission.ts:31`) can be
   used at the display sink to validate the tool args against
   `handoffArgsSchema` / `endArgsSchema` before emitting a card. This
   reuses the exact same schemas the tool/seam uses — single source of
   truth (invariant #9). The sink imports the schemas from
   `src/seam/schema.ts` (importing FROM a core layer is allowed; the
   grep guard only prevents core layers from importing pi, not the
   reverse).

4. **The card is render-time only.** It does not persist anything, does
   not change the reducer, does not change the FSM, and does not add
   new record types. It is a UX-only `customType` + `MessageRenderer`,
   following the existing `conduct.role.text` pattern in
   `src/extension/conduct-message-renderer.ts`.

5. **Lever B (prompt-side) is model-dependent but low-risk.** Updating
   `.pi/roles/*.md` and the tool descriptions in `src/host/tools.ts`
   to instruct the LLM not to narrate tool calls in text is a
   best-effort prompt change. It does not change the tool's `execute`
   logic (the description is model-facing text only). No existing test
   asserts the exact description string (verified by grep).

→ Correct me now or I'll proceed with these.

## Data availability (grounded in the actual code)

### `tool_execution_start` event args (`src/host/session-event-handler.ts:112-118`)

The host's per-session event handler already reads the `tool_execution_start`
event and forwards it to the display sink. The SDK event carries:

| Field | Type | Notes |
|---|---|---|
| `event.type` | `"tool_execution_start"` | discriminant |
| `event.toolName` | `string` | e.g. `"handoff"`, `"end"`, `"bash"` |
| `event.args` | `unknown` | the raw LLM-provided args object |

The handler currently stringifies these into `event.text` as
`"${toolName}: ${JSON.stringify(args)}"` and discards the structured
form. **This spec widens `DisplayEvent` to also carry `toolName` and
`args` as optional fields** (see R1), so the sink can read them
without re-parsing JSON.

### `handoffArgsSchema` / `endArgsSchema` (`src/seam/schema.ts:42-68`)

The TypeBox schemas that validate the tool args (single source of
truth, invariant #9):

| Schema | Required | Optional | Additional |
|---|---|---|---|
| `handoffArgsSchema` | `target_role: string (minLength 1)` | `reason?: string`, `suggests_next?: string` | `additionalProperties: true` (permits `payload` and role-defined fields) |
| `endArgsSchema` | — | `reason?: string` | `additionalProperties: true` |

The `HandoffArgs` / `EndArgs` types (derived via `Static<>`) are the
host's typed view. The `payload` field is NOT a named field in the
schema — it is an additional property the LLM includes in practice
(visible in both user screenshots). Accessing it requires a cast:
`(args as Record<string, unknown>).payload`.

### What the extension can read (no reducer/persistence changes)

- **At the display sink** (`src/extension/display-sink-wiring.ts`):
  the `tool_execution_start` event arrives with `toolName` and `args`
  (after the `DisplayEvent` widening). The sink validates `args`
  against the schema and, if valid, emits a `conduct.handoff`
  `CustomMessage` with the parsed fields as `details`.
- **No host-loop changes.** The loop's `validateEmission` + `reduce`
  path is untouched. The card is emitted at the sink, before the loop
  reads the capture buffer. A schema-invalid tool call (which the loop
  records as a `session_failed` breach) does NOT render a card — the
  sink's `Value.Check` fails first and the event is suppressed.

**Conclusion:** all data the user wants (`target_role`, `reason`,
`suggests_next`, `payload`) is available in the tool call args at the
display sink. This is a **rendering-only** change that reuses existing
schemas. No new data is invented; no persisted record is changed.

## User-facing requirements

### R1 — Widen `DisplayEvent` to carry structured tool args

The `DisplayEvent` type in `src/host/display-sink.ts` gains two
optional fields:

```ts
export interface DisplayEvent {
  readonly role: Role;
  readonly kind: DisplayEventKind;
  readonly text: string;
  /** Tool name, set only for `tool_call` / `tool_result` events. */
  readonly toolName?: string;
  /** Raw tool args, set only for `tool_call` events. */
  readonly args?: unknown;
}
```

`session-event-handler.ts` populates `toolName` and `args` on
`tool_execution_start` events (it already reads `event.toolName` and
`event.args`; it just wasn't forwarding them as structured fields).
Text events and `tool_result` events do NOT set these fields (they
remain absent — `exactOptionalPropertyTypes` requires omission, not
`undefined`).

This is a backward-compatible widening: existing consumers that only
read `role` / `kind` / `text` are unaffected. The `text` field is
preserved (it still carries the stringified form for any consumer that
reads it).

### R2 — Display sink emits a `conduct.handoff` card for handoff/end tool calls

The display sink (`src/extension/display-sink-wiring.ts`) gains a
branch for `tool_call` events where `event.toolName` is `"handoff"` or
`"end"`:

1. **Validate** the args against the schema:
   - `handoff` → `Value.Check(handoffArgsSchema, event.args)`
   - `end` → `Value.Check(endArgsSchema, event.args)`
2. **If valid:** emit a `conduct.handoff` `CustomMessage` with:
   - `customType: "conduct.handoff"`
   - `content`: a plaintext one-line fallback (e.g.
     `orchestrator → worker — reason: …`) so the default
     `CustomMessageComponent` still shows something useful if the
     renderer fails.
   - `details`: a `HandoffCardDetails` object (see R3) carrying the
     parsed fields + the emitting role + `is_orchestrator`.
   - `display: true`
3. **If invalid:** suppress (do NOT emit a card). The loop will record
   a `session_failed` breach; the user does not see a malformed card.
4. **Non-handoff/non-end tool calls** (e.g. `bash`, `read`): still
   suppressed (Phase 5.5 behavior unchanged).

The `tool_result` events remain suppressed for all tools (Phase 5.5
behavior unchanged).

### R3 — `HandoffCardDetails` shape

The seam contract between the sink (writer) and the renderer (reader):

```ts
export interface HandoffCardDetails {
  /** The emitting role (the role that called the tool). */
  readonly role: string;
  /** Which machine tool was called. */
  readonly tool: "handoff" | "end";
  /** Target role for handoff; "done" for end. */
  readonly target: string;
  /** True when the emitting role is the active run's orchestrator. */
  readonly is_orchestrator: boolean;
  /** Optional reason from the tool args. */
  readonly reason?: string;
  /** Optional suggests_next from the tool args (handoff only). */
  readonly suggests_next?: string;
  /** Optional payload from the tool args, rendered only when it is a string. */
  readonly payload?: string;
}
```

`payload` is accessed as `(args as Record<string, unknown>).payload`
and included in `details` **only when it is a string**. Non-string
payloads (objects, arrays, numbers) are skipped in v1 — the user can
see them in the per-role session JSONL. This avoids a silent fallback
(AGENTS.md: "No silent fallbacks") while covering the common case (the
LLM passes a string instruction, as seen in both screenshots).

### R4 — Handoff card renderer

A new conductor-owned `MessageRenderer` for the `conduct.handoff`
`customType`, following the `conduct-message-renderer.ts` pattern. The
renderer produces a `Container` with:

1. **Label line** (`Text`, bolded via `theme.bold`, colored by role
   family — same `pickLabelColor` logic as the text renderer):
   `<role> → <target>` (e.g. `orchestrator → worker`, `worker → done`).
2. **Body** (`Markdown`, via `getMarkdownTheme()`): the structured
   fields, one per line:
   - `**reason:** <reason>` (only if `reason` is present)
   - `**suggests_next:** <suggests_next>` (only if present; handoff only)
   - `**payload:** <payload>` (only if present and string)

The renderer is fail-safe (returns `undefined` on any throw, so the
default `CustomMessageComponent` takes over and shows the `content`
fallback). The renderer is registered at extension factory time and
reused across runs (the `is_orchestrator` flag is on `details`, not
read from a live slot — same pattern as the text renderer).

**Card layout (Q2 resolution): compact multi-line block, not one-line.**
The card is 2–4 lines (label + up to 3 field lines). This is "compact"
relative to a full timeline widget (Q3 in the Phase 8 spec, deferred).
A one-line format would truncate `reason` / `payload` and defeat the
user's goal of reading the handoff content.

### R5 — Prompt-side: instruct the LLM not to narrate tool calls

Two complementary changes:

1. **`.pi/roles/*.md`** (all four role files: `orchestrator.md`,
   `implementer.md`, `planner.md`, `reviewer.md`): add a behavioral
   constraint: "Do not narrate tool calls in text. The TUI renders
   tool activity as structured cards; your text output should be your
   reasoning and decisions, not a restatement of tool arguments or
   results."

2. **`src/host/tools.ts`** handoff + end tool descriptions: append a
   hint: "Do not also write this as text — the TUI renders the handoff
   as a structured card." The description is model-facing text only;
   it does not change the tool's `execute` logic. No existing test
   asserts the exact description string (verified by grep).

This is **model-dependent** (an LLM may still narrate despite the
instruction), which is why Lever A (the renderer card) is the
authoritative fix. Lever B reduces the noise for compliant models.

## Non-goals

- **No new event types, no reducer changes, no `reduceLifecycle`
  changes, no FSM spec changes.** The FSM (`src/core/`) is untouched.
  Invariants #1–#10 hold.
- **No host spawn-loop changes.** `src/host/loop.ts`,
  `production-host.ts`, `run-handle.ts`, `stats.ts` are NOT modified.
  The only host files touched are `display-sink.ts` (type widening)
  and `session-event-handler.ts` (populating the new fields) and
  `tools.ts` (description text only).
- **No `ctx.newSession()` / `ctx.fork()` in `extensions/`.**
  (invariant #10; grep-guard enforces.)
- **No new persisted record type.** The card is render-time only; it
  does not append records to the log.
- **No text filtering.** The sink does NOT strip the LLM's
  `handoff: {JSON}` text from the text event (Q3 resolution). The
  prompt update (R5) addresses the source; the card (R2–R4) provides
  the readable alternative. Adding text filtering to the
  deliberately-minimal Phase 5.5 sink would be out of character and
  fragile (the LLM's narration format is not contractual).
- **No full run-browser / paginated timeline TUI widget.** The card
  is per-handoff in the stream. A dedicated viewer is a future phase
  (Phase 8 Q3, deferred).
- **No non-string `payload` rendering.** Object/array/number payloads
  are skipped in v1; the user can see them in the session JSONL.
- **No `payload_summary.reason` enrichment.** The Phase 8 Q2 gap
  (host never enriches the persisted record's `payload_summary.reason`)
  remains filed and out of scope. This spec reads the tool args, not
  the persisted record.

## Boundaries

- **Always:**
  - Keep all new rendering code in `src/extension/` and `extensions/`.
    The only `src/host/` touches are: `display-sink.ts` (type
    widening), `session-event-handler.ts` (populating new fields),
    `tools.ts` (description text). Core layers (`src/core`,
    `src/manifest`, `src/seam`, `src/cost`, `src/persistence`) remain
    pi-import-free (invariant #1; grep-guard enforces).
  - Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
    `pnpm format:check` clean after every task. The grep-guard test
    must pass.
  - New files stay under the ~400 LOC ceiling, single-purpose, named
    exports, JSDoc on public exports.
  - Reuse `handoffArgsSchema` / `endArgsSchema` from
    `src/seam/schema.ts` for validation (single source of truth,
    invariant #9). Do NOT create a second schema.
  - Follow the existing `conduct-message-renderer.ts` pattern: thin
    closure over a container builder, `pickLabelColor` for the label,
    `getMarkdownTheme()` for the body, fail-safe try/catch.
- **Ask first:**
  - Adding a new `customType` + `MessageRenderer` — this is
    explicitly in scope (R4), not an escalation.
  - Widening `DisplayEvent` with optional fields — this is explicitly
    in scope (R1), a backward-compatible host-layer change.
- **Never:**
  - Modify `src/core/`, `src/manifest/` for this work. `src/seam/` is
    read-only (import schemas only; do not modify).
  - Call `ctx.newSession()` / `ctx.fork()` from `extensions/`.
  - Persist new record types or mutate the append-only log.
  - Render a card for a schema-invalid tool call (would be a silent
    fallback on malformed data — AGENTS.md: "No silent fallbacks").
  - Strip or filter the LLM's text narration (Q3: don't filter).
  - Add a `reason` field to the card that is not from the tool args
    (the persisted record's `payload_summary.reason` is a placeholder;
    do not use it).

## Acceptance criteria

The overseer verifies end-to-end (a manual `/conduct` run with a real
model is the final proof, per the Phase 7A.5 / 7C.2 posture). Checkboxes
are ticked only when actually verified.

- [ ] **AC1 — `DisplayEvent` widening:** `DisplayEvent` carries
      optional `toolName` and `args` fields; `session-event-handler.ts`
      populates them on `tool_execution_start`. Existing text-event
      consumers are unaffected (backward compatible).
- [ ] **AC2 — Handoff card renders in the TUI stream:** during a
      `/conduct` run with at least one `orchestrator → worker`
      handoff, the TUI shows a structured card (not JSON) with the
      role label, target, and any present `reason` / `suggests_next` /
      `payload` fields.
- [ ] **AC3 — End card renders:** the `end` tool call renders a card
      `orchestrator → done` with `reason` if present.
- [ ] **AC4 — Schema-invalid args do not render a card:** a
      malformed handoff tool call (fails `Value.Check`) is suppressed
      at the sink; no card appears. The loop records the breach as
      usual.
- [ ] **AC5 — Non-handoff tools still suppressed:** `bash`, `read`,
      and other built-in/custom tool calls do NOT produce cards
      (Phase 5.5 behavior preserved).
- [ ] **AC6 — Card is model-independent:** the card renders from the
      tool call args, not from the LLM's text narration. Even if the
      LLM also narrates the handoff in text, the card appears
      (Lever A is authoritative; Lever B is best-effort).
- [ ] **AC7 — Prompt update reduces narration:** the updated
      `.pi/roles/*.md` and tool descriptions instruct the LLM not to
      narrate tool calls. (Model-dependent; verified by manual run.)
- [ ] **AC8 — Grep guard green:** `tests/grep-guard.test.ts` passes
      (no new pi imports in core layers; no `ctx.newSession`/`ctx.fork`
      in `extensions/`).
- [ ] **AC9 — Full gate green:** `pnpm typecheck && pnpm build &&
      pnpm test && pnpm lint && pnpm format:check` all clean.
- [ ] **AC10 — Docs updated:** `docs/extension-usage.md` documents
      the handoff card surface (what it shows, when it appears, the
      `conduct.handoff` customType).

## Open questions / decisions for the overseer (end-of-loop review)

- **Q1 — Card source: tool_call vs tool_result.**
  `tool_execution_start` has the raw LLM-provided args (may be
  malformed). `tool_execution_end` has the tool's return value
  (validated, but only `details.target_role` survives — the full args
  don't round-trip through the result).
  *Planner default:* **Use `tool_execution_start` (tool_call) args.**
  Validate at the sink with `Value.Check` against the schema before
  emitting. If invalid, suppress the card (the loop records the
  breach). This is the cleanest path: the args are full JSON with all
  fields, and the schema check is the same one the seam uses. Using
  `tool_execution_end` would lose `reason` / `suggests_next` /
  `payload` (only `target_role` survives in the result's `details`).

- **Q2 — Card layout: compact one-line vs multi-line block.**
  *Planner default:* **Compact multi-line block (2–4 lines).** A
  one-line format would truncate `reason` / `payload` and defeat the
  user's goal of reading the handoff content. The block is still
  "compact" relative to a full timeline widget (Phase 8 Q3, deferred).
  One-line can be a follow-up if the user finds the block too tall.

- **Q3 — Should the card replace the LLM's text narrative?**
  *Planner default:* **No — do not filter text.** The sink stays
  minimal (Phase 5.5 posture). The prompt update (R5) addresses the
  source; the card provides the readable alternative. Adding text
  filtering would be fragile (the LLM's narration format is not
  contractual) and out of character for the deliberately-minimal sink.
  Trade-off: the user may see both the card and the LLM's JSON
  narration for models that don't comply with the prompt instruction.
  Lever A (the card) is always correct; Lever B (the prompt) reduces
  the noise.

- **Q4 — Backward compatibility for old runs.**
  *Planner default:* **No migration needed.** The card is a
  render-time feature; it does not persist anything. Old runs continue
  to work (they just don't get cards for past transitions — the cards
  are emitted live from the tool call event, not from the log).

- **Q5 — Worker roles: prompt update scope.**
  *Planner default:* **All roles with the handoff tool.** Every role
  in the manifest has `handoff` + `end` tools; every role file gets
  the "do not narrate tool calls" instruction. This is consistent and
  prevents any role from producing JSON narration.

## Overseer decisions (2026-06-20)

> **Awaiting overseer acknowledgment.** The planner defaults for Q1–Q5
> are proposed above. If the overseer accepts all defaults, this
> section is ticked and implementation may begin. If any default is
> overridden, the override is recorded here before implementation
> starts.

- [ ] **Q1 — Card source:** tool_call args, validated at the sink
      with `Value.Check`. (Planner default.)
- [ ] **Q2 — Card layout:** compact multi-line block (2–4 lines).
      (Planner default.)
- [ ] **Q3 — Text filtering:** no — do not filter the LLM's text
      narration. (Planner default.)
- [ ] **Q4 — Backward compatibility:** no migration needed.
      (Planner default.)
- [ ] **Q5 — Prompt scope:** all roles with the handoff tool.
      (Planner default.)
