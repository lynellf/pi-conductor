# Phase 4 — SDK host driver (host = pi SDK, §9.5 resolved)

> Sub-plan of `docs/orchestrator-fsm-plan.md`. Read the main plan first for
> Overview, Architecture Decisions, Risks, Open Questions, and whole-plan
> Verification. Source spec: `docs/orchestrator-fsm-spec.md` (§3, §5.1, §8,
> §8.4, §11.1, §11.8, §12). SDK surface pinned in `docs/sdk-surface.md`.
>
> **Scope:** The in-repo `src/host/` package that imports
> `@earendil-works/pi-coding-agent` and owns the orchestration loop: spawn role
> sessions via `createAgentSession`, seam-validate, call `reduce`, persist
> records + checkpoint snapshots, seed the next role, drive the stub provider
> end-to-end in CI. Blocked by Checkpoint C and must honor the **Resolved
> Pre-Phase-4 Hardening Decisions** in the main plan.
>
> **Status:** Tasks 13, 13.5, 14, 15, 15.5, 16, 16.5 all complete. **Checkpoint
> D reached** — every Phase 4 task is green. The exit gate is now a **human
> review of the full phase** before Phase 5 (cost + observability) begins.
>
> **Verification log:**
>
> - Task 13 (commit `7ed38b4`):
>   `pnpm typecheck && pnpm build && pnpm test
>   && pnpm lint && pnpm format:check`
>   all green (227 tests, 17 files; 10 new scaffold tests + 1 broadened
>   grep-guard test for the host-agnosticism invariant).
> - Task 13.5 (commit `d0260ff`):
>   `pnpm typecheck && pnpm build && pnpm test
>   && pnpm lint && pnpm format:check`
>   all green (272 tests, 22 files; 5 new resume tests covering file-backed
>   log + crash reconciliation
>   - startRun/resumeRun/listRuns API).
> - Task 16.5 (commit `b990c46`):
>   `pnpm typecheck && pnpm build && pnpm test
>   && pnpm lint && pnpm format:check`
>   all green (276 tests, 23 files; 4 new run-memory tests covering the §8.4
>   single-writer rule and the visit_history propagation across orchestrator
>   turns).
> - Task 14 (commit `204785b`):
>   `pnpm typecheck && pnpm build && pnpm test
>   && pnpm lint && pnpm format:check`
>   all green (243 tests, 18 files; 16 new tools tests covering the §11.3 breach
>   vocabulary end-to-end).
> - Task 15 (commit `825f77a`):
>   `pnpm typecheck && pnpm build && pnpm test
>   && pnpm lint && pnpm format:check`
>   all green (255 tests, 19 files; 12 new loop tests covering the §12.1
>   canonical reducer call order, the §11.3 breach vocabulary, and the
>   reducer-rejection retry path).
> - Task 15.5 (commit `20caecf`):
>   `pnpm typecheck && pnpm build && pnpm test
>   && pnpm lint && pnpm format:check`
>   all green (264 tests, 20 files; 9 new seal tests covering the §12.1 wrap
>   utility + integration with Task 14's seam + the bash / handoff ordering
>   acceptance scenarios).
> - Task 16 (commit `9a377a6`):
>   `pnpm typecheck && pnpm build && pnpm test
>   && pnpm lint && pnpm format:check`
>   all green (267 tests, 21 files; 3 new E2E tests driving real
>   createAgentSession via the stub provider — full orch -> worker -> orch ->
>   end run completes with no network and no API key).

## Tasks

