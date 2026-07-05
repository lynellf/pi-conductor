# Changelog

## [0.7.1] - 2026-07-05

### Enhancement
- **Structured diff hunks in `TouchedFile`** (issue #13).
  `TouchedFile` gains an optional `hunks?: ReadonlyArray<HunkLine>`
  field populated by the host on successful `tool_result` events for
  `write` and `edit` built-in tools. `HunkLine` carries `lineNumber`,
  `content` (with `+`/`-` prefix for add/del lines), and `kind`
  (`add | del | context`). New types `HunkLine` and `TouchedFile.hunks`
  in `src/host/display-sink.ts`. New module `src/host/hunk-diff.ts` with
  `parseDiffHunks` (pure diff parsing via `diff` package),
  `buildWriteHunks` (write-tool hunk builder), and
  `loadWriteHunksForArgs` (async disk read at `tool_execution_start`
  for pre-mutation content capture). `edit` tool produces pure hunks
  from `args.edits[]`; `write` tool produces hunks by diffing captured
  pre-write content against `args.content`. New files (no prior content)
  get all-`add` hunks; disk read failures degrade gracefully (char-counts
  still flow, `hunks` absent). `extractFileHunks(toolName, args)` pure
  helper added to `src/host/display-sink.ts` for `edit` tool.

### Bug fixes
- **Test assertions fixed for `diff` library behavior.** The hunk-diff
  tests and display-forwarding integration tests now correctly reflect
  the `diff` package's line-by-line output format. Line number
  tracking correctly handles deletions and additions with cumulative
  offset calculation. Tests updated in `tests/host/hunk-diff.test.ts` and
  `tests/host/display-forwarding.test.ts`.

### Notes
- No breaking changes to the public API surface. `hunks` is optional
  and additive; consumers that don't read it are unaffected. The
  grep-guard test (`tests/grep-guard.test.ts`) and the
  `no-ctx.newSession`/`no-ctx.fork` extension grep guard continue to
  pass.
- TypeScript strict mode enforced; all `noNonNullAssertion` lint
  warnings fixed in test files.

## [0.6.0] - 2026-07-03

### Enhancement
- **DisplayEvent carries `files` for file-mutating tools** (issue #12).
  `DisplayEvent` gains an optional `files?: ReadonlyArray<TouchedFile>`
  field, populated by the host on successful `tool_result` events for
  the `write` and `edit` built-in tools. Each `TouchedFile` entry
  carries `path`, `additions` (char-count of new content), and
  `deletions` (char-count of removed content). For `write`, `deletions`
  is always `0` because pre-write content is not observable from tool
  args; `edit` reports summed char-counts across its `edits[]` array.
  Read-only tools (`read`, `grep`, `find`, `ls`) and machine tools
  (`handoff`, `end`, `ask_user`) never populate `files`; `bash` is
  out of scope for this release. Consumers that don't need file
  annotations can ignore the field entirely; the TUI bridge is
  unchanged. New `extractFileMutations(toolName, args)` pure helper
  in `src/host/display-sink.ts`. Spec:
  `docs/open-issues-round-3/phase-1-issue-12-touched-files.md`.

### Bug fixes
- **Issue #11 closed as already implemented.** The per-chunk
  `text_stream` emission described in issue #11 was removed in commit
  `6f962f2` (Phase 1, open-issues-round-2) — the same commit that
  fixed the related #8 TUI disjointed output bug. One
  `DisplayEvent` per assistant turn at `message_end` has been the
  behavior since 0.5.3 (pinned by `tests/host/display-forwarding.test.ts`
  "Single-emit per turn" describe block). No code change.

### Notes
- No breaking changes to the public API surface. The `files` field
  is optional and additive; consumers that don't read it are unaffected.
  The grep-guard test (`tests/grep-guard.test.ts`) and the
  `no-ctx.newSession`/`no-ctx.fork` extension grep guard continue to
  pass — the new code stays in `src/host/`.
- Two new test files: `tests/host/display-sink.test.ts` (pure unit
  tests for `extractFileMutations`, 25 cases) and extended
  `tests/host/display-forwarding.test.ts` (7 new integration cases
  for the wired `files` behavior).

## [0.5.3] - 2026-07-03

### Host driver
- **Pre-flight check: warn on unregistered providers** (issue #6,
  commit `44a4397`). At manifest-load time, when a `ModelRegistry`
  is supplied to `loadManifest` / `loadManifestFromString`, an
  advisory `"unregistered-provider"` warning is emitted for each
  `role.models[].entry` pair not registered in pi's runtime
  registry. Surfaced on the extension `/conduct` and `/conduct:resume`
  paths via `ctx.ui.notify` and on the `conduct` CLI via stderr.
  The runtime `ModelNotFoundError` from `spawnRole` is unchanged —
  providers registered by extensions that load after conductor
  (or dynamically) still resolve at use time. Spec:
  `docs/archive/issues-5-and-6/phase-2-provider-preflight.md`.
- **Resume context restores the original goal** (issue #9, commits
  `2145f53` and `566e9ee`). `startRun` now appends a new
  `run_seeded` record to the log immediately after the initial
  `checkpoint_snapshot`; `resumeRun` reads the latest `run_seeded`
  for the run and uses its `goal` as `initialGoal`. New
  `RunHandle.originalGoal(): string` seam surfaces the persisted
  goal for diagnostics. Pre-existing in-flight runs (no
  `run_seeded` record on disk) fall back to the previous
  empty-goal behavior — no regression. Spec:
  `docs/archive/open-issues-round-2/phase-2-issue-9-resume-context.md`.

### Bug fixes
- **Disjointed TUI output** (issue #8, commit `6f962f2`). Text and
  thinking content from a role's assistant turn now render as one
  continuous block in pi's TUI instead of as multiple visually-
  separated chunks. Root cause: pi's `CustomMessageComponent`
  hardcodes a leading `Spacer(1)` per `CustomMessage`, and the
  per-chunk `conduct.role.text_stream` emissions each inserted a
  fresh `CustomMessage` (with its Spacer). Fix: buffer chunks and
  emit exactly one `conduct.role.text` `CustomMessage` per turn
  at `message_end`. The `text_stream` `DisplayEventKind` variant
  is retained internally; the `text_stream` key is removed from
  `ConductMessageKind` and `createConductMessageRenderers`. Tool
  events (`conduct.role.tool`) remain per-event — they are
  atomic. **Behavior change:** live progressive text rendering is
  gone; the role's text and thinking appear all at once at
  `message_end`. Spec:
  `docs/archive/open-issues-round-2/phase-1-issue-8-tui-disjointed.md`.

### Documentation
- **`subscribeToRecords` contract surface** (issue #5). The full
  contract (FIFO ordering, fire-and-forget async, sync-throw and
  async-rejection isolation, re-entrant subscribe/unsubscribe,
  idempotent unsubscribe, empty-set fast path, durable backstop,
  out-of-scope) is documented at `docs/record-emitter-spec.md`
  (~166 lines added). No behavior change.

### Notes
- No breaking changes to the public API surface — `src/index.ts`
  is unchanged. The `subscribeToRecords` / `startRun` / `resumeRun`
  / `listRuns` / `createProductionHost` / `getDefaultBundle`
  exports from 0.5.0 hold. The only renderer-map delta
  (`conduct.role.text_stream` removed) is renderer-registry
  internals; no library consumer is expected to register against
  that customType.
- Two host-internal modules were deleted:
  `src/host/boundary-flush.ts` and `src/host/markdown-continuation.ts`.
  Neither was re-exported from `src/index.ts`. The
  `STREAM_FLUSH_THRESHOLD_CHARS` and `MAX_FLUSH_WINDOW_CHARS`
  constants are gone with them.
- New `PersistedRecord` variant `run_seeded` (host-owned,
  non-machine-event; the reducer never branches on it). Existing
  readers that exhaustively switch on `PersistedRecord.type` need
  a new arm; the project's OOS log (`src/persistence/log.ts:44`)
  is type-driven and in-repo readers are updated.
- The grep-guard test (`tests/grep-guard.test.ts`) and the
  `no-ctx.newSession` / `no-ctx.fork` extension grep guard
  continue to pass — no code outside `src/host/` and
  `src/extension/` (and the corresponding tests) was touched.

## [0.5.2] - 2026-06-30

### Bug fixes
- Allow `provider:id` entries with colons in the id (e.g. Ollama tags `ollama:model:tag`); the resolver now uses the first colon as the separator (closes #3).

### Documentation
- Fix broken links in README: external pi links updated to monorepo paths, internal spec links repointed to `docs/archive/`, monorepo hedge text simplified (closes #1, #2, #4).
- Remove stale `docs/record-emitter-spec.md` reference from `src/host/record-emitter.ts` JSDoc (closes #4).

### Tests
- Add positive test for multi-colon model ID resolution with provider-find spy assertion.
- Add validator test ensuring multi-colon entries pass the bare-model-alias check.

## [0.5.1] - 2026-06-26

### Bug fixes
- **Streaming markdown: quote-block continuity across chunk boundaries.** Continuation chunks emitted from `message_update` and `message_end` in `src/host/session-event-handler.ts` now flow through a new pure normalizer `normalizeContinuationChunk` (`src/host/markdown-continuation.ts`, ~150 LOC) that walks back to the slice's logical line start and prepends the appropriate `> ` (or `> > `) prefix when the slice starts mid-line inside a blockquoted thinking line. The prefix insertion is display-only: `stream.len` continues to count characters in the original formatted string, so the source/accounting invariant is preserved and `findFlushBoundary()` behavior is unchanged. Continuation chunks that start at a line boundary or in non-quoted text are emitted unchanged. Closes the display regression where text starting inside a quote block would finish outside of it after a flush boundary (originally evidenced by `docs/image.png` and `docs/Screenshot 2026-06-24 at 10.03.08 PM.png`; both removed in bf054d8). Spec: `docs/archive/quote-block-rendering-fix/spec.md`.

### Tests
- `tests/host/markdown-continuation.test.ts` (new, ~290 lines): 19 table-driven cases for `normalizeContinuationChunk` and `detectQuotePrefix` — `sliceStart === 0`, empty slice, mid-line blockquoted, start-of-new-line, mid-line unquoted, nested quotes, multi-line chunk with quote prefix, unquoted current line, slice-to-end, text-only messages, and `>` without trailing space.
- `tests/host/display-forwarding.test.ts` (~90 lines added): end-to-end coverage for the screenshot regression. The two new cases assert that quoted continuation chunks preserve the blockquote marker and that unquoted continuation chunks do not pick one up, both through the full `attachSessionEventHandler` pipeline.

### Notes
- No breaking changes to the public API surface. No new exports. The new module is pure (no I/O, no side effects) and lives in `src/host/`; the grep-guard test (`tests/grep-guard.test.ts`) and the `no-ctx.newSession` / `no-ctx.fork` extension grep guard continue to pass.
- The deferred limitations called out in the spec (full code-fence state rebasing inside quoted thinking; lazy-continuation `>` markers on lines that don't start with `>`; indented blockquotes with leading whitespace) are not addressed by this release.
- A manual TUI visual check on a live `/conduct` session remains the only open step before the next feature work; the integration tests in `tests/host/display-forwarding.test.ts` pin the behavioral contract but do not replace a human eye on a running session.
- The completed `docs/quote-block-rendering-fix/` plan was moved to `docs/archive/quote-block-rendering-fix/` after the spec/plan/tasks were reviewed and shipped; the spec is the durable record of the bug and the fix surface.

## [0.5.0] - 2026-06-24

### Host driver
- **Progressive assistant-text streaming.** `onSessionEvent` (`src/host/session-event-handler.ts`) now recomputes `extractAssistantText` on every `message_update` and emits the new suffix to the display sink once the accumulated delta crosses `STREAM_FLUSH_THRESHOLD_CHARS` (200 chars); `message_end` always flushes the unflushed tail regardless of threshold. Char-driven cadence (not time-driven) keeps the loop deterministic and unit-testable without fake timers. The threshold is exported as the test seam and the future config-flag follow-up. Spec: `docs/archive/tool-ux-refinement/phase-1-suffix-chunk-streaming.md` (new), `docs/archive/progressive-text-streaming/spec.md` (new).
- **`ask_user` tool serialization (closes the fceb3964 double-dialog hang).** Two guards now prevent the race when a role emits multiple `ask_user` calls in one assistant turn: (1) `executionMode: "sequential"` on the tool definition, which the SDK dispatcher reads; (2) a per-instance promise-chain mutex inside `execute` in `src/host/ask-user-tool.ts`, the belt-and-suspenders backstop for direct-execute paths (unit tests, forked CLI UIs). The `finally` block releases the lock on rejection so a failed dialog never leaks the mutex. Spec §B (in-file).
- **Tool summary formatters.** New `src/host/tool-summary.ts` exposes `formatToolCallSummary`, `formatToolResultSummary`, and the combined `formatToolCompletedLine` (`(✓|✗) <summary>: <error first line>`). All three return `null` for conductor machine tools (`handoff` / `end` / `ask_user`) and for unknown tools — protocol noise and JSON floods stay out of the TUI. Constants: `MAX_BASH_COMMAND_DISPLAY_LENGTH = 60` (tail-truncated with `…`), `MAX_ERROR_LINE_DISPLAY_LENGTH = 80`. Spec: `docs/archive/tool-display-combine-status/phase-1-combine-tool-line.md` (new).
- **Display-sink: blockquote reasoning.** `extractAssistantText` in `src/host/display-sink.ts` now `> `-prefixes every line of a non-redacted `ThinkingContent` block so reasoning reads as markdown blockquote in the TUI — visually de-emphasized relative to direct user communication. Redacted thinking still returns `""` and is filtered upstream. The `stringifyDisplayValue` helper was removed: it was only used by the tool path that's now formatter-mediated.

### Extension shell
- **Tool observability restored.** The display sink in `src/extension/display-sink-wiring.ts` re-emits tool events as a second `CustomMessage` customType — `conduct.role.tool`, `details.kind: "tool"`. The body is the formatter-produced summary (`bash: pnpm test`, `✓`, `✗ <first error line>`), not the raw JSON. Conductor machine tools never reach the sink. Full tool bodies remain in the per-role session JSONL — the TUI stream is the observability surface, not the durable record. Spec: `docs/archive/tool-observability-and-spinner-spec.md`.
- **`conduct.role.tool` message renderer.** New `buildToolContainer` in `src/extension/conduct-message-renderer.ts` produces a compact two-child `Container`: a role label colored with `TOOL_LABEL_COLOR` (dim, not bold; not `pickLabelColor`) and a `Markdown` body wrapping the formatter output in `> `-prefixed blockquote lines (M1 amended from plain `Text`). The renderer reuses the same `details` shape as the text renderer plus `kind: "tool"`. Spec: `docs/archive/tool-ux-refinement/phase-1-error-and-quote-block.md` (new).
- **Status line spinner.** `startStatusPoller` in `src/extension/status.ts` prepends a braille frame (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) to the status line while `exitReason === "running"`; the frame cycles on the 250ms poll tick and clears on terminal ticks. Spinner is prepended at the poller level — `formatConductStatus` stays pure and its 11 string-equality tests are unchanged. Spec: `docs/archive/tool-observability-and-spinner/phase-7b-ux-tool-observability.md` (new).

### Tests
- `tests/host/tool-summary.test.ts` (new, ~209 lines): `bash` command formatting with the 60-char truncation boundary, error-line truncation at 80, machine-tool suppression (`handoff` / `end` / `ask_user`), unknown-tool `null`, success/error status lines, and the combined-line model.
- `tests/extension/conduct-tool-renderer.test.ts` (new, ~254 lines): `conduct.role.tool` renderer for `tool_call` / `tool_result`, label-color contract (`TOOL_LABEL_COLOR`, not `pickLabelColor`), Markdown blockquote wrap.
- `tests/extension/status-spinner.test.ts` (new, ~187 lines): frame cycling, terminal-tick clear, initial render.
- `tests/extension/tui-bridge.test.ts` (~140 lines updated): confirms correct event forwarding for `text` and `tool` events through the TUI bridge.
- `tests/host/display-forwarding.test.ts` (~415 lines net, ~284 new): chunk-streaming suffix emission, threshold boundary, machine-tool suppression, formatter integration, blockquote on thinking.
- `tests/host/ask-user-tool.test.ts` (~132 lines added): sequential-execution mutex, `executionMode` flag, `signal` cancellation propagation through the chain.
- `tests/host/e2e.test.ts` (~188 lines added): the two-`select`-in-one-turn concurrency scenario no longer hangs.
- `tests/extension/conduct-message-renderer.test.ts` and `tests/extension/conduct-registration.test.ts` (~30 lines updated): cover the new `conduct.role.tool` renderer return + registration path.

### Docs
- Five implemented specs moved from `docs/` to `docs/archive/`: `orchestrator-fsm-spec.md`, `manifest-model-effort-spec.md`, `publishing-readiness-spec.md`, `default-fixture-ci-fix/`, `tool-observability-and-spinner/`, `tool-observability-and-spinner-spec.md`.
- Four new archive spec entries — the work above is now spec-backed:
  - `docs/archive/tool-ux-refinement/phase-1-suffix-chunk-streaming.md` — chunk streaming.
  - `docs/archive/tool-ux-refinement/phase-1-error-and-quote-block.md` — display-sink thinking blockquote + tool-body blockquote (M1).
  - `docs/archive/tool-display-combine-status/phase-1-combine-tool-line.md` + `spec.md` — combined `formatToolCompletedLine`.
  - `docs/archive/tool-ux-refinement-spec.md` — tool UX refinement umbrella.
  - `docs/archive/progressive-text-streaming/spec.md` — streaming umbrella.

### Notes
- No breaking changes to the public API surface. One new `export const number` (`STREAM_FLUSH_THRESHOLD_CHARS`) and one removed internal helper (`stringifyDisplayValue` — host-internal, never re-exported from `src/index.ts`). Library consumers are unaffected. The grep-guard test (`tests/grep-guard.test.ts`) and the `no-ctx.newSession`/`no-ctx.fork` extension grep guard continue to pass — the new code stays in `src/host/` and `src/extension/`.
- The status-spinner cycle (250ms) and the chunk-streaming threshold (200 chars) are spec'd defaults; a follow-up exposes them via host config (open concern 4 in the chunk-streaming spec).

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
