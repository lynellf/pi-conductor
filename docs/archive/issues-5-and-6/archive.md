# Archive — Resolve open issues #5 and #6

**Archived:** 2026-07-01
**Plan directory:** `docs/issues-5-and-6/`
**Branch:** `fix/open-issues-triage` (uncommitted)

## Original goal

Resolve two GH issues filed by the repo owner (`lynellf/pi-conductor`, 2026-06-30):

- **Issue #5** (docs, enhancement): Consolidate the `subscribeToRecords` contract surface into a dedicated `docs/record-emitter-spec.md` as the single source of truth. Previously the full contract lived only in `src/host/record-emitter.ts` JSDoc and `tests/host/record-emitter.test.ts`.
- **Issue #6** (enhancement): Add a load-time advisory check (`unregistered-provider` warning) that detects `role.models[].entry` values whose `(provider, id)` pair is not registered in pi's `ModelRegistry`, surfacing the problem before the first `spawnRole` throws `ModelNotFoundError`.

## Outcome

Both issues resolved. No behavior regression. All invariants preserved (grep guard passes, core remains host-agnostic, reducer unchanged).

### Issue #5 — Record-emitter spec consolidation

- `docs/record-emitter-spec.md` created with §1–§7 covering purpose, design, API, contract clauses (FIFO, fire-and-forget async, sync-throw/async-rejection isolation, re-entrant subscribe/unsubscribe, empty-set fast-path), durable backstop, and out-of-scope items.
- `src/host/record-emitter.ts` JSDoc trimmed; points to the new spec as authority.
- `tests/host/record-emitter.test.ts` top-of-file updated to reference the new spec.
- No behavior change (9 existing test cases pass unchanged).

### Issue #6 — Provider-registration preflight check

- New warning code `"unregistered-provider"` added to `ManifestWarningCode` union in `src/manifest/validate.ts`.
- `checkModelProvidersRegistered()` added in `src/host/manifest.ts` — iterates `manifest.roles[].models[]`, calls `modelRegistry.find(provider, id)`, emits one warning per unregistered entry.
- `loadManifest` / `loadManifestFromString` accept optional `modelRegistry` parameter; when provided, the preflight check runs after `validateManifest` + `toMachineDefinition`.
- `StartRunOptions` / `ResumeRunOptions` grow optional `modelRegistry` field in `src/host/api.ts`.
- `RunHandle` grows public `readonly loadedManifest` field in `src/host/run-handle.ts`.
- Extension paths (`src/extension/commands/start.ts`, `resume.ts`) forward `ctx.modelRegistry` and surface warnings via `ctx.ui.notify`.
- CLI path (`src/bin/conduct.ts`) forwards `CliDeps.modelRegistry` and surfaces warnings on stderr.
- Full test coverage: `tests/host/manifest.test.ts` (T2.9 — check behavior), `tests/host/api.test.ts` (T2.10 — start/resume wiring), `tests/host/run-handle.test.ts` (T2.11 — handle field), `tests/bin/conduct.test.ts` (T2.12 — CLI surface).
- Host-agnostic core invariant preserved: `src/manifest/**` has zero pi imports.
- `pnpm typecheck` / `pnpm lint` / `pnpm test` all green. 731/731 tests pass.

## Files changed

Modified source:
- `src/manifest/validate.ts` — added `"unregistered-provider"` to `ManifestWarningCode`
- `src/host/manifest.ts` — added `checkModelProvidersRegistered`, updated `loadManifest`/`loadManifestFromString` signatures, updated JSDoc
- `src/host/api.ts` — updated `StartRunOptions`/`ResumeRunOptions`/`RunWithCompletionArgs`, plumbed registry through `startRun`/`resumeRun`
- `src/host/run-handle.ts` — added `public readonly loadedManifest` field, updated constructor opt type
- `src/host/record-emitter.ts` — JSDoc trimmed to point to spec doc
- `src/extension/commands/start.ts` — forwarded `ctx.modelRegistry` to `startRun`, surfaced warnings via `ctx.ui.notify`
- `src/extension/commands/resume.ts` — forwarded `ctx.modelRegistry` to `resumeRun`, surfaced warnings via `ctx.ui.notify`
- `src/bin/conduct.ts` — forwarded `CliDeps.modelRegistry` to `startRunImpl`, surfaced warnings on stderr
- `CHANGELOG.md` — added `[Unreleased]` entries for both issues

New files:
- `docs/record-emitter-spec.md` — Issue #5 consolidated contract spec
- `tests/host/api.test.ts` — Issue #6 start/resume wiring tests

Modified tests:
- `tests/host/manifest.test.ts` — 6 new test cases (T2.9)
- `tests/host/run-handle.test.ts` — 2 new test cases (T2.11)
- `tests/host/record-emitter.test.ts` — top-of-file comment updated
- `tests/bin/conduct.test.ts` — 2 new test cases (T2.12)
- `tests/extension/tui-bridge.test.ts` — 1 new test case (extension warning surface)
- `tests/host/stats.test.ts` — 1 new test case (stats counting with new warning)

## Reviewer verdict

**APPROVE-WITH-NITS.** No required changes. Two non-blocking nits:

1. **CLI preflight test gap** (`tests/bin/conduct.test.ts`): The test for the CLI path only asserts `out.error` is called but does not verify the *content* of the warning message. Future-proofing: adding a message-content assertion would catch a regression where the format changes but the call count stays the same.
2. **Reference-equality test name** (`tests/host/api.test.ts`): The test verifying `handle.loadedManifest` is the same reference passed through `loadManifest` is named "same reference as LoadedManifest" but the check is reference-equality, not identity-mutation semantics — the name could be more precise.

### FYIs (not blocking, noted for future)

- Pre-existing extension test path-resolution bug in `tests/extension/tui-bridge.test.ts` — path resolution fails on CI due to a relative import that resolves differently than in the test runner. Not introduced by this change.
- `undici` advisories via transitive dep `pi-coding-agent`. Already tracked; not introduced by this change.

## Deferred work

- **Manual verification (pending):** Run `/conduct` in a real pi session with an unregistered provider (e.g. `ollama` not registered) to confirm the warning surfaces via the extension UI on both `/conduct` and `/conduct:resume`, and that the runtime `ModelNotFoundError` still fires from `spawnRole` when the unregistered model is actually used.

## Knowledge candidates (for `okf-curator`)

- Manifest validation contract boundary: `src/manifest/validateManifest` operates on `Manifest` data only; runtime availability checks against the `ModelRegistry` live in `src/host/manifest.ts:checkModelProvidersRegistered`. Stable architectural decision documented in `docs/issues-5-and-6/plan.md` and `docs/issues-5-and-6/phase-2-provider-preflight.md`.
- Record-emitter contract scope: the durable JSONL log is the system of record; the in-process emitter is best-effort fan-out codified in `docs/record-emitter-spec.md`.