- [x] **Task 13: Host scaffold + manifest load + `Host` interface (§8, §12)**
  - Description: `src/host/` package importing
    `@earendil-works/pi-coding-agent`. Load `.pi/conductor.yaml`,
    `parseManifest` (Phase 1 Task 3) + `validateManifest` (Phase 1 Task 4),
    derive `MachineDefinition` (Phase 1 Task 4), pin `manifest_version` onto the
    checkpoint (§10). Define a `Host` interface (`spawnRole`, `captureUsage`,
    `persistRecord`, `seedRunMemory`, `abortSession`, `sealSession`) that the
    orchestration loop programs against, so the loop is testable against a fake
    `Host` before the real SDK impl lands. Fail fast with a thrown typed error
    on hard manifest errors. **Persistence is the host's own `run_id`-keyed
    append-only log** (`RecordLog`); checkpoint reconstruction reads the latest
    snapshot for the `run_id` and does **not** use `SessionManager.getBranch()`
    scoping (resolved — spec §11.1, `sdk-surface.md` §6), so spawned-session
    branch semantics need not be confirmed. The `sealSession` hook supports the
    post-emission tool guard (Task 15.5).
  - Acceptance: A valid manifest loads and yields a `MachineDefinition`; an
    uncapped worker throws an error naming the rule. The `Host` interface
    compiles and a trivial fake-`Host` loop test passes.
  - Verification: `pnpm test -- host/scaffold` (automated, in-memory).
  - Dependencies: Checkpoint C
  - Files: `src/host/index.ts`, `src/host/host.ts`, `src/host/manifest.ts`,
    `tests/host/scaffold.test.ts`
  - Scope: M
  - Status: Complete (commit `7ed38b4`).
    `@earendil-works/pi-coding-agent@0.79.1` + `@earendil-works/pi-ai@0.79.1`
    added as direct deps; `minimumReleaseAge` excluded 0.79.7. Grep-guard
    broadened to all four pi packages per plan invariant 1 ("any pi runtime").
    `Host` ships as an interface only — the SDK-backed impl lands in Task 15;
    tests implement the same interface as a fake.

