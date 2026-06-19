# Phase 5 — Cost capture, caps, and observability surfaces

> Sub-plan of `docs/orchestrator-fsm-plan.md`. Read the main plan first for Overview,
> Architecture Decisions, Risks, Open Questions, and whole-plan Verification. Source
> spec: `docs/orchestrator-fsm-spec.md` (§8.2, §9.4, §11.4, §11.6, §11.7, §11.8). SDK
> surface item: usage/cost event shape is **resolved** — see `docs/sdk-surface.md` §3
> and main plan Open Question #6. `usage` is on `message.usage` (`AssistantMessage`),
> camelCase with a nested `cost` object.
>
> **Status:** Task 18 complete (commit `4a2e084`, 2026-06-19). Task 19 next.
> 298/298 tests green; `typecheck` / `build` / `lint` / `format:check` clean.
>
> **Scope:** Host-side usage capture on terminals, per-session + run cost-cap
> enforcement, model fallback on `session_failed`, `runStats`/`runConfig` host
> functions, and the default v1 role bundle. Blocked by Checkpoint D. Completes spec
> §15 steps 3–5 (v1 shippable).

## Tasks

- [x] **Task 17: Usage capture on terminals + cost caps (§11.4, §11.7)** — commit `57d1b03`
- [x] **Task 18: Model fallback on `session_failed` (§8.2, §9.4)** — commit `4a2e084`
  - Description: The host's session `subscribe` callback captures `usage` from
    `message_end` events. Usage lives on `event.message.usage` (`AssistantMessage`),
    so the callback **must guard `event.message.role === "assistant"`** (message_end
    also fires for user/toolResult messages). Map SDK `Usage` → §11.4 record:
    `input←input`, `output←output`, `cache_read←cacheRead`, `cache_write←cacheWrite`,
    `tokens←totalTokens`, `cost←cost.total` (SDK `cost` is a nested object, not a
    number). The per-session terminal `usage` (§11.4) is the **running sum across** the
    session's assistant `message_end` events — not a single capture — recorded on both
    `session_ended` and `session_failed` terminals as a `session_*` lifecycle record
    (§11.4). Per-session cap: on
    `turn_end`, evaluate the invocation's cumulative `usage.cost` against
    `max_session_cost_usd` (shared across model fallbacks — Phase 3 Task 11 predicate);
    exceed → `session.abort()` + `session_failed` w/ `session_cost_cap_exceeded`.
    **Abort accounting:** an `abort()` may itself emit a final
    `message_end`/`turn_end` with partial usage; the host de-duplicates so the
    aborted turn is counted once, not twice. Run cap: evaluate persisted roll-up
    (Phase 3 Task 11) **plus the current terminal's captured usage before reducing the
    role's captured machine event**. Exceed → the host **synthesizes a machine `end`
    event and feeds it to `reduce`** (§11.7), producing a normal
    `transition_accepted → done` record + checkpoint snapshot. If the cap trips while
    the orchestrator is current, the synthesized `end` supersedes any captured
    non-`end` emission from that turn (for example, `handoff → worker` is not reduced,
    and no worker is spawned). **State guard (do not skip):** `end` is illegal from a
    worker, and per §12.1 `current_role` is already the next worker before that worker's
    terminals fire — so a breach detected on a **worker** terminal must NOT synthesize
    `end` then (`reduce` would reject it and the hard stop would silently fail).
    Instead the host marks the cap tripped, suppresses any new worker dispatch, lets
    the worker's handoff return control to the orchestrator, and synthesizes the `end`
    on the first `current_role === orchestrator` moment (always reached — a worker's
    only legal target is the orchestrator). The host **must not** mutate the checkpoint
    to `done` directly; the synthesized event is the single legal close. (Steering the
    orchestrator first is an optional courtesy, not the authoritative mechanism.)
  - Acceptance: A fabricated high-cost session (via the stub provider) trips the
    session cap and records `session_cost_cap_exceeded`; a run crossing
    `max_run_cost_usd` forces `end`. A breach detected on an orchestrator terminal
    supersedes a captured handoff and spawns no worker. **A run-cap breach detected on a
    worker terminal defers the forced `end` until the orchestrator is current and never
    feeds `end` to `reduce` while a worker is `current_role`** (asserted: no rejected
    `end` record). The usage mapping is asserted against canned stub `Usage`
    (camelCase + nested `cost.total`); a `message_end` for a non-assistant message
    contributes zero usage. Automated.
  - Verification: `pnpm test -- host/cost` (automated with a tiny cap).
  - Dependencies: Task 16.5
  - Files: `src/host/cost.ts`, `tests/host/cost.test.ts`
  - Scope: M

