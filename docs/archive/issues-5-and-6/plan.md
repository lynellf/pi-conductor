# Plan — Resolve open issues #5 and #6

**Source:** GH issues #5, #6 on `lynellf/pi-conductor` (both opened 2026-06-30 by the
repo owner, no comments, no assignees). Investigated by `researcher` via `gh issue
view`; findings and open concerns relayed by the orchestrator.

**Revision 1 (post-`plan-reviewer-a` REQUEST-CHANGES):** Three factual errors
in Phase 2 corrected. Architecture, risk grading, grep-guard preservation,
and soft-warning pattern are unchanged.

- T2.4 — `resumeRun` DOES call `loadManifest` (at `api.ts:175`); the
  preflight check runs on resume too. The plumbing must cover both
  `startRun` and `resumeRun`.
- T2.5 — `RunHandle` does NOT store `loadedManifest`; the constructor
  at `run-handle.ts:79–88` does not accept it. A new field must be
  added to expose the warnings (and any other manifest reads the
  extension needs) through the handle.
- CLI — `src/bin/conduct.ts:57,82,253` already creates a `ModelRegistry`
  and exposes it via `CliDeps.modelRegistry`. The CLI is in scope:
  `runCli` must forward the registry to `startRunImpl` and surface
  the warnings on stderr/stdout.

## Context

Two long-standing repo-owner-filed issues, neither with a recorded decision:

- **#5 (docs, enhancement):** `subscribeToRecords`' full contract (FIFO, fire-and-forget
  async, sync-throw/async-rejection isolation, re-entrant subscribe/unsubscribe,
  idempotent unsubscribe, durable backstop) lives only in the inline JSDoc of
  `src/host/record-emitter.ts` and the test file. The README defers to the source
  file as the authority. Issue asks for a dedicated `docs/record-emitter-spec.md` so
  consumer-extension authors have a stable, reviewable surface.
- **#6 (enhancement):** After `validateManifest` and the runtime resolver both pass,
  `modelRegistry.find(provider, id)` can still return `undefined` when the provider
  (e.g. `ollama`) isn't registered in pi's `ModelRegistry`. The user then sees
  `ModelNotFoundError` at first `spawnRole` — a late failure that issue #3's resolver
  fix surfaced. Issue asks for a load-time advisory check. **This changes the §13
  contract boundary** — the validator currently operates only on manifest YAML, not
  against pi's runtime registry.

## Architecture decisions (Issue #6)

The host-agnostic core invariant (AGENTS.md, .okf/, `tests/grep-guard.test.ts`)
forbids `@earendil-works/pi-coding-agent` imports in `src/manifest`. The check needs
the `ModelRegistry`, so it cannot live in the §13 validator. Three options were
considered:

1. **Inject `ModelRegistry` into `validateManifest`** — would require declaring a
   `ModelRegistry`-shaped interface in `src/manifest/`, then casting at the call
   site. Adds indirection and pollutes the host-agnostic type surface; still
   effectively couples the validator to the SDK shape.
2. **Defer the check to first use (current behavior, no change)** — keeps the gap
   unaddressed. Issue #6 explicitly rejects this.
3. **Add a separate host-side advisory check in `src/host/`** — recommended.
   The check is structurally similar to the §13 soft warnings
   (`no-cheaper-fallback`, `missing-required-tool`) but operates on the
   `LoadedManifest` + `ModelRegistry` pair, not the bare `Manifest`. Spec §13
   stays scoped to static structural checks; the new check is a **runtime
   availability** check, documented as a host-side addition rather than an
   extension of §13. The grep guard is preserved: `src/manifest/validate.ts`
   still imports zero pi types.

**Placement:** `checkModelProvidersRegistered(manifest, modelRegistry)` in
`src/host/manifest.ts`, called from `loadManifest` / `loadManifestFromString`
when an optional `ModelRegistry` is passed. Warnings merge into
`LoadedManifest.warnings` with a new code: `unregistered-provider`.

**Advisory, not hard:** Matches the existing `ManifestWarning` pattern
(`no-cheaper-fallback`, `missing-required-tool`). Rationale matches the issue:
providers can be registered by pi extensions that load after conductor, or
dynamically during setup. A hard reject would block legitimate cases.

**Spec impact:** None to §13. The check is a host-side concern, not a static
manifest rule. Documented in `src/host/manifest.ts`'s module JSDoc as an
"additional advisory check" — explicit boundary. `LoadedManifest.warnings`
JSDoc gets a short addendum naming the new code and where the check runs.

## Ordering

