# Phase 4 — SDK host driver (host = pi SDK, §9.5 resolved)

> Sub-plan of `docs/orchestrator-fsm-plan.md`. Read the main plan first for Overview,
> Architecture Decisions, Risks, Open Questions, and whole-plan Verification. Source
> spec: `docs/orchestrator-fsm-spec.md` (§3, §5.1, §8, §8.4, §11.1, §11.8, §12). SDK
> surface pinned in `docs/sdk-surface.md`.
>
> **Scope:** The in-repo `src/host/` package that imports
> `@earendil-works/pi-coding-agent` and owns the orchestration loop: spawn role
> sessions via `createAgentSession`, seam-validate, call `reduce`, persist records +
> checkpoint snapshots, seed the next role, drive the stub provider end-to-end in CI.
> Blocked by Checkpoint C and must honor the **Resolved Pre-Phase-4 Hardening
> Decisions** in the main plan.

## Tasks

- [ ] **Task 13: Host scaffold + manifest load + `Host` interface (§8, §12)**
  - Description: `src/host/` package importing `@earendil-works/pi-coding-agent`. Load
    `.pi/conductor.yaml`, `parseManifest` (Phase 1 Task 3) + `validateManifest`
    (Phase 1 Task 4), derive `MachineDefinition` (Phase 1 Task 4), pin
    `manifest_version` onto the checkpoint (§10). Define a `Host` interface
    (`spawnRole`, `captureUsage`, `persistRecord`, `seedRunMemory`, `abortSession`)
    that the orchestration loop programs against, so the loop is testable against a
    fake `Host` before the real SDK impl lands. Fail fast with a thrown typed error on
    hard manifest errors. **Persistence is the host's own `run_id`-keyed append-only
    log** (`RecordLog`); checkpoint reconstruction reads the latest snapshot for the
    `run_id` and does **not** use `SessionManager.getBranch()` scoping (resolved — spec
    §11.1, `sdk-surface.md` §6), so spawned-session branch semantics need not be
    confirmed.
  - Acceptance: A valid manifest loads and yields a `MachineDefinition`; an uncapped
    worker throws an error naming the rule. The `Host` interface compiles and a
    trivial fake-`Host` loop test passes.
  - Verification: `pnpm test -- host/scaffold` (automated, in-memory).
  - Dependencies: Checkpoint C
  - Files: `src/host/index.ts`, `src/host/host.ts`, `src/host/manifest.ts`,
    `tests/host/scaffold.test.ts`
  - Scope: M

- [ ] **Task 14: `handoff` + `end` emission tools + seam validation (§3, §5.1, §12)**
  - Description: Define `handoff` and `end` as `defineTool()` tools with TypeBox params
    (`target_role`, `reason?`, `suggests_next?`) — reusing the Phase 3 Task 9 seam
    schemas as the parameter schemas (single source of truth). On call, a tool does
    **three** things and nothing else: (1) `validateEmission` (Phase 3 Task 9) at the
    seam; (2) write the validated machine-event intent into a per-session capture
    buffer — **only if the buffer is empty** (a second machine-event call writes an
    `extra_emission` marker and returns an error tool result without overwriting);
    (3) return a **terminating** tool result that instructs the role to stop calling
    tools and end its turn. On a valid emission, the result is "Emission recorded; do
    not call further tools." On a seam validation failure, record a `schema_invalid`
    marker in the capture buffer (only if the buffer is empty) and return a terminating
    error result; this is a contract breach for Task 15 to persist as `session_failed`,
    not a retryable reducer rejection with `legal_targets`. **The tool does not call
    `reduce`, does not persist, and does not spawn.** `reduce` + persistence + spawning
    are the loop's exclusive responsibilities (Task 15), so there is exactly one
    reduce path and one persist path per role session. Termination is *enforced by the
    loop*, not trusted to the model: a tool call is a machine-event *intent*, not an
    automatic session end (see Task 15).
  - Acceptance: A role calling `handoff` with a schema-valid target writes exactly one
    capture entry and returns a terminating result; a second machine-event call in the
    same session returns an `extra_emission` error and does not overwrite the capture;
    a schema-invalid call writes a `schema_invalid` marker, returns a terminating error
    result, and is later persisted by the loop as `session_failed` rather than
    `transition_rejected`. No `transition_accepted`/`transition_rejected` record is
    produced inside the tool (the loop produces them in Task 15). Tested against a fake
    `Host`.
  - Verification: `pnpm test -- host/tools` (automated).
  - Dependencies: Task 13
  - Files: `src/host/tools.ts`, `src/host/seam.ts`, `tests/host/tools.test.ts`
  - Scope: M

