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
>
> **Status:** In progress. Tasks 13 and 14 complete. Tasks 13.5, 15, 15.5, 16, 16.5
> pending. Checkpoint D (the exit gate for this phase) blocked until all seven
> tasks are green **and reviewed by a human**.
>
> **Verification log:**
> - Task 13 (commit `7ed38b4`): `pnpm typecheck && pnpm build && pnpm test
>   && pnpm lint && pnpm format:check` all green (227 tests, 17 files; 10 new
>   scaffold tests + 1 broadened grep-guard test for the host-agnosticism
>   invariant).
> - Task 14 (commit `204785b`): `pnpm typecheck && pnpm build && pnpm test
>   && pnpm lint && pnpm format:check` all green (243 tests, 18 files;
>   16 new tools tests covering the §11.3 breach vocabulary end-to-end).

## Tasks

- [x] **Task 13: Host scaffold + manifest load + `Host` interface (§8, §12)**
  - Description: `src/host/` package importing `@earendil-works/pi-coding-agent`. Load
    `.pi/conductor.yaml`, `parseManifest` (Phase 1 Task 3) + `validateManifest`
    (Phase 1 Task 4), derive `MachineDefinition` (Phase 1 Task 4), pin
    `manifest_version` onto the checkpoint (§10). Define a `Host` interface
    (`spawnRole`, `captureUsage`, `persistRecord`, `seedRunMemory`, `abortSession`,
    `sealSession`) that the orchestration loop programs against, so the loop is testable
    against a fake `Host` before the real SDK impl lands. Fail fast with a thrown typed
    error on hard manifest errors. **Persistence is the host's own `run_id`-keyed
    append-only log** (`RecordLog`); checkpoint reconstruction reads the latest snapshot
    for the `run_id` and does **not** use `SessionManager.getBranch()` scoping (resolved
    — spec §11.1, `sdk-surface.md` §6), so spawned-session branch semantics need not be
    confirmed. The `sealSession` hook supports the post-emission tool guard (Task 15.5).
  - Acceptance: A valid manifest loads and yields a `MachineDefinition`; an uncapped
    worker throws an error naming the rule. The `Host` interface compiles and a
    trivial fake-`Host` loop test passes.
  - Verification: `pnpm test -- host/scaffold` (automated, in-memory).
  - Dependencies: Checkpoint C
  - Files: `src/host/index.ts`, `src/host/host.ts`, `src/host/manifest.ts`,
    `tests/host/scaffold.test.ts`
  - Scope: M
  - Status: Complete (commit `7ed38b4`). `@earendil-works/pi-coding-agent@0.79.1` +
    `@earendil-works/pi-ai@0.79.1` added as direct deps; `minimumReleaseAge`
    excluded 0.79.7. Grep-guard broadened to all four pi packages per plan
    invariant 1 ("any pi runtime"). `Host` ships as an interface only — the
    SDK-backed impl lands in Task 15; tests implement the same interface as a
    fake.

- [ ] **Task 13.5: Host public API + file-backed append-only log + `resumeRun` (§11.1, §11.9)**
  - Description: Deliver the run-lifecycle entry points the spec promises and that no
    other task covers. (a) A **file-backed `RecordLog`** (the in-memory impl from
    Phase 3 Task 12 stays for core unit tests) that appends immutable JSON-lines
    records + checkpoint snapshots to a `run_id`-keyed file and reads the latest
    snapshot by scanning the log tail. (b) `startRun(manifestPath, opts?)`,
    `resumeRun(run_id)`, `listRuns()`, and a `RunHandle` exposing `runStats()`,
    `runConfig(override)`, `abort()`, and `await completion()` (spec §11.9). `startRun`
    calls `createInitialCheckpoint` (minting `run_id`), opens the log, persists the
    initial snapshot, and enters the loop. `resumeRun` reconstructs the checkpoint
    from the latest snapshot, re-derives the pinned `MachineDefinition` from the
    snapshot's `manifest_version`, reconciles a crash-mid-session (snapshot's
    `active_role_session` with no terminal lifecycle record → record a
    `session_failed` (`failure_reason: "crashed"`) for it before re-entering), and
    re-enters the loop at `current_role`. The reducer is unchanged; this is purely host
    state + I/O.
  - Acceptance: A run started via `startRun` writes a `run_id`-keyed log whose latest
    snapshot reconstructs to the in-memory checkpoint bit-for-bit. A run killed
    (process-simulated by dropping the in-memory `RunHandle` and re-deriving from the
    file log) mid-worker-session resumes via `resumeRun(run_id)`, records a `crashed`
    `session_failed` for the interrupted session, and reaches the **same terminal
    state** (`done` via the same transition path) as a non-killed equivalent run.
    `listRuns()` enumerates the log. Automated; no `pi` CLI.
  - Verification: `pnpm test -- host/resume` (automated, temp-dir file log).
  - Dependencies: Task 13, Task 16 (stub provider, to drive a resumable run)
  - Files: `src/host/log-file.ts`, `src/host/run-handle.ts`, `src/host/api.ts`,
    `tests/host/resume.test.ts`
  - Scope: M

