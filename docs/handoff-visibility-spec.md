# Spec: Handoff visibility in the pi-conductor extension UX

> Status: **Acknowledged 2026-06-20 by orchestrator (acting as overseer proxy).** Open questions Q1–Q5 resolved with the planner defaults (see Overseer decisions section at the bottom). Implementation may begin.
> Authority chain: `docs/orchestrator-fsm-spec.md` (FSM/records, untouched) →
> `docs/extension-pivot-plan.md` (delivery shape) → this spec (UX-only change).
> Author: planner role. Date: 2026-06-20.

## Objective

The end user of the `pi-conductor` pi extension cannot currently see **role
transitions (handoffs)** while a run is in progress or after it ends. The
status line shows only `conduct: <state> · <exit_reason> · $<cost>`
(`src/extension/status.ts`); the TUI stream deliberately suppresses the
`handoff`/`end` tool protocol noise (`src/extension/display-sink-wiring.ts`,
Phase 5.5); and `/conduct:list` renders one summary line per run with no
transition history (`src/extension/commands/list.ts`).

The user wants handoffs **displayed between the orchestrator and other agent
roles** — i.e., a visible record of "orchestrator → worker", "worker →
orchestrator", "orchestrator → done", etc., during and after a run.

**Success looks like:** during a `/conduct` (or `/conduct:resume`) run, each
accepted handoff is surfaced to the user as it happens; and after a run (or in
`/conduct:list`), the ordered sequence of handoffs for a run is visible. No
new event types, no reducer changes, no host-spawn-loop changes.

### Assumptions I'm making

1. The handoff data the user wants is the **`transition_accepted` records**
   already persisted to the `RecordLog` (spec §11.2). I am **not** inventing
   new data — see *Data availability* below for exactly what fields exist.
2. The rendering surface is the same one the extension already uses:
   `ctx.ui.notify(msg, type)` for discrete notifications and
   `ctx.ui.setStatus(key, text)` for the footer line. A conductor-owned
   `MessageRenderer` for a new `customType` is also available (the Phase 5
   renderer pattern), but I am treating the notify-based path as the default
   to keep the change small and avoid a second renderer.
3. "Displayed between the orchestrator and other agent roles" means the
   *transitions* are visible, not that role-session transcripts are merged
   into the TUI stream (the streaming surface already shows each role's text
   + reasoning via `conduct.role.text`).