- [ ] **Task 15: Orchestration loop via `createAgentSession` (§8, §12)**
  - Description: The synchronous host loop: while `state !== "done"`, create the
    current role's session via `createAgentSession`. Per role, the host builds a
    `DefaultResourceLoader({ systemPromptOverride: () => rolePrompt })` and passes it
    as `resourceLoader` (`systemPromptOverride` is a `ResourceLoader` option, not a
    `createAgentSession` option); `model`, `tools` (an allowlist that **must include
    `handoff`/`end`** to enable the custom tools), `customTools: [handoff, end]`, and
    `sessionManager` are direct `createAgentSession` options. After the session is
    created, call `reduceLifecycle(session_started)` with its `sessionId`/`sessionFile`
    before prompting it. Subscribe to the event stream (capture `usage` on
    `message_end` — Task 17; eval caps on `turn_end` — Task 17), then
    `session.prompt(seedFromHandoff(payload))` and await completion. After `prompt()`
    resolves, the loop — the **sole owner** of `reduce` and persistence —
    reads the per-session capture buffer (Task 14) and enforces the contract:
    **exactly one** machine-event capture is required. Zero captures →
    `session_failed` (`failure_reason: no_emission`); an `extra_emission` marker in
    the buffer → `session_failed` (`extra_emission`); a schema-invalid single capture
    → `session_failed` (`schema_invalid`). **A breach persists exactly one
    `session_failed` record and never a `transition_rejected`** (§11.3) — the session
    is dead and `reduce` is not called. Only on exactly one *valid* capture does the
    loop `validateEmission` then `reduce` (Phase 2 Task 7), persist the resulting
    `transition_accepted`/`transition_rejected` record + a checkpoint snapshot, and on
    an accepted handoff spawn the next role with the payload (including `suggests_next`
    as orchestrator context) as the seed. The canonical reducer call order (§12.1) is
    followed: `reduce` first, then `session_ended` (prev role), then `session_started`
    (next). A tool call does **not** automatically end the session; the loop treats the
    capture as intent and drives termination itself (it does not trust the model to
    stop — it reads the capture after `prompt()` resolves). `active_role_session`
    tracks the live session. No `ctx` replacement footgun: each role is a fresh
    `createAgentSession`; nothing is captured across it.
  - Acceptance: `orchestrator → worker → orchestrator` handoffs each spawn a fresh
    session seeded with the prior payload; `parent_session` links form the session
    tree (§11.4); the loop terminates on `end`; a role session that emits zero
    machine events is recorded as `session_failed` (`no_emission`), one that emits
    two as `session_failed` (`extra_emission`), and one with a schema-invalid single
    capture as `session_failed` (`schema_invalid`) — **none** of these produce a
    `transition_rejected`, and `reduce` is not called for any of them. Only a valid
    single capture reaches `reduce`. The canonical reducer call order (§12.1) is
    followed on an accepted transition: `reduce` first, then
    `reduceLifecycle(session_ended)` for the previous active session id, then create
    the next session and `reduceLifecycle(session_started)`. On a reducer `rejected`
    result, persist the `transition_rejected` record, surface `legal_targets` back into
    the same active session, and do **not** call terminal lifecycle; this is retryable
    in-session and is distinct from a contract breach. `reduce` and persistence each
    run exactly once per role session, in the loop. Tested against a fake session
    factory; Task 16 promotes that into a reusable stub provider for E2E tests.
  - Verification: `pnpm test -- host/loop` (automated, no `pi` CLI, no API keys).
  - Dependencies: Task 14
  - Files: `src/host/loop.ts`, `tests/host/loop.test.ts`
  - Scope: M

- [ ] **Task 16: Stub provider for in-CI end-to-end runs (§15.3)**
  - Description: A deterministic stub model/provider (or a scripted mock `Model`) the
    loop drives end-to-end without API keys, so every host test is a real assertion,
    not a manual run. The stub emits a configurable `handoff`/`end` per role and
    returns canned `usage` on `message_end`. This is what makes "unit tests, not
    pinky-promises" real for the driver.
  - Acceptance: A full `orchestrator → worker → orchestrator → end` run completes in
    CI via the stub with no network and no API key, asserting the persisted record
    shapes (§11.2–§11.5) and final checkpoint.
  - Verification: `pnpm test -- host/e2e` (automated).
  - Dependencies: Task 15
  - Files: `src/host/stub-provider.ts`, `tests/host/e2e.test.ts`
  - Scope: M

- [ ] **Task 16.5: Orchestrator run-memory seeding per turn (§8.4, §11.8)**
  - Description: Before each orchestrator session's `prompt`, the host rebuilds the
    run-memory artifact via `buildRunMemory` (Phase 3 Task 12) from the persisted
    records + checkpoint and injects it into the seed (system prompt / first user
    message) so each orchestrator turn sees `run_cost_to_date`, `remaining_budget`,
    `per_role_cost`, `next_candidates`. Single-writer rule: only orchestrator sessions
    receive the artifact.
  - Acceptance: An orchestrator session's first turn references current run cost and
    uncapped candidates; a second orchestrator turn after a worker visit reflects the
    new `visit_history` entry. Tested via the stub provider.
  - Verification: `pnpm test -- host/run-memory` (automated).
  - Dependencies: Task 16
  - Files: `src/host/run-memory.ts`, `tests/host/run-memory.test.ts`
  - Scope: M

## Checkpoint D — SDK host driver wired
- [ ] Legal handoff spawns + seeds the next role session end-to-end (automated test)
- [ ] Illegal handoff is rejected with `legal_targets` surfaced to the role (automated)
- [ ] Orchestrator sees run-memory context each turn (automated)
- [ ] Full linear run passes in CI via the stub provider, no API key
- [ ] Review with human before cost/observability surfaces