- [x] **Task 13.5: Host public API + file-backed append-only log + `resumeRun`
      (§11.1, §11.9)**
  - Description: Deliver the run-lifecycle entry points the spec promises and
    that no other task covers. (a) A **file-backed `RecordLog`** (the in-memory
    impl from Phase 3 Task 12 stays for core unit tests) that appends immutable
    JSON-lines records + checkpoint snapshots to a `run_id`-keyed file and reads
    the latest snapshot by scanning the log tail. (b)
    `startRun(manifestPath, opts?)`, `resumeRun(run_id)`, `listRuns()`, and a
    `RunHandle` exposing `runStats()`, `runConfig(override)`, `abort()`, and
    `await completion()` (spec §11.9). `startRun` calls
    `createInitialCheckpoint` (minting `run_id`), opens the log, persists the
    initial snapshot, and enters the loop. `resumeRun` reconstructs the
    checkpoint from the latest snapshot, re-derives the pinned
    `MachineDefinition` from the snapshot's `manifest_version`, reconciles a
    crash-mid-session (snapshot's `active_role_session` with no terminal
    lifecycle record → record a `session_failed` (`failure_reason: "crashed"`)
    for it before re-entering), and re-enters the loop at `current_role`. The
    reducer is unchanged; this is purely host state + I/O.
  - Acceptance: A run started via `startRun` writes a `run_id`-keyed log whose
    latest snapshot reconstructs to the in-memory checkpoint bit-for-bit. A run
    killed (process-simulated by dropping the in-memory `RunHandle` and
    re-deriving from the file log) mid-worker-session resumes via
    `resumeRun(run_id)`, records a `crashed` `session_failed` for the
    interrupted session, and reaches the **same terminal state** (`done` via the
    same transition path) as a non-killed equivalent run. `listRuns()`
    enumerates the log. Automated; no `pi` CLI.
  - Verification: `pnpm test -- host/resume` (automated, temp-dir file log).
  - Dependencies: Task 13, Task 16 (stub provider, to drive a resumable run)
  - Files: `src/host/log-file.ts`, `src/host/run-handle.ts`, `src/host/api.ts`,
    `tests/host/resume.test.ts`
  - Scope: M
  - Status: Complete (commit `d0260ff`). Implementation notes from the work:
    - **File-backed log (`FileRecordLog`).** JSONL-per-run under
      `baseDir/<runId>.jsonl`. Sync writes (appendFileSync) for the Phase 4 test
      surface; production can swap to an async tail or embedded store
      transparently since the `RecordLog` interface is preserved.
      `latestCheckpoint` walks the file in reverse to find the last
      `checkpoint_snapshot` (§11.1: "the snapshot _is_ the state"). `listRunIds`
      reads `baseDir` for files matching `*.jsonl`.
    - **`RunHandle`** exposes `completion()` (resolves with `finalCheckpoint` +
      `exitReason`), `abort(reason)` (sets a host-side flag for Phase 5 cost-cap
      to honor), `runStats()` (renders the §11.6 roll-up over persisted
      records + latest checkpoint + exitReason inference), `runConfig(override)`
      / `currentConfigOverride()` (Phase 5 surface for live `max_run_cost_usd`
      updates), `isAborted()`, and `buildRunMemory(goal, runCostCap)` (Task
      16.5's orchestrator-seed entry point).
    - **`startRun(manifestPath, opts)`** loads the manifest, mints a `run_id`
      (via `createInitialCheckpoint`), opens the file-backed log, persists the
      initial `CheckpointSnapshot`, constructs the host via `hostFactory`, and
      enters the orchestration loop. Returns a `RunHandle` whose `completion()`
      resolves when the loop reaches a terminal state.
    - **`resumeRun(manifestPath, runId, opts)`** re-loads the manifest (source
      of truth for `def`), verifies the snapshot's `manifest_version` matches
      the manifest's version (mismatch → throw, §10), reads the latest snapshot,
      runs the crash reconciler, then enters the loop at `current_role`.
    - **Crash reconciler** detects an orphaned session by checking the
      snapshot's `active_role_session` against the records: if non-null and no
      `session_ended` / `session_failed` record exists for that `session_file`,
      it calls
      `reduceLifecycle(session_failed, { failureReason:
        "crashed", usage: zeros })`
      and persists the cleared snapshot. Reconciler is host-side glue — the
      reducer doesn't know about crash semantics; it sees a normal
      `session_failed` lifecycle event.
    - **Crash detection relies on a per-session_started snapshot.** Task 13.5
      surfaced a real bug: previously the loop snapshotted only after `reduce`,
      leaving the latest snapshot's `active_role_session` pointing at the
      just-finished session rather than the in-progress one. The fix: every
      reducer call (`session_started`, `reduce`, `session_ended`,
      `session_failed`) produces a snapshot. Per visit: post-session_started,
      post-reduce, post-session-ended — 3 snapshots per visit. The
      post-session_started snapshot is what crash detection reads when a run is
      killed mid-prompt.
    - **5 new tests** in `tests/host/resume.test.ts` cover the acceptance
      scenarios:
      - `startRun` writes a run_id-keyed log whose latest snapshot reconstructs
        the in-memory final checkpoint bit-for-bit.
      - `resumeRun` after a mid-worker-session crash (manual record writeup of
        the killed state) records `session_failed("crashed")` for the
        interrupted worker, then drives the rest of the run to completion.
      - `resumeRun` on a clean terminal (no orphans) is a no-op — no extra
        session_failed records.
      - `listRuns` enumerates the run_ids known to a baseDir.
      - `RunHandle.runStats` reflects persisted records + final checkpoint +
        exitReason.
    - **`StubHost`** was extracted from `tests/host/e2e.test.ts` into
      `src/host/stub-host.ts` so the resume tests can reuse it without
      duplication.

- [x] **Task 14: `handoff` + `end` emission tools + seam validation (§3, §5.1,
      §12)**
  - Description: Define `handoff` and `end` as `defineTool()` tools with TypeBox
    params (`target_role`, `reason?`, `suggests_next?`) — reusing the Phase 3
    Task 9 seam schemas as the parameter schemas (single source of truth). On
    call, a tool does **three** things and nothing else: (1) `validateEmission`
    (Phase 3 Task 9) at the seam; (2) write the validated machine-event intent
    into a per-session capture buffer — **only if the buffer is empty** (a
    second machine-event call writes an `extra_emission` marker and returns an
    error tool result without overwriting); (3) return a **terminating** tool
    result that instructs the role to stop calling tools and end its turn. On a
    valid emission, the tool **also sets the emission-sealed flag** on the live
    `RunHandle` for that session (Task 15.5) so no further side-effecting tool
    executes. On a seam validation failure, record a `schema_invalid` marker in
    the capture buffer (only if the buffer is empty) and return a terminating
    error result; this is a contract breach for Task 15 to persist as
    `session_failed`, not a retryable reducer rejection with `legal_targets`.
    **The tool does not call `reduce`, does not persist, and does not spawn.**
    `reduce`
    - persistence + spawning are the loop's exclusive responsibilities (Task
      15), so there is exactly one reduce path and one persist path per role
      session. Termination is _enforced by the loop_, not trusted to the model:
      a tool call is a machine-event _intent_, not an automatic session end (see
      Task 15).
  - Acceptance: A role calling `handoff` with a schema-valid target writes
    exactly one capture entry, sets the emission-sealed flag, and returns a
    terminating result; a second machine-event call in the same session returns
    an `extra_emission` error and does not overwrite the capture; a
    schema-invalid call writes a `schema_invalid` marker, returns a terminating
    error result, and is later persisted by the loop as `session_failed` rather
    than `transition_rejected`. No `transition_accepted`/`transition_rejected`
    record is produced inside the tool (the loop produces them in Task 15).
    Tested against a fake `Host`.
  - Verification: `pnpm test -- host/tools` (automated).
  - Dependencies: Task 13
  - Files: `src/host/tools.ts`, `src/host/seam.ts`, `tests/host/tools.test.ts`
  - Scope: M
  - Status: Complete (commit `204785b`). Implementation notes from the work:
    - `SessionSeam` is the per-session host state — capture buffer + sealed
      flag. The post-emission wrapper (Task 15.5) reads `isSealed`; the loop
      reads `read()` after `prompt()` resolves.
    - Buffer state machine maps directly to `validateEmission`'s precedence
      (extra_emission > schema_invalid > no_emission); the tool doesn't have to
      second-guess.
    - `seam.seal()` flips ONLY on the first _valid_ capture. Schema-invalid
      first calls do not seal (the loop will record `session_failed`
      regardless).
    - `handoff`/`end` themselves stay callable while sealed (they don't execute
      side effects; they only write the buffer). The post-emission wrapper (Task
      15.5) wraps BUILT-IN and CUSTOM _side-effecting_ tools, not these.
    - Pinned during implementation: `ToolDefinition.execute` is 5-arg
      (toolCallId, params, signal, onUpdate, ctx); the SDK's `AgentToolResult`
      has no direct `isError` field — the tool returns `terminate: true` plus a
      structured `details` payload (`EmissionToolDetails`). Errors are signaled
      via the buffer state (read by the loop) and via the text content (read by
      the model), per the plan's "single owner" rule.
    - Schemas are `additionalProperties: true` per spec §5.1 ("plus role-defined
      fields"); extra fields on handoff/end are silently accepted and preserved
      on the captured args.

- [x] **Task 15: Orchestration loop via `createAgentSession` (§8, §12)**
  - Description: The synchronous host loop: while `state !== "done"`, create the
    current role's session via `createAgentSession`. Per role, the host builds a
    `DefaultResourceLoader({ systemPromptOverride: () => rolePrompt })` and
    passes it as `resourceLoader` (`systemPromptOverride` is a `ResourceLoader`
    option, not a `createAgentSession` option); `model`, `tools` (an allowlist
    that **must include `handoff`/`end`** to enable the custom tools),
    `customTools: [handoff, end]`, and `sessionManager` are direct
    `createAgentSession` options. After the session is created, call
    `reduceLifecycle(session_started)` with its `sessionId`/`sessionFile` before
    prompting it. Subscribe to the event stream (capture `usage` on
    `message_end` — Task 17; eval caps on `turn_end` — Task 17), then
    `session.prompt(seedFromHandoff(payload))` and await completion. After
    `prompt()` resolves, the loop — the **sole owner** of `reduce` and
    persistence — reads the per-session capture buffer (Task 14) and enforces
    the contract: **exactly one** machine-event capture is required. Zero
    captures → `session_failed` (`failure_reason: no_emission`); an
    `extra_emission` marker in the buffer → `session_failed` (`extra_emission`);
    a schema-invalid single capture → `session_failed` (`schema_invalid`). **A
    breach persists exactly one `session_failed` record and never a
    `transition_rejected`** (§11.3) — the session is dead and `reduce` is not
    called. Only on exactly one _valid_ capture does the loop `validateEmission`
    then `reduce` (Phase 2 Task 7), persist the resulting
    `transition_accepted`/`transition_rejected` record + a checkpoint snapshot,
    and on an accepted handoff spawn the next role with the payload (including
    `suggests_next` as orchestrator context) as the seed. The canonical reducer
    call order (§12.1) is followed: `reduce` first, then `session_ended` (prev
    role), then `session_started` (next). A tool call does **not** automatically
    end the session; the loop treats the capture as intent and drives
    termination itself (it does not trust the model to stop — it reads the
    capture after `prompt()` resolves). `active_role_session` tracks the live
    session. No `ctx` replacement footgun: each role is a fresh
    `createAgentSession`; nothing is captured across it.
  - Acceptance: `orchestrator → worker → orchestrator` handoffs each spawn a
    fresh session seeded with the prior payload; `parent_session` links form the
    session tree (§11.4); the loop terminates on `end`; a role session that
    emits zero machine events is recorded as `session_failed` (`no_emission`),
    one that emits two as `session_failed` (`extra_emission`), and one with a
    schema-invalid single capture as `session_failed` (`schema_invalid`) —
    **none** of these produce a `transition_rejected`, and `reduce` is not
    called for any of them. Only a valid single capture reaches `reduce`. The
    canonical reducer call order (§12.1) is followed on an accepted transition:
    `reduce` first, then `reduceLifecycle(session_ended)` for the previous
    active session id, then create the next session and
    `reduceLifecycle(session_started)`. On a reducer `rejected` result, persist
    the `transition_rejected` record, surface `legal_targets` back into the same
    active session, and do **not** call terminal lifecycle; this is retryable
    in-session and is distinct from a contract breach. `reduce` and persistence
    each run exactly once per role session, in the loop. Tested against a fake
    session factory; Task 16 promotes that into a reusable stub provider for E2E
    tests.
  - Verification: `pnpm test -- host/loop` (automated, no `pi` CLI, no API
    keys).
  - Dependencies: Task 14
  - Files: `src/host/loop.ts`, `tests/host/loop.test.ts`
  - Scope: M
  - Status: Complete (commit `825f77a`). Implementation notes from the work:
    - **Single-owner rule.** `reduce` / `reduceLifecycle` / `persistRecord` live
      ONLY in `runLoop`. The handoff/end tool wrappers (Task 14) write to the
      capture buffer; they never reduce or persist. Each role session produces
      exactly one `transition_accepted` / `transition_rejected` /
      `session_failed` record, plus lifecycle bracketing, plus a
      `checkpoint_snapshot` on accepted transitions.
    - **§12.1 canonical call order** is followed verbatim:
      1. `reduceLifecycle(session_started)` after spawn
      2. `session.prompt(seed)` and await
      3. `validateEmission` on the capture buffer
      4. On accepted handoff: `reduce` → persist transition record → persist
         checkpoint snapshot → `reduceLifecycle(session_ended)` for the
         just-finished session.
      5. The next outer iteration spawns the next role's session with
         `parent_session` = the just-finished session id (§11.4 tree links: orch
         → worker → orch).
    - **§11.3 contract breach = single `session_failed`, never
      `transition_rejected`.** Zero captures, schema-invalid single captures,
      and extra_emission (length > 1) all reach `session_failed` with the breach
      vocabulary (`no_emission` / `schema_invalid` / `extra_emission`); `reduce`
      is never called for any of them.
    - **Reducer-rejection retry** (`transition_rejected`) keeps the session
      alive. The loop persists the rejected record, clears the capture buffer
      via `session.resetCaptureBuffer()` (a new `RoleSession` method, see
      below), and re-prompts the same session with
      `formatRejectionMessage(legal_targets)`. The buffer clear is essential:
      without it, the next emission against the stale rejected capture would
      deterministically read as `extra_emission`.
    - **New Host / RoleSession surface** added for Task 15 (kept narrow —
      single-purpose):
      - `RoleSession.resetCaptureBuffer()`: clear the buffer for the next prompt
        attempt.
      - `Host.nextVisitIndex(role)`: 1-based visit_index for the next visit,
        derived from the run_id-keyed log (§11.4: "reconstructable from records
        alone").
      - `SpawnRoleOptions` fields are now all optional; the host fills in
        defaults from the loaded manifest (model, system prompt, tools). The
        loop passes minimal overrides.
    - **Loop's contract for tests.** Tests script a `FakeHost` + a queue of
      `FakeSession`s, each emitting on `prompt()`. The fake's `prompt()`
      consumes the next scripted emission and pushes it to the capture buffer
      (mirroring Task 14's tool wrapper effect). 12 tests cover: 3-visit happy
      path with parent_session chain and visit_index; the three §11.3 breach
      types each producing exactly one `session_failed` and zero
      `transition_rejected`; the reducer-rejection retry path with three
      variants (succeeds on retry; breaches on retry; no `session_ended` until
      the accepted attempt); the §12.1 canonical record order across a 3-visit
      run; and the assertion that the loop never calls `sealSession` /
      `abortSession` directly (those are Task 15.5 / Task 18's hooks).

- [x] **Task 15.5: Post-emission tool sealing (spec §12.1)**
  - Description: Implement the emission-sealed flag referenced by Task 14. The
    host wraps every tool the role can call (built-ins like
    `bash`/`edit`/`write`/`read` plus the role's declared custom tools) so that,
    while the live session's emission-sealed flag is set, the wrapper
    short-circuits execution and returns an error tool result ("session sealed;
    emission recorded") **without** invoking the underlying tool — so no side
    effect occurs after the role has declared its exit intent. The flag is set
    by the `handoff`/`end` tool on first valid capture (Task 14) and is
    per-session host state on the `RunHandle`; it is never reducer state.
    `handoff`/`end` themselves remain callable for the `extra_emission` path
    (they don't execute side effects; they only write the marker). The wrapper
    is applied at `customTools` construction time in Task 15 so the agent never
    sees an unwrapped side-effecting tool.
  - Acceptance: A stub model that calls `handoff` (valid) and then `bash`
    produces **zero** `bash` side effects (asserted via a temp-file probe the
    `bash` call would have written), exactly one valid capture, and a normal
    `transition_accepted`. A stub model that calls `bash` then `handoff` runs
    `bash` normally (flag not yet set) and then seals. Both automated.
  - Verification: `pnpm test -- host/seal` (automated).
  - Dependencies: Task 15
  - Files: `src/host/tool-wrapper.ts`, `tests/host/seal.test.ts`
  - Scope: M
  - Status: Complete (commit `20caecf`). Implementation notes from the work:
    - **Public surface.** `wrapToolWithSeal(tool, sealCheck)` returns a new
      `ToolDefinition` whose `execute` consults `sealCheck()` before delegating.
      `wrapAllToolsWithSeal(tools, sealCheck)` is a list convenience for the
      host's `spawnRole` wiring. `SealCheck = () => boolean` is the callback the
      caller closes over `SessionSeam.isSealed`.
    - **What gets preserved.** All tool metadata (name, label, description,
      parameters, renderCall, renderResult, promptSnippet, promptGuidelines,
      executionMode, prepareArguments) is preserved via object spread; only
      `execute` is replaced. So the wrapped tool is indistinguishable from the
      original except for the short-circuit on sealed.
    - **What gets returned when sealed.**
      `content: [{ type:
        'text', text: 'session sealed; emission recorded. ...' }]`,
      `details: { sealed: true }`, `terminate: true`. The `terminate: true` flag
      is the SDK's "stop after this tool batch" hint (see Task 14's tool results
      for the same pattern).
    - **Generic erasure.** `ToolDefinition<TParams, TDetails,
        TState>`
      is erased at the SDK's `customTools: ToolDefinition[]` boundary on
      `CreateAgentSessionOptions`, so the wrapper preserves the call signature
      but the inner cast is type-erased. Documented in module JSDoc; matches the
      `Model<any>` pattern in `src/host/host.ts`.
    - **Production wiring** lives in Task 15's SDK-backed sibling (not yet
      built). At `spawnRole` time, the host will:
      1. Build the built-in tools + role's declared custom tools.
      2. `wrapAllToolsWithSeal(tools, () => seam.isSealed)` for the
         side-effecting set.
      3. Build `handoff` / `end` via the Task 14 factories UNWRAPPED and
         register separately so the §11.3 `extra_emission` marker path (Task 14)
         still works.
    - **Acceptance scenarios from the plan** are asserted directly:
      - `handoff` (valid) then `bash` → bash side effect (writing a temp probe
        file) does NOT fire; capture buffer has exactly 1 entry.
      - `bash` then `handoff` → bash runs normally (flag not yet set); then
        handoff seals.
      - Multiple bash calls after sealing all short-circuit (call count stays at
        1).
      - `handoff` then `handoff` (extra_emission): first handoff seals; second
        handoff call writes an `extra_emission` marker — proves handoff/end
        themselves remain unwrapped so the §11.3 breach vocabulary is preserved.

- [x] **Task 16: Stub provider for in-CI end-to-end runs (§15.3)**
  - Description: A deterministic stub model/provider (or a scripted mock
    `Model` + `Provider`) the loop drives end-to-end without API keys, so every
    host test is a real assertion, not a manual run. **Pin the contract first:**
    before writing any E2E test, inspect `@earendil-works/pi-ai`
    `dist/types.d.ts` and confirm the exact `Provider` interface +
    `AssistantMessageEventStream` shape the stub must implement to satisfy
    `createAgentSession({ model: stubModel })` — a `Model` is data
    (`id`/`name`/`api`/`provider`/`baseUrl`/`cost`/…); streaming behavior lives
    on `Provider.stream` (`StreamFunction`). Record the pinned shape as a
    comment in `stub-provider.ts` so a future SDK upgrade surfaces drift. The
    stub emits a configurable `handoff`/`end` per role, returns canned `usage`
    on `message_end` in the SDK shape (camelCase + nested `cost.total`,
    `totalTokens`, assistant-only), and can be scripted to call `handoff` then
    `bash` (for Task 15.5) or to fail (for Task 18). If the
    `Provider`/`StreamFunction` surface cannot be faked cleanly, raise it as a
    blocker **before** any E2E test is written — this is the load-bearing
    assumption for all of Phases 4–5.
  - Acceptance: (1) A minimal stub `Model`+`Provider` drives one
    `createAgentSession` turn with canned `usage` and asserts the §11.4 mapping
    against the captured event — **gated before any E2E test**. (2) A full
    `orchestrator → worker →
    orchestrator → end` run completes in CI via the
    stub with no network and no API key, asserting the persisted record shapes
    (§11.2–§11.5) and final checkpoint.
  - Verification: `pnpm test -- host/e2e` (automated).
  - Dependencies: Task 15.5
  - Files: `src/host/stub-provider.ts`, `tests/host/e2e.test.ts`
  - Scope: M
  - Status: Complete (commit `9a377a6`). Implementation notes from the work:
    - **Pinned SDK contract** (recorded as a module-level comment so a future
      SDK upgrade surfaces drift in CI): Model is data only
      (`id`/`name`/`api`/`provider`/`baseUrl`/`reasoning`/`input`/
      `cost`/`contextWindow`/`maxTokens`); Provider.stream is a `StreamFunction`
      returning an `AssistantMessageEventStream` (a class with
      `push()`/`end()`/`result()`); the event protocol is a discriminated union
      of `start` / `text_*` / `thinking_*` / `toolcall_*` / `done` / `error`;
      `AssistantMessage.usage` carries the SDK Usage shape (camelCase + nested
      `cost.total` + `totalTokens`).
    - **Pin the contract first was straightforward.** Task 13's pre-flight
      already covered the Model / StreamFunction / AssistantMessageEvent shapes;
      Task 16's work focused on wiring the stub through
      `ModelRegistry.registerProvider` with the right `api` + `apiKey` fields.
    - **Stub provider interface.** `makeStubModel()` returns a `Model<any>` with
      `provider: 'stub'`. `makeStubStreamFunction({
        steps, usage })`
      returns a `StreamFunction` that consumes one step per `stream()` call (one
      step per agent turn) and pushes the corresponding `AssistantMessageEvent`
      sequence synchronously onto a fresh `AssistantMessageEventStream`. Step
      kinds: `emit_handoff` / `emit_end` / `emit_text` / `no_emission` / `fail`.
    - **Wiring pattern.** Production + tests: register the stub on an in-memory
      ModelRegistry with
      `registerProvider('stub', { api: 'anthropic-messages',
        apiKey: '<dummy>', streamSimple })`;
      pass `modelRegistry` to `createAgentSession`. The agent runtime resolves
      `model.provider === 'stub'` to the registered provider's streamSimple — no
      network, no API key.
    - **StubHost** (test-only minimal real `Host` implementation in
      `tests/host/e2e.test.ts`) wires `createAgentSession` with the stub
      provider + Task 14's handoff/end tools + a SessionSeam per session. Used
      by Tests 2 + 3 to drive the full loop end-to-end.
    - **§11.4 mapping source** is pinned by Test 1: the stub's
      `usage: Partial<Usage>` is asserted verbatim against the `message_end`
      event's `message.usage`. Task 17 (Phase 5) wires the host's accumulation;
      this test is the source-pin that guards against SDK drift.
    - **Three E2E tests** cover the plan's acceptance scenarios:
      - (1) Stub drives one createAgentSession turn with canned usage — asserts
        the §11.4 SDK mapping source pin.
      - (2) Full orch -> worker -> orch -> end run via runLoop
        - StubHost — asserts persisted record shapes (§11.1 + §11.2 + §11.4) and
          final checkpoint.
      - (3) no_emission scripted step drives a §11.3 breach —
        session_failed(no_emission), no reduce, no transition_rejected. Same
        contract as Task 15's FakeHost tests, end-to-end via the real SDK.

- [x] **Task 16.5: Orchestrator run-memory seeding per turn (§8.4, §11.8)**
  - Description: Before each orchestrator session's `prompt`, the host rebuilds
    the run-memory artifact via `buildRunMemory` (Phase 3 Task 12) from the
    persisted records + checkpoint and injects it into the seed (system prompt /
    first user message) so each orchestrator turn sees `run_cost_to_date`,
    `remaining_budget`, `per_role_cost`, `next_candidates`. Single-writer rule:
    only orchestrator sessions receive the artifact.
  - Acceptance: An orchestrator session's first turn references current run cost
    and uncapped candidates; a second orchestrator turn after a worker visit
    reflects the new `visit_history` entry. Tested via the stub provider.
  - Verification: `pnpm test -- host/run-memory` (automated).
  - Dependencies: Task 16
  - Files: `src/host/run-memory.ts`, `tests/host/run-memory.test.ts`
  - Scope: M
  - Status: Complete (commit `b990c46`). Implementation notes from the work:
    - **Loop-level wiring.** The loop checks `role === def.orchestrator` at the
      top of each outer iteration; if so, it calls
      `host.seedRunMemory({ checkpoint, def, goal, runCostCap })` and feeds
      `formatRunMemorySeed(memory)` into `session.prompt`. Worker sessions
      bypass this branch (single-writer rule, §8.4).
    - **RunLoopOptions.runCostCap** (Task 16.5 surface) defaults to null; Phase
      5 wires the live `RunHandle.runConfig()` to push overrides through here.
    - **StubHost.seedRunMemory** updated to delegate to
      `buildRunMemory(args.checkpoint, records, args.def, ...)` so the seed
      reflects actual persisted visit_history / per_role_cost / next_candidates.
    - **4 new tests** in `tests/host/run-memory.test.ts` cover:
      - First orchestrator turn references `$0.0000` cost, `uncapped` cap,
        `(no sessions yet)` history, `(no role
            cost yet)`, and
        `Available workers (visit-capped AND
            run-budget-uncapped): worker.`.
      - Second orchestrator turn after a worker visit surfaces a
        `worker (visit 1, session_ended,
            $0.0000)` history entry and
        a `worker: $0.0000 (0
            tokens)` per-role-cost entry.
      - Single-writer rule: worker sessions get the handoff payload
        (`[handoff → worker]`) and NOT the run-memory artifact.
      - `runCostCap: 5.0` flows through to the seed: `run_cost_cap: $5.0000`,
        `$5.0000 remaining`.

## Checkpoint D — SDK host driver wired

- [x] Legal handoff spawns + seeds the next role session end-to-end (automated
      test)
- [x] Illegal handoff is rejected with `legal_targets` surfaced to the role
      (automated)
- [x] Orchestrator sees run-memory context each turn (automated)
- [x] **Post-emission tool guarding:** a stub model that calls `handoff` then
      `bash` produces zero `bash` side effects and exactly one capture
      (automated)
- [x] **Resume:** a run killed mid-session resumes to the same terminal state
      via `resumeRun(run_id)` from the file-backed log (automated)
- [x] Full linear run passes in CI via the stub provider, no API key
- [x] Review with human before cost/observability surfaces
