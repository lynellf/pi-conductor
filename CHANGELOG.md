# Changelog

## [0.4.1] - 2026-06-23

### Bug fixes
- **`ask_user` tool parameter handling** (closes Issue #1): replaced the `Type.Union([...])` schema with a flat `Type.Object` whose `kind` field is a `Type.Unsafe({ type: "string", enum: [...] })` — the same primitive pi-ai's `StringEnum` uses. The previous union-rooted schema was rejected by some model providers (the agent received `{}` despite providing structured params). The `execute` switch is now exhaustive — a `default` arm throws a typed error on unknown `kind` — and the `select` branch defensively validates that `options` is present and non-empty. No silent fallbacks.
- **`/conduct:list` exitReason attribution** (closes Issue #2): extracted a new pure helper `computeListedExitReason(records, latestCheckpoint)` in `src/extension/commands/list-stats.ts` and wired it into `handleList`. The helper mirrors `RunHandle.computeExitReason`'s rule order (`done` → `session_failed` → `running`), minus the in-process `aborted` branch (unreachable from a file log; a run aborted by `Esc` that never persisted a `session_failed` reads as `running`, which is the honest fallback). Previously `handleList` hard-coded `"running"` for every run, misattributing the exit reason of terminal runs.

### Tests
- `tests/host/ask-user-tool.test.ts`: 12 new tests (3 runtime validation + 9 schema-level). The schema-level tests use `Value.Check` from `typebox/value` (the same subpath `tests/seam/validate-emission.test.ts` uses) and include a regression guard asserting the serialized schema has no `anyOf`/`const` at the root.
- `tests/extension/list-stats.test.ts` (new): 7 table-driven tests covering all five plan scenarios (A–E) plus the done-precedence-over-session_failed case. The helper is unit-testable without driving the pi extension UI harness.
- `tests/extension/conduct-list.test.ts`: updated the bug-baking assertion in the "appends a transition trace" case (`done · running` → `done · done`) to reflect the corrected attribution. The 3 other `· running ·` assertions in the same file are correctly preserved (they seed scenarios where `running` is genuinely correct: `worker` / `orchestrator` checkpoints with no terminal record).

## [0.4.0] - 2026-06-23

### Public API
- New `subscribeToRecords(listener)` function exported from `pi-conductor`'s public barrel — a typed, in-process fan-out of every `PersistedRecord` the host driver appends to a run log. Returns an idempotent unsubscribe handle. Listeners fire in FIFO subscription order; sync throws and async rejections are isolated and do not affect the engine or other listeners.
- New `PersistedRecord` type re-exported from the public barrel for consumer convenience.

### Host driver
- `ProductionHost.persistRecord` and `StubHost.persistRecord` call `notifyListeners(record)` after every successful log append. The loop is unchanged; the host's persist call is the single chokepoint for fan-out.
- New host-internal module `src/host/record-emitter.ts` (~117 LOC) — module-level `Set<Listener>`, fire-and-forget, sync/async error isolation, re-entrant subscribe/unsubscribe (effects take place on the next record), idempotent unsubscribe, empty-set no-op fast path.

### Extension shell
- Optional `pi.events` bridge in `extensions/conduct.ts` — re-emits every record on `pi.events.emit("conductor:record", record)` for consumers that prefer the documented `pi.events` bus. Thin wrapper over `subscribeToRecords`; the bridge is not required for the API to work.

### Tests
- New `tests/host/record-emitter.test.ts` covers all 9 spec §9 behaviors: listener fires on every persist, multiple listeners in FIFO order, sync-throw isolation, async-rejection isolation, re-entrant subscribe (next record), re-entrant unsubscribe (next record), idempotent unsubscribe, empty-set no-op, and consumer-side `run_id` filtering.

### Docs
- README: new "Hooking into the record stream" section documents the public API, a consumer-extension sketch (adapted from spec §10), the optional `pi.events` bridge, and the explicit "what this is not" boundaries. "Status & what's left" now references both the FSM and the record-emitter specs.
- `docs/record-emitter-spec.md` is the authority on the full contract (FIFO ordering, async fire-and-forget, error isolation, re-entrancy, durable backstop pattern, security posture).

### Notes
- The emitter covers loop-time `host.persistRecord` calls only. Direct `log.append` call-sites in `src/host/api.ts` (initial snapshot in `startRun`, crash reconciliation records in `reconcileCrash`) are out of scope; consumers needing those records can replay from the durable log per the spec.
- No new dependencies added. No new I/O surface. The grep-guard test (`tests/grep-guard.test.ts`) continues to pass — the new module is in `src/host/`, which the guard explicitly allows. The `no-ctx.newSession`/no-`ctx.fork` extension grep guard continues to pass — the bridge uses `pi.events.emit`, not session-tree APIs.

## [0.3.0] - 2026-06-21

### Manifest
- Per-model `effort` configuration in `roles[].models` — new object form `{ model, effort }` alongside the existing string shorthand (backward compatible).
- `effort` accepts pi's `thinkingLevel` values (`off | minimal | low | medium | high | xhigh`); omitted `effort` defaults to `medium`, including the system/default model path.
- New `invalid-model-effort` validation code (rejected at parse / validate boundary).

### Core
- New host-agnostic `ModelEffort` type and `DEFAULT_MODEL_EFFORT` constant.
- `RoleConfig.models` is now a normalized `readonly ModelConfig[]` — the string shorthand is preserved at the YAML boundary and normalized to `{ model, effort: "medium" }` during parse. **Breaking for TypeScript library consumers** that read `RoleConfig.models` as `string[]`; runtime and YAML behavior are unchanged.

### Host driver
- `ProductionHost.spawnRole()` passes the selected effort to `createAgentSession({ thinkingLevel })` and returns it on `RoleSession.effort`.
- `StubHost.spawnRole()` mirrors the same normalized selection so loop tests stay deterministic.
- Lifecycle records (`session_started` and terminal events) carry `model_effort`; `RunStats.activeSession` exposes `effort` and defaults to `medium` for older records that lack the field.

### Extension shell
- Status footer shows `effort=<level>` alongside `model=<…>` while a role session is active; `/conduct:list` renders the same tokens.

### Docs
- README updated to document the new `effort` field, the object form of `models:`, and the `effort=` token in the status / list output.
- `docs/orchestrator-fsm-spec.md` §8 / §8.1 / §11.4 / §11.8 / §12 / §13 updated to reflect the new manifest shape, lifecycle metadata, and reducer meta field.

## [0.2.1] - 2026-06-21

### Chore
- Bump minimum supported Node.js to 22.19.0 in CI (`.github/workflows/ci.yml`) and the `engines` field; required by the locked pi SDK stack (`@earendil-works/pi-*` / `undici@8.3.0`).

## [0.2.0] - 2026-06-21

### Extension shell
- Press `Escape` to abort the active conductor run (with a confirmation prompt). Status footer shows an `Esc abort` hint while a session is running.

## [0.1.1] - 2026-06-21

### Chore
- Allow build scripts for `@google/genai` and `protobufjs` (transitive deps of `@earendil-works/pi-coding-agent@0.79.1`) so CI's `pnpm install --frozen-lockfile` passes under `strictDepBuilds: true`.

## [0.1.0] - 2026-06-20

### Core
- Pure deterministic FSM reducer (`reduce` / `reduceLifecycle`) with visit caps, cost-cap predicates, and two-reducer composition.
- Manifest parse / validate / derive (`toMachineDefinition`) with all spec §13 static checks.
- TypeBox emission schemas for `handoff` / `end` tools — single source of truth, shared by seam validation and tool-arg definitions.
- Pure cost roll-up (`RunRollup`) and session/run cap-evaluation predicates.
- `RecordLog` interface with `InMemoryRecordLog` (core) and `FileRecordLog` (host).
- Run-memory artifact (`buildRunMemory`) seeded into each orchestrator turn.

### Host driver
- Orchestration loop with legal-handoff spawning, illegal-handoff rejection (surfaces `legal_targets`), and post-emission session sealing.
- Resume from a file-backed log; cost-cap forced-`end` deferred to the orchestrator.
- Model-fallback escalation (primary → secondary models on `session_failed`).
- Production `Host` with `ModelRegistry` model resolution, `DefaultResourceLoader` prompt loading, and file-backed `SessionManager`.
- Stub-provider E2E test suite for CI (no API key required).

### Extension shell
- `/conduct <goal>`, `/conduct:resume <run_id>`, `/conduct:list`, `/conduct:abort` commands.
- `--conduct-manifest <path>` flag.
- HOME-scoped manifest fallback (`~/.pi/conductor.yaml`) with configurable `homeDir` for hermetic testing.
- Active model display in status footer and `/conduct:list` (`model=<provider:id>` or `model=<default>`).

### Packaging
- Ships as a pi extension (`package.json#pi.extensions`) with a CLI fallback (`bin/conduct`).
- Library API (`startRun`, `resumeRun`, `listRuns`, `createProductionHost`, `getDefaultBundle`).
- Default v1 bundle (one orchestrator + one worker).