4. The overseer wants a **minimal, boring** first cut (AGENTS.md: "Readability
   over cleverness"). A formatted handoff line per transition is the v1; a
   richer timeline widget is an explicit open question, not a v1 deliverable.

→ Correct me now or I'll proceed with these.

## Data availability (grounded in the actual record shapes)

This is the authoritative inventory of what a handoff display can read. **The
spec does not invent fields that do not exist on the record.**

### `TransitionAccepted` (`src/core/types.ts`, §11.2)

Persisted by the host loop after every accepted `handoff` / `end` transition.
Available fields on the record:

| Field | Type | Notes |
|---|---|---|
| `type` | `"transition_accepted"` | discriminant |
| `run_id` | `string` | |
| `from` | `Role \| "done"` | the previous role |
| `to` | `Role \| "done"` | the new role after the transition |
| `event` | `"handoff" \| "end"` | **the handoff discriminator** |
| `target_role` | `Role \| null` | non-null for `handoff`; `null` for `end` |
| `role` | `Role` | the emitting role (the role that issued the event) |
| `suggests_next` | `Role \| null` | **populated** by the reducer (`extractSuggestsNext`) |
| `payload_summary` | `{ reason?, suggests_next?, field_names }` | **PLACEHOLDER** — reducer emits `{ field_names: [] }` with no `reason`; the host loop does NOT enrich it (the seam enrichment described in `reduce.ts` is unimplemented). **`payload_summary.reason` is NOT reliably available.** |
| `guard` | `string \| null` | |
| `effect` | `readonly string[]` | e.g. `["visit_count[worker] += 1"]` |
| `session_file` | `string` | |
| `ts` | `number` | epoch ms |

### `RunStats.transitionHistory` (`src/host/stats.ts`)

The pure projection `runStats()` already exposes a narrower `TransitionRecord`
per transition: `{ type, event, from, to, targetRole, ts }`. It does **not**
carry `suggests_next` or `role`. This is what `RunHandle.runStats()` returns
during a live run (the status poller already calls it every 250 ms).

### What the extension can already read (no host changes)

- **During a run:** `RunHandle.runStats().transitionHistory` (via the active
  handle in `src/extension/active-run.ts`). Gives `from`/`to`/`event`/`ts`.
- **After a run / in `/conduct:list`:** `FileRecordLog.records(runId)` returns
  the full `PersistedRecord[]` (already imported in the list handler). The
  extension can filter to `transition_accepted` records and read the richer
  fields (`suggests_next`, `role`, `target_role`) directly.

**Conclusion:** all data the user wants already exists in the log. This is a
**rendering-only** change. The one field the user might expect but cannot get
reliably is a human-readable `reason` for the handoff — see *Open questions*.

## User-facing requirements

### R1 — Live handoff notifications during a run

While `/conduct` or `/conduct:resume` is active, each **new** accepted
`handoff` (and `end`) transition is surfaced to the user as it is persisted.

- **When:** as soon as the transition appears in `transitionHistory` and was
  not present on the previous poller tick. The status poller (250 ms) already
  calls `runStats()`; the new behavior diffs `transitionHistory` length /
  contents against the last tick and emits a notification for each new entry.
- **Where:** `ctx.ui.notify(msg, "info")` — the same surface already used for
  the terminal notification. (Using `notify` keeps the change to the poller
  path and avoids a second `MessageRenderer`. A richer in-stream widget is an
  open question.)
- **Format (v1):** a single line per transition, e.g.
  `conduct: orchestrator → worker  (suggests_next: implementer)` or, for end,
  `conduct: worker → done`. The `→` arrow + role names mirror the FSM's
  `from`/`to` vocabulary. `suggests_next` is appended only when present
  (`Role | null`); `reason` is omitted (not reliably available — see data
  inventory). `end` transitions render `→ done`.
- **Ordering:** transitions appear in append order (the poller emits them in
  the order they appear in `transitionHistory`).
- **No double-emit:** the poller tracks the last-seen transition count (or the
  last-seen `ts` of the final entry) so a transition is notified exactly once
  even across poller ticks. On resume, the poller starts from the current
  history length (transitions that happened before the resume are NOT
  re-notified — they are historical; see R3).

### R2 — Status line shows the latest transition count

The existing footer line (`conduct: <state> · <exit_reason> · $<cost>`) is
augmented with a handoff counter so the user can see at a glance how many
transitions have occurred without scrolling notifications:

- **Format:** `conduct: <state> · <exit_reason> · handoffs=<N> · $<cost>`
  where `N` is the count of `transition_accepted` records with
  `event === "handoff"` in the current `transitionHistory`.
- This is a one-token addition to `formatConductStatus`; it does not change
  the line's bounded width materially (the footer is shared; the count is a
  small integer).
- `end` transitions are NOT counted in `handoffs=` (they are terminal, not
  handoffs); they are reflected in `exit_reason`/`state` already.

### R3 — `/conduct:list` shows a compact handoff timeline per run

`/conduct:list` currently renders one line per run:
`<runId> · <state> · <exitReason> · $<cost>`. It is augmented with a compact
transition summary so the user can see the role flow of each run at a glance.

- **Per-run line gains a transition trace:** the ordered sequence of
  `from → to` pairs for that run, joined, e.g.
  `orchestrator → worker → orchestrator → done`.
- **Source:** the list handler already opens a `FileRecordLog` and calls
  `runStats(records, …)` per run; `transitionHistory` is the source. (The
  richer raw-record read is not needed for the trace — `from`/`to`/`event`
  suffice. `end` transitions render as `→ done`.)
- **Bounded:** the trace is truncated to a reasonable length (e.g. first 6
  hops + `…`) so a long run does not blow out the single-line notify. The
  full timeline is an open question (a dedicated viewer, out of scope for v1).