- **Phase 1 (Issue #5) first:** trivial doc extraction; can be reviewed and merged
  before Issue #6 lands. Low risk; no behavior change. The two issues are
  independent — order does not affect correctness.
- **Phase 2 (Issue #6) second:** the architectural piece. Smaller surface than
  the spec/contract boundary tension suggests; the new code is one new function
  + one new warning code + plumbing. Lands after Issue #5 so the spec doc from
  Issue #5 can be cited from Issue #6's check JSDoc if needed (it isn't, but
  the ordering is a clean separation).

## Acceptance criteria for the plan

- [ ] Issue #5: `docs/record-emitter-spec.md` exists, consolidates the contract
      surface (FIFO, fire-and-forget async, sync-throw/async-rejection isolation,
      re-entrant subscribe/unsubscribe, idempotent unsubscribe, empty-set no-op,
      durable backstop), and is the single source of truth for the
      `subscribeToRecords` contract. Source-file JSDoc and test header point to
      the spec instead of duplicating it.
- [ ] Issue #6: `checkModelProvidersRegistered` runs at manifest-load time when
      a `ModelRegistry` is provided; emits `unregistered-provider` warnings
      for every `role.models[].entry` whose `(provider, id)` pair isn't
      registered; warnings surface to the user via the existing
      `LoadedManifest.warnings` path. **No hard reject** (matches the issue's
      stated rationale and the existing soft-warning pattern).
- [ ] Host-agnostic core invariant preserved: `src/manifest/**` still imports
      zero pi types. `tests/grep-guard.test.ts` still passes.
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` all green after each phase.
- [ ] No new record types, no reducer changes, no FSM contract changes.

## Out of scope

- Fixing the broken README link
  `[`docs/orchestrator-fsm-spec.md`](docs/archive/orchestrator-fsm-spec.md)` —
  the link target is wrong but the text is right; that's a separate
  documentation chore the overseer can file. Issue #5 is about consolidating
  the record-emitter contract, not fixing README links.
- Differentiating "provider not registered" vs "id not found in provider" —
  issue #6 frames both as the same gap (user sees `ModelNotFoundError`). One
  warning code is sufficient; if a future need for finer-grained diagnostics
  arises, it's an additive change.
- Moving the `provider:id` boundary into the SDK. Out of scope per
  `docs/archive/resolve-open-issues/phase-2-allow-multi-colon-model-ids.md`
  ("Does not move the `provider:id` boundary to the SDK").
- Changing the `ModelNotFoundError` message or surfacing a "did you mean…"
  hint. The existing message names the role and the full entry, which is
  enough to debug.
- Spec §13 textual changes. The new check is documented as a host-side
  addition, not a §13 extension. The spec's load-time check list remains
  the static structural rules it has always been.

## Telemetry (plan-time)

- `okf_docs_read`: 3 (`.okf/concepts/model-id-provider-colon-format.md`,
  `.okf/components/markdown-continuation.md`,
  `.okf/pitfalls/chunk-boundary-blockquote-loss.md`)
- `okf_tokens_read`: ~2.5K
- `files_scanned_before_okf`: 1 (directory listing of `.okf/`)
- `files_scanned_after_okf`: ~14 (spec, `record-emitter.ts`, `production-host-resolve.ts`,
  `validate.ts`, `manifest.ts`, `production-host.ts`, `production-host-factory.ts`,
  `start.ts`, `production-host.test.ts`, `record-emitter.test.ts`, `manifest.test.ts`,
  `phase-2-allow-multi-colon-model-ids.md`, `errors.ts`, README excerpt)
- `repo_scan_tokens_before_okf`: ~3K (initial directory tree)
- `repo_scan_tokens_after_okf`: ~25K (substantive reads)
- `stale_okf_hits`: 0
- `missing_okf_hits`: 1 — no `.okf/concepts/manifest-validation.md` exists
  yet (mentioned as a "future doc" in
  `.okf/concepts/model-id-provider-colon-format.md`); the host-side
  preflight check creates a clear new home for it. Logged as a
  `okf-curator` follow-on; not blocking this plan.

## Knowledge candidates (for `okf-curator` follow-on, not blocking)

- "Manifest validation contract boundary": `src/manifest/validateManifest`
  operates on `Manifest` data only; runtime availability checks against the
  `ModelRegistry` live in `src/host/manifest.ts:checkModelProvidersRegistered`.
  Stable architectural decision; useful for future planners who might be
  tempted to inject the registry into the validator.
- "Record-emitter contract scope": the durable JSONL log is the system of
  record; the in-process emitter is best-effort fan-out. The spec doc
  codifies this as the canonical contract surface; future consumers
  (upload extensions, observability hooks) have a stable reference.

## Phase index

- `phase-1-record-emitter-spec.md` — Issue #5 (trivial, doc-only)
- `phase-2-provider-preflight.md` — Issue #6 (architectural, host-side)