- [ ] **Task 18: Model fallback on `session_failed` (§8.2, §9.4)**
  - Description: On `session_failed` w/ `model_error`, try the role's next `models[]`
    entry, same role, fresh `createAgentSession` (state unchanged — §8.2). Record
    `model_fallback` (§11.5). On list exhaustion: hand to orchestrator once with a
    "role unavailable" payload; if orchestrator re-dispatches the same unavailable
    role, escalate (host aborts the run with a typed error / surfaces to the caller).
  - Acceptance: A failing primary model (stub configured to fail) falls through to the
    fallback and completes; exhausting the list hands back to the orchestrator exactly
    once. Automated.
  - Verification: `pnpm test -- host/fallback` (automated).
  - Dependencies: Task 17
  - Files: `src/host/fallback.ts`, `tests/host/fallback.test.ts`
  - Scope: M

- [ ] **Task 19: `runStats` / `runConfig` host functions (§11.6, §11.8)**
  - Description: `runStats(records): RunStats` renders current state, transition
    history, and the §11.6 roll-up (per-run/per-role/per-model/orchestrator-overhead)
    from persisted records. `runConfig(state, override)` overrides `max_run_cost_usd`
    for the current run (the manifest value remains the default). Both are plain host
    functions (not slash commands) callable by whatever front-end wraps the host; the
    host also emits a `stats` event on each terminal for a consumer to render (the
    TUI live widget is out of scope under the SDK host). Cache caveat (§11.6): show
    raw per-session `cache_read`/`cache_write`, never a synthesized per-run hit rate.
    **`runConfig` lowering edge case (must be defined, not silent):** if an override
    sets `max_run_cost_usd` to a value **at or below** the current `run_cost_to_date`,
    the host treats it as an immediate run-cap breach and synthesizes the `end` on the
    next `current_role === orchestrator` moment (same path as §11.7) — it does **not**
    retroactively reject already-spent cost, and it does **not** raise. Raising the cap
    is always allowed. An override to a non-positive number is a typed error.
  - Acceptance: `runStats` output reconciles with the sum of terminal `usage.cost`;
    `runConfig` changes the active cap mid-run; a `runConfig` override below current
    spend forces the synthesized `end` on the next orchestrator-current moment (no
    retroactive rejection, no throw); a non-positive override throws. Automated.
  - Verification: `pnpm test -- host/stats` (automated).
  - Dependencies: Task 17
  - Files: `src/host/stats.ts`, `src/host/config.ts`, `tests/host/stats.test.ts`
  - Scope: M

- [ ] **Task 20: Default v1 role bundle + shipped E2E fixtures (§6, §15.4, §15.5)**
  - Description: Provide the default orchestrator role template and one minimal worker
    role template, plus a sample `.pi/conductor.yaml` fixture that declares them
    explicitly. The default is a scaffold/template, not implicit reducer state: a real
    run still has exactly one declared `is_orchestrator: true` role and missing
    orchestrator remains a manifest error. Use this bundle in the stub-provider linear
    run and remediation-loop tests so the checkpoint gate proves the shipped default
    path, not only hand-built test objects.
  - Acceptance: A generated/sample manifest validates with the Phase 1 manifest
    checks; the linear `orchestrator → worker → orchestrator → end` run passes using
    the default bundle; the remediation loop revisits the worker until `max_visits`
    forces the orchestrator to end.
  - Verification: `pnpm test -- host/defaults host/e2e` (automated).
  - Dependencies: Task 18, Task 19
  - Files: `src/host/defaults.ts`, `tests/fixtures/default-conductor/.pi/conductor.yaml`,
    `tests/fixtures/default-conductor/.pi/roles/orchestrator.md`,
    `tests/fixtures/default-conductor/.pi/roles/worker.md`,
    `tests/host/defaults.test.ts`
  - Scope: M

## Checkpoint E — spec §15 steps 3–5 complete
- [ ] Host: seam-validate → `reduce` → persist → spawn → seed → cap-enforce →
      observe, all via SDK primitives (§15.3), unit-tested in CI
- [ ] Default orchestrator + one worker role defined end-to-end (§15.4)
- [ ] Linear E2E run works: `orchestrator → worker → orchestrator → end` (§15.5), via
      the stub provider in CI
- [ ] Remediation loop exercises the visit cap forcing `end` (§15.5), via the stub
- [ ] Review with human; v1 shippable
