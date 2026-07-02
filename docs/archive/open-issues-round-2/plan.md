# Plan — Round 2: Resolve Remaining Open Issues #8 and #9

**Source:** GH issues `#8` (bug, TUI disjointed output) and `#9` (bug, agent
roles confused when resuming) on `lynellf/pi-conductor`, both opened
2026-07-02 by the repo owner. Issues `#5` and `#6` are also on the open
list but were resolved previously (see `Phase 0: housekeeping` below).

**Investigated by:** this planner via `gh issue view`, source inspection,
and OKF consumption. (The orchestrator routed the issues here after a
researcher pass surfaced them; this planner's job is sequencing and
spec translation.)

## Status of all four open issues at plan time

| # | Title | Label(s) | Status at plan time | Action |
|---|-------|----------|---------------------|--------|
| 5 | `docs/record-emitter-spec.md` for `subscribeToRecords` contract | docs, enhancement | **Already implemented** | Close with comment (Phase 0) |
| 6 | Pre-flight check: warn on unregistered providers | enhancement | **Already implemented** | Close with comment (Phase 0) |
| 8 | Disjointed TUI output | bug | Open | Implement (Phase 1) |
| 9 | Agent roles confused when resuming | bug | Open | Implement (Phase 2) |

**Evidence that #5 and #6 are resolved:**

- **`#5` — `docs/record-emitter-spec.md` exists at the canonical path
  and consolidates the full `subscribeToRecords` contract** (FIFO, fire-
  and-forget async, sync-throw/async-rejection isolation, re-entrant
  subscribe/unsubscribe, idempotent unsubscribe, empty-set fast path,
  durable backstop, OOS) into §1–§7. `src/host/record-emitter.ts` JSDoc
  and `tests/host/record-emitter.test.ts` header were trimmed in commit
  `9b1f354` (`feat: record-emitter public API, bump to 0.4.0`) to point
  at the spec. The implementation plan at
  `docs/archive/issues-5-and-6/phase-1-record-emitter-spec.md` and the
  outcome at `docs/archive/issues-5-and-6/archive.md` both confirm the
  work landed. The matching OKF durability doc lives at
  `.okf/components/record-emitter.md`. **No code change needed.**

- **`#6` — `checkModelProvidersRegistered` runs at manifest-load time
  when a `ModelRegistry` is supplied.** Commit `44a4397`
  (`feat: add model registry support for provider registration checks`)
  adds the function in `src/host/manifest.ts:133` and wires it through
  `loadManifest`/`loadManifestFromString` (lines 169, 194, 245). The
  preflight emits `"unregistered-provider"` warnings on
  `LoadedManifest.warnings`; both `startRun` and `resumeRun` accept the
  optional `modelRegistry` via `StartRunOptions`/`ResumeRunOptions` in
  `src/host/api.ts`. Extension forwards `ctx.modelRegistry` in
  `src/extension/commands/start.ts` and `resume.ts`; CLI forwards via
  `src/bin/conduct.ts`. Full coverage in
  `tests/host/manifest.test.ts` (T2.9), `tests/host/api.test.ts`
  (T2.10), `tests/host/run-handle.test.ts` (T2.11),
  `tests/bin/conduct.test.ts` (T2.12). The matching OKF durability doc
  lives at `.okf/concepts/manifest-validation-boundary.md`. **No code
  change needed.**

The repo owner's open-issues list went stale; the issues were not closed
when the work landed.

## What this plan implements

Two real open bugs:

- **Issue #8 (TUI disjointed):** When an agent role's streamed output
  is emitted as `conduct.role.text_stream` `CustomMessage`s, each chunk
  becomes a separate visual block in pi's TUI (line breaks between
  chunks). The user wants one continuous block of text per turn —
  whether thinking or direct output.

- **Issue #9 (resume context):** On `/conduct:resume <run_id>`, the
  orchestrator session is seeded with an **empty** goal (`""`) in the
  run-memory artifact. The agent role has no idea what the run was
  originally trying to accomplish, leading to confused behavior when
  the orchestrator re-engages after a worker handoff. Context from the
  persisted telemetry is only partial.

## Sequencing

The two issues are independent — different subsystems, different
acceptance criteria, no overlapping files.

| Phase | Issue | Files touched (rough estimate) | Risk | Independent? |
|-------|-------|-------------------------------|------|--------------|
| 0 — Housekeeping | #5, #6 | none (`gh` CLI only) | none | yes |
| 1 — Issue #8 (TUI) | #8 | 1 extension file, 1 host file, ~3 test files, OKF note | medium (UX trade-off) | yes |
| 2 — Issue #9 (resume) | #9 | 1–3 host files, 1 persistence record type, ~3 test files | low (additive) | yes |