- The existing per-run fields (`state`, `exitReason`, `$cost`) are preserved;
  the trace is appended.

### R4 — Handoff data shown per entry

Each visible handoff (in R1 notifications and, conceptually, the R3 trace)
shows, from the data inventory:

- **from role** → **to role** (required; always present)
- **`suggests_next`** (optional; shown only when non-null — available on the
  raw record and via `runStats` is NOT, so R1 uses `transitionHistory` which
  omits it; **see Open question Q1** about whether R1 should read raw records
  to get `suggests_next`, or accept the narrower `transitionHistory` shape)
- **order / position** (implied by append order; R3 shows the trace in order)
- **timestamp** (`ts`): NOT shown in v1 (the notify line and the list trace
  stay compact; a timestamped timeline is an open question)

**Explicitly NOT shown in v1** (because not reliably available):
- `payload_summary.reason` — reducer placeholder, host never enriches it.
- `guard`, `effect`, `session_file` — internal; not user-meaningful.

## Non-goals

- **No new event types, no reducer changes, no `reduceLifecycle` changes.**
  The FSM (`src/core/`) is untouched. This is a hard constraint from the
  orchestrator's charter and from AGENTS.md invariants #1–#9.
- **No host spawn-loop changes.** `src/host/loop.ts`, `production-host.ts`,
  `run-handle.ts`, `stats.ts` are NOT modified. (The one candidate host change
  — enriching `payload_summary.reason` at the seam — is filed as an open
  question Q2, explicitly out of scope for this work unless the overseer
  overrides.)
- **No `ctx.newSession()` / `ctx.fork()` in `extensions/`.** (invariant #10;
  the grep guard already enforces this.)
- **No merging of role sessions into pi's session tree.** (§9.5; out of scope.)
- **No new persisted record type.** The handoff display reads existing
  `transition_accepted` records; it does not append new records.
- **No full run-browser / paginated timeline TUI widget.** v1 is notify +
  status-line + list-trace. A richer viewer is Q3.
- **No timestamp rendering in v1.** Compactness wins; timestamps are Q4.

## Boundaries

- **Always:**
  - Keep all new "what the user sees" code in `src/extension/` and/or
    `extensions/`. Core layers (`src/core`, `src/manifest`, `src/seam`,
    `src/cost`, `src/persistence`) must remain pi-import-free (invariant #1;
    grep-guard enforces).
  - Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
    `pnpm format:check` clean after every task. The grep-guard test must pass.
  - New files stay under the ~400 LOC ceiling, single-purpose, named exports,
    JSDoc on public exports.
  - Read handoff data only from `transitionHistory` (live) and
    `FileRecordLog.records()` (historical). Do not invent fields.
- **Ask first:**
  - Adding a new `customType` + `MessageRenderer` for handoffs (would be a
    second renderer alongside `conduct.role.text`). Default is `notify`; only
    escalate if the overseer wants an in-stream widget.
  - Reading `suggests_next` from raw records in the live poller (Q1) — it
    requires the poller to read `handle.log.records()` instead of
    `runStats().transitionHistory`. Minor, but a behavior choice.
  - Implementing the seam-side `payload_summary.reason` enrichment (Q2) —
    touches `src/host/`, currently out of scope.
- **Never:**
  - Modify `src/core/`, `src/manifest/`, `src/seam/`, `src/cost/`,
    `src/persistence/` for this work.
  - Call `ctx.newSession()` / `ctx.fork()` from `extensions/`.
  - Persist new record types or mutate the append-only log.
  - Add a `reason` field to the handoff display that is not reliably
    populated (would be a silent fallback — AGENTS.md: "No silent fallbacks").

## Acceptance criteria

The overseer verifies end-to-end (a manual `/conduct` run with a real model is
fine, per the Phase 7A.5 / 7C.2 posture). Checkboxes are ticked only when
actually verified.

- [x] **AC1 — Live handoff notify:** during a `/conduct` run that performs at
      least one `orchestrator → worker` and one `worker → orchestrator`
      handoff, the user sees a `conduct: <from> → <to>` notification for each
      accepted handoff as it happens (not only at terminal).