- [x] **Task 14: `handoff` + `end` emission tools + seam validation (§3, §5.1, §12)**
  - Description: Define `handoff` and `end` as `defineTool()` tools with TypeBox params
    (`target_role`, `reason?`, `suggests_next?`) — reusing the Phase 3 Task 9 seam
    schemas as the parameter schemas (single source of truth). On call, a tool does
    **three** things and nothing else: (1) `validateEmission` (Phase 3 Task 9) at the
    seam; (2) write the validated machine-event intent into a per-session capture
    buffer — **only if the buffer is empty** (a second machine-event call writes an
    `extra_emission` marker and returns an error tool result without overwriting);
    (3) return a **terminating** tool result that instructs the role to stop calling
    tools and end its turn. On a valid emission, the tool **also sets the
    emission-sealed flag** on the live `RunHandle` for that session (Task 15.5) so no
    further side-effecting tool executes. On a seam validation failure, record a
    `schema_invalid` marker in the capture buffer (only if the buffer is empty) and
    return a terminating error result; this is a contract breach for Task 15 to persist
    as `session_failed`, not a retryable reducer rejection with `legal_targets`.
    **The tool does not call `reduce`, does not persist, and does not spawn.** `reduce`
    + persistence + spawning are the loop's exclusive responsibilities (Task 15), so
    there is exactly one reduce path and one persist path per role session. Termination
    is *enforced by the loop*, not trusted to the model: a tool call is a
    machine-event *intent*, not an automatic session end (see Task 15).
  - Acceptance: A role calling `handoff` with a schema-valid target writes exactly one
    capture entry, sets the emission-sealed flag, and returns a terminating result; a
    second machine-event call in the same session returns an `extra_emission` error and
    does not overwrite the capture; a schema-invalid call writes a `schema_invalid`
    marker, returns a terminating error result, and is later persisted by the loop as
    `session_failed` rather than `transition_rejected`. No
    `transition_accepted`/`transition_rejected` record is produced inside the tool
    (the loop produces them in Task 15). Tested against a fake `Host`.
  - Verification: `pnpm test -- host/tools` (automated).
  - Dependencies: Task 13
  - Files: `src/host/tools.ts`, `src/host/seam.ts`, `tests/host/tools.test.ts`
  - Scope: M
  - Status: Complete (commit `204785b`). Implementation notes from the work:
      - `SessionSeam` is the per-session host state — capture buffer +
        sealed flag. The post-emission wrapper (Task 15.5) reads
        `isSealed`; the loop reads `read()` after `prompt()` resolves.
      - Buffer state machine maps directly to `validateEmission`'s
        precedence (extra_emission > schema_invalid > no_emission); the
        tool doesn't have to second-guess.
      - `seam.seal()` flips ONLY on the first *valid* capture.
        Schema-invalid first calls do not seal (the loop will record
        `session_failed` regardless).
      - `handoff`/`end` themselves stay callable while sealed (they
        don't execute side effects; they only write the buffer). The
        post-emission wrapper (Task 15.5) wraps BUILT-IN and CUSTOM
        *side-effecting* tools, not these.
      - Pinned during implementation: `ToolDefinition.execute` is
        5-arg (toolCallId, params, signal, onUpdate, ctx); the SDK's
        `AgentToolResult` has no direct `isError` field — the tool
        returns `terminate: true` plus a structured `details` payload
        (`EmissionToolDetails`). Errors are signaled via the buffer
        state (read by the loop) and via the text content (read by the
        model), per the plan's "single owner" rule.
      - Schemas are `additionalProperties: true` per spec §5.1 ("plus
        role-defined fields"); extra fields on handoff/end are
        silently accepted and preserved on the captured args.

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

- [ ] **Task 15.5: Post-emission tool sealing (spec §12.1)**
  - Description: Implement the emission-sealed flag referenced by Task 14. The host
    wraps every tool the role can call (built-ins like `bash`/`edit`/`write`/`read`
    plus the role's declared custom tools) so that, while the live session's
    emission-sealed flag is set, the wrapper short-circuits execution and returns an
    error tool result ("session sealed; emission recorded") **without** invoking the
    underlying tool — so no side effect occurs after the role has declared its exit
    intent. The flag is set by the `handoff`/`end` tool on first valid capture (Task
    14) and is per-session host state on the `RunHandle`; it is never reducer state.
    `handoff`/`end` themselves remain callable for the `extra_emission` path (they
    don't execute side effects; they only write the marker). The wrapper is applied at
    `customTools` construction time in Task 15 so the agent never sees an unwrapped
    side-effecting tool.
  - Acceptance: A stub model that calls `handoff` (valid) and then `bash` produces
    **zero** `bash` side effects (asserted via a temp-file probe the `bash` call would
    have written), exactly one valid capture, and a normal `transition_accepted`. A
    stub model that calls `bash` then `handoff` runs `bash` normally (flag not yet set)
    and then seals. Both automated.
  - Verification: `pnpm test -- host/seal` (automated).
  - Dependencies: Task 15
  - Files: `src/host/tool-wrapper.ts`, `tests/host/seal.test.ts`
  - Scope: M

- [ ] **Task 16: Stub provider for in-CI end-to-end runs (§15.3)**
  - Description: A deterministic stub model/provider (or a scripted mock `Model` +
    `Provider`) the loop drives end-to-end without API keys, so every host test is a
    real assertion, not a manual run. **Pin the contract first:** before writing any
    E2E test, inspect `@earendil-works/pi-ai` `dist/types.d.ts` and confirm the exact
    `Provider` interface + `AssistantMessageEventStream` shape the stub must implement
    to satisfy `createAgentSession({ model: stubModel })` — a `Model` is data
    (`id`/`name`/`api`/`provider`/`baseUrl`/`cost`/…); streaming behavior lives on
    `Provider.stream` (`StreamFunction`). Record the pinned shape as a comment in
    `stub-provider.ts` so a future SDK upgrade surfaces drift. The stub emits a
    configurable `handoff`/`end` per role, returns canned `usage` on `message_end` in
    the SDK shape (camelCase + nested `cost.total`, `totalTokens`, assistant-only),
    and can be scripted to call `handoff` then `bash` (for Task 15.5) or to fail
    (for Task 18). If the `Provider`/`StreamFunction` surface cannot be faked cleanly,
    raise it as a blocker **before** any E2E test is written — this is the load-bearing
    assumption for all of Phases 4–5.
  - Acceptance: (1) A minimal stub `Model`+`Provider` drives one `createAgentSession`
    turn with canned `usage` and asserts the §11.4 mapping against the captured event
    — **gated before any E2E test**. (2) A full `orchestrator → worker →
    orchestrator → end` run completes in CI via the stub with no network and no API
    key, asserting the persisted record shapes (§11.2–§11.5) and final checkpoint.
  - Verification: `pnpm test -- host/e2e` (automated).
  - Dependencies: Task 15.5
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
- [ ] **Post-emission tool guarding:** a stub model that calls `handoff` then `bash`
      produces zero `bash` side effects and exactly one capture (automated)
- [ ] **Resume:** a run killed mid-session resumes to the same terminal state via
      `resumeRun(run_id)` from the file-backed log (automated)
- [ ] Full linear run passes in CI via the stub provider, no API key
- [ ] Review with human before cost/observability surfaces