**Order:** Phase 0 first (low risk, immediate cleanup). Phases 1 and 2
can run in parallel (different surfaces). If resources force sequential,
do Phase 1 first (more user-visible UX win) then Phase 2 (resume is
opt-in, lower-frequency code path).

## Architecture decisions

### Issue #8 — TUI disjointed fix: trade-off surfaced

**Root cause (verified):** pi's
`CustomMessageComponent` (in
`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-message.js`)
hardcodes a leading `Spacer(1)` in its constructor before the renderer
slot is filled:

```js
this.addChild(new Spacer(1)); // line 19 — always present
// ...
this.addChild(component);     // line 36 — renderer's component added after
```

There is no SDK API to suppress the leading Spacer from a `MessageRenderer`.
The only way to keep the user's "one continuous block of text" request
honest is to **not emit multiple `CustomMessage`s per assistant turn** —
i.e. remove the per-chunk emission and emit one `conduct.role.text` per
turn, at `message_end`.

**Trade-off.** Loss of live progressive text rendering. Today the user
sees the role's text "type out" via `text_stream` flushes (`boundary-flush.ts`
boundaries: paragraph → line → sentence → word → max-window); after the
fix, text appears all at once at the end of the assistant turn. Tool
events (`conduct.role.tool`) remain per-event — they are atomic and not
affected. Thinking content (`> ...` blockquotes) gets the same
treatment: it now appears as part of the single continuous text block
rather than as multiple prefixed chunks.

**Why "buffer + single emission" beats other options considered:**

- *Option B: keep streaming, fix the Spacer via renderer.* Not viable —
  the leading Spacer is hardcoded in `CustomMessageComponent`'s
  constructor, not a render-time decision. Any "fix" from the renderer
  side would have to monkey-patch the framework.
- *Option C: keep streaming, render chunks in a single TUI element.* Not
  viable — `pi.sendMessage` only adds new `CustomMessage`s; the SDK has
  no in-place update or stream API.

The trade-off is real and surface in the phase-1 doc so the overseer
can override before implementation starts.

### Issue #9 — Resume context fix: where to persist the goal

**Root cause (verified):** `src/extension/commands/resume.ts:111` passes
`goal: ""` to `resumeRun`. The loop at `src/host/loop.ts:265` seeds
orchestrator sessions with `formatRunMemorySeed(runMemory)` whose
`runMemory.goal` is `opts.initialGoal` (the empty string). The
orchestrator LLM therefore sees `goal: ` (empty) on resume, plus
`visit_history` and `last_message` — but no statement of what it was
trying to accomplish.

**Decision:** Persist the goal as a new `PersistedRecord` variant
`"run_seeded"` (a host-owned, non-machine-event record akin to
`checkpoint_snapshot`). Append at `startRun` time alongside the initial
`checkpoint_snapshot`. Read on `resumeRun` from the log (latest
`run_seeded` for the `run_id`) and use as `initialGoal`. Subsequent
orchestrator sessions within the same resumed run see the original
goal in the run memory.

**Why a new record, not a `Checkpoint` field:**

- `Checkpoint` is an append-only, frozen snapshot (`spec §11.1`). Adding
  a new required field is a schema break for any in-flight runs and
  tests; making it optional adds a "missing goal" branch everywhere the
  snapshot is read.
- A `run_seeded` record mirrors the existing `checkpoint_snapshot`
  precedent: a host-owned, non-machine-event record wrapping
  run-level data the reducer never branches on (`PersistedRecord`
  union at `src/persistence/log.ts:44`).
- The loop's `initialGoal` flows through unchanged; `formatRunMemorySeed`
  reads `memory.goal` and never inspects where it came from. No reducer
  changes required (host-agnostic core preserved).

**Out of scope for both issues:** changing the spec, changing record
shapes the reducer cares about, adding new permissions/tools, changing
the SDK contract surface.

## Acceptance criteria

The plan as a whole is "done" when:

- [ ] Issues `#5` and `#6` are closed with comments pointing at the
      existing implementation, so the open-issues tab reflects reality.
- [ ] Issue `#8` is closed: `conduct.role.text` is the sole label for
      per-message text/thinking output (one continuous block per turn);
      `tests/host/display-forwarding.test.ts` has a new case pinning the
      stream-leak constraint (`text_stream` no longer surfaces, OR its
      renderer is registered but never receives events).
- [ ] Issue `#9` is closed: `/conduct:resume <run_id>` resumes with the
      original goal restored (verified by replaying the run-memory seed
      in a unit test).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all
      green after each phase.
- [ ] No `Checkpoint` schema change; no reducer change; no FSM contract
      change.
- [ ] One OKF durability note added per implementer's discretion
      (managed by `okf-curator`, not by the implementer).