- [x] **AC2 — End transition notify:** the run's terminal `end` transition is
      notified as `conduct: <role> → done` (in addition to the existing
      terminal notification).
- [x] **AC3 — Status line counter:** the footer line shows
      `conduct: <state> · <exit_reason> · handoffs=<N> · $<cost>` and `N`
      increments as handoffs occur.
- [x] **AC4 — `/conduct:list` trace:** after the run, `/conduct:list` shows
      the run's transition trace (e.g.
      `orchestrator → worker → orchestrator → done`) in the per-run line.
- [x] **AC5 — No double-emit:** re-running the poller (or a 250 ms tick with
      no new transition) does not re-notify an already-notified transition.
- [x] **AC6 — Resume does not re-notify history:** `/conduct:resume` does not
      emit notifications for transitions that occurred before the resume.
- [x] **AC7 — Grep guard green:** `tests/grep-guard.test.ts` passes (no new
      pi imports in core layers; no `ctx.newSession`/`ctx.fork` in
      `extensions/`).
- [x] **AC8 — Full gate green:** `pnpm typecheck && pnpm build && pnpm test
      && pnpm lint && pnpm format:check` all clean.
- [x] **AC9 — Docs updated:** `docs/extension-usage.md` documents the new
      handoff-visibility surface (live notify, status counter, list trace).

## Open questions / decisions for the overseer (end-of-loop review)

- **Q1 — `suggests_next` in live notifications.** `runStats().transitionHistory`
  (the cheap live path) omits `suggests_next`; the raw
  `FileRecordLog.records()` has it. Should the live poller read raw records to
  surface `suggests_next` in the notify line, or accept the narrower shape for
  v1? *Default (planner recommendation):* v1 uses `transitionHistory` (no
  `suggests_next` in live notify); the list trace also uses `transitionHistory`.
  Surface `suggests_next` only if the overseer wants it and accepts the raw
  read.
- **Q2 — `payload_summary.reason` enrichment (host change).** The reducer
  emits a placeholder and the host never enriches it, so a human-readable
  handoff *reason* is not available today. Implementing the seam enrichment
  would touch `src/host/loop.ts` (out of scope per this charter). Should a
  follow-up task (separate from this UX work) implement the enrichment so a
  future phase can show reasons? *Default:* file as a noted gap; do not block
  this UX work on it.
- **Q3 — Richer timeline widget.** v1 is notify + status counter + list trace.
  Should a later phase add a dedicated `/conduct:trace <run_id>` command or a
  TUI widget with per-transition detail + timestamps? *Default:* open; not v1.
- **Q4 — Timestamps.** v1 omits `ts` for compactness. Should the list trace or
  a future viewer show per-transition timestamps? *Default:* open; not v1.
- **Q5 — `end` transitions in the `handoffs=` counter.** R2 counts only
  `event === "handoff"`. Should `end` be counted separately (e.g.
  `ends=1`)? *Default:* no — `end` is terminal and reflected in
  `exit_reason`/`state`.

## Overseer decisions (2026-06-20)

Acting on the overseer's behalf per AGENTS.md operating model. All five
defaults proposed by the planner are accepted; the user will give feedback
at end-of-loop review if any of these need to change.

- **Q1 — `suggests_next` in live notify:** **deferred (v1 omits it).** Live
  notify reads `transitionHistory`; the narrower shape stays. If the
  overseer wants `suggests_next` surfaced, a follow-up can read raw records
  in the poller.
- **Q2 — `payload_summary.reason` enrichment:** **deferred (out of scope).**
  Noted gap. A future task (separate from this UX work) can implement the
  seam enrichment in `src/host/loop.ts` so a later phase can show reasons.
  This work does NOT touch `src/host/`.
- **Q3 — Richer timeline widget:** **deferred (not v1).** A dedicated viewer
  (TUI widget or `/conduct:trace <run_id>` command) is a future phase.
- **Q4 — Timestamps:** **deferred (not v1).** `ts` is not rendered in v1.
- **Q5 — `end` in `handoffs=` counter:** **deferred (excluded).** Only
  `event === "handoff"` counts; `end` is reflected via `exit_reason`/`state`.