## Phase index

| Phase | File | Issue(s) | Sub-plan |
|-------|------|----------|----------|
| 0 | `phase-0-housekeeping.md` | #5, #6 | close via `gh` with comments |
| 1 | `phase-1-issue-8-tui-disjointed.md` | #8 | design + implement TUI fix |
| 2 | `phase-2-issue-9-resume-context.md` | #9 | design + implement resume fix |

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| User wants live progressive text UX back after Phase 1 ships | Medium — UX regression for users who liked the "typing" feel | Surface the trade-off in `phase-1-issue-8-tui-disjointed.md`'s "Design decisions" before implementation; gate on overseer sign-off |
| A new `run_seeded` record type leaks into reducer or core types | Low — `PersistedRecord` is a host-side union | Reviewer check: `git grep "run_seeded" src/core` returns zero hits before merge |
| Backwards compat for in-flight / persisted runs without `run_seeded` | Low — `resumeRun` would fall back to `goal: ""` | `resumeRun` reads the latest `run_seeded`; absent record → `goal: ""` (existing behavior). New runs start with the record. Documented in `phase-2-issue-9-resume-context.md`. |
| Behavior change to `bound-finding` / `markdown-continuation.ts` is unintended | Low — these modules are unrelated to the chosen fix | Leave both modules unchanged in this round; the stream-leak constraint they were built to support is going away |

## Open questions for the overseer

1. **Phase 1 UX trade-off:** is losing live progressive text rendering
   an acceptable cost for "one continuous block of text"? The fix
   is reversible (the `text_stream` plumbing is preserved behind a
   feature flag if desired), but the question should be answered
   before implementation starts.
2. **Phase 2 goal persistence shape:** is `run_seeded` (new record
   type) the right vehicle, or should the goal be inlined into the
   first `checkpoint_snapshot` (one less record type to remember)?
3. **Should `extension/commands/resume.ts` allow overriding the goal
   at resume time** (`/conduct:resume <run_id> [--goal <text>]`), or
   is the goal strictly the persisted original? The current empty-string
   behavior is the simplest, but allowing a goal override on resume is
   a future-friendly UX (resume a run *with a different goal*, which
   in practice means "redirect the orchestrator").

The phase docs include a Task 0 for each issue that lands the answer.

## Telemetry (plan-time)

- `okf_docs_read`: 5
  (`.okf/components/record-emitter.md`,
  `.okf/concepts/manifest-validation-boundary.md`,
  `.okf/concepts/model-id-provider-colon-format.md`,
  `.okf/pitfalls/chunk-boundary-blockquote-loss.md`,
  `.okf/components/markdown-continuation.md`)
- `okf_tokens_read`: ~5.5K
- `files_scanned_before_okf`: 1 (`.okf/` directory listing)
- `files_scanned_after_okf`: ~28 (`api.ts`, `loop.ts`, `display-sink.ts`,
  `session-event-handler.ts`, `boundary-flush.ts`,
  `markdown-continuation.ts`, `display-sink-wiring.ts`,
  `conduct-message-renderer.ts`, `start.ts`, `resume.ts`, `host.ts`,
  `run-handle.ts`, `run-memory.ts`, `core/run-memory.ts`,
  `persistence/log.ts`, `custom-message.js`, pi SDK type definitions,
  issue bodies for #5/#6/#8/#9, `docs/archive/issues-5-and-6/{plan,archive}.md`,
  `tests/host/{api,resume,run-memory}.test.ts` excerpts,
  `tests/extension/tui-bridge.test.ts`)
- `repo_scan_tokens_before_okf`: ~3K (`.okf/` enumeration)
- `repo_scan_tokens_after_okf`: ~40K (substantive reads)
- `stale_okf_hits`: 0
- `missing_okf_hits`: 0
- `planner_cost_before_okf`: ~unknown
- `planner_cost_after_okf`: ~unknown

## Knowledge candidates (for `okf-curator` follow-on, not blocking)

- "pi TUI's `CustomMessageComponent` always renders a leading
  `Spacer(1)` per `CustomMessage`. There is no renderer-side
  mitigation. To produce one continuous visual block per turn,
  emit exactly one `CustomMessage` per assistant turn — multiple
  chunks always produce visual gaps." (Stable SDK constraint; load-
  bearing for any future `conduct.role.*` renderer.)
- "Run-start goal now persists in the run log as a `run_seeded`
  record. `resumeRun` reconstructs the original goal from
  `run_seeded` records instead of taking it as a CLI/extension
  argument. The host-agnostic core is unchanged; the goal lives
  where all other host-side run-level metadata lives." (Stable
  architectural decision; explains why `resumeRun`'s `goal` arg
  is now effectively cosmetic.)
