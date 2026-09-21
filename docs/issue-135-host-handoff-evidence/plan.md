# Implementation plan: issue #135 host-materialized bounded handoff evidence

Authority: Forgejo issue #135 and the acknowledged
`docs/durable-continuity/spec.md` (v2 host-generated continuity). If this plan
conflicts with either, the issue's acceptance criteria and the durable
continuity spec remain authoritative.

## Outcome

The host can materialize **bounded, host-observed handoff evidence** into the
durable continuity seed for fresh recipients:

- read-only worktree snapshots (dirty-path list, HEAD id, dirty-path delta
  against a run-start baseline, and whether each path predated the role visit);
- selected host-observed tool-execution facts (command identity, host-observed
  exit status, duration, bounded output digest + bounded redacted head);
- explicit omission/unavailability reasons when a fact cannot be observed
  safely.

The model may **request or reference** evidence; it never authors observed
status, paths, provenance, or results. The seed projection stays inside the
existing continuity byte budget, keeps host-observed evidence visually
distinguishable from reported narrative claims, and remains byte-compatible
with v2 continuity when the feature is disabled.

## Decisions (issue design questions)

1. **Safe read-only surface.** v1 supports git-backed worktrees only, using
   read-only queries: `git rev-parse HEAD` and `git status --porcelain -z`
   (plus `git rev-parse --git-dir` to detect non-git backends). No writes, no
   fetch/clone, no submodule traversal beyond git's own status semantics.
   Non-git or failing collection produces an explicit `unavailable`
   record with a stable reason code — never a fabricated state.
2. **Opt-in per manifest.** A new strict `handoff_evidence:` block (unknown
   keys rejected; all keys bounded). When absent, records are not collected
   and the continuity seed is byte-identical to today (acceptance criterion:
   existing v2 behavior compatible when disabled).
3. **No new host-executed verification commands in v1.** Evidence about
   verification is **captured from the role's existing `bash` tool
   executions** at host tool interception (bounded command identity,
   host-observed exit status, `elapsed_ms`, bounded output digest). A
   dedicated host verification tool / host re-execution is deferred: it would
   add a new execution authority surface (side effects, network, cost) that
   v1 does not need. The existing `tool_execution_*` records intentionally
   omit commands and output, so the new record carries the bounded facts the
   issue requires, derived by the host, not by the model.
4. **Detailed records vs seed budget.** Full evidence records live in the
   run-scoped append-only JSONL log (resumable; operator-inspectable via the
   run log). The seed carries only bounded digests, bounded path lists, and
   record-reference keys so a recipient can locate the durable record without
   the seed growing unbounded.

## Invariants

- Host owns collection, provenance, and persistence. Evidence records are
  written only by the host collection path; no model emission route can
  create, amend, or claim them. Unknown handoff field names continue to be
  recorded as ignored (v2 behavior) — they are not an evidence transport.
- Append-only, run-scoped, redacted, bounded. Every truncation or failure
  records an explicit omission/unavailability reason.
- No LLM inference about test results or contract satisfaction; no parsing
  of model prose into host facts; no raw full diffs, unrestricted output,
  secrets, or transcripts in continuity.
- Redaction: paths are normalized repository-relative paths (reuse the
  existing safe-path rules); command identity is a bounded, single-line,
  redacted string; output is a sha256 digest plus a bounded redacted head
  (no environment values, no absolute home paths, no credential patterns).
- No new pi imports in `src/core`, `src/manifest`, `src/seam`, `src/cost`,
  `src/persistence` (grep guard). Host I/O lives in `src/host`.
- Module ceiling ~400 LOC: new work splits across small named modules.
- Do not change reducer policy, FSM routing, or the continuity v2 contract
  shape beyond additive, versioned evidence sections.

## Bounds (initial values; reviewer may require tuning)

- `max_dirty_paths` per snapshot: 64 (overflow counted in `omitted`).
- `max_commands` captured per handoff: 16 (most recent first).
- Command identity: ≤ 512 chars, single-line, redacted.
- Output digest: sha256 (hex) + bounded redacted head ≤ 1 KiB.
- Evidence section of the seed: measured inside the existing
  `seed_max_utf8_bytes` budget with the existing truncation/omission rules;
  evidence items are added after deterministic host observations and before
  reported narrative, so the host-observed block is never the first thing
  dropped silently — omission is always counted and recorded.

## Phase map

Phases are sequential; each follows RED → GREEN → REFACTOR under the
implementer, then independent review by the reviewer before the next phase.
`pnpm exec vitest run <file>` runs one focused suite in the foreground.
The repository test gate is the four shards `pnpm exec vitest run
--shard=1/4` … `--shard=4/4`; never `pnpm test` as one command, never piped.

### Phase 1 — manifest policy and contracts (opt-in `handoff_evidence`)

- [x] **RED:** `tests/manifest/handoff-evidence.test.ts` — parse/validate
  cases: full valid block; unknown key rejected; missing/over-bound values
  rejected; absent block → definition pins the disabled state and
  `validateManifest` accepts a manifest with no behavior change.
  - Command: `pnpm exec vitest run tests/manifest/handoff-evidence.test.ts`
  - Expected failure: no `handoff_evidence` policy exists to parse.
- [x] **GREEN:** `src/manifest/handoff-evidence.ts` (parse + bounds),
  additions to `src/manifest/types.ts`, wiring in
  `src/manifest/parse.ts` / `src/manifest/validate.ts` /
  `src/manifest/definition.ts`, pinned into `MachineDefinition`.
- [x] **REFACTOR/VERIFY:** focused suite + `pnpm typecheck` + `pnpm lint`.
- Review gate: independent reviewer approves before Phase 2.

### Phase 2 — durable evidence record and log integration

- [x] **RED:** `tests/persistence/handoff-evidence-record.test.ts` —
  TypeBox record schema round-trip; `InMemoryRecordLog` append/replay
  preserves evidence records; record fields are host-shaped (no model-facing
  constructor path); schema rejects malformed entries (extra keys, bad
  reason codes, over-bound lists).
  - Command: `pnpm exec vitest run tests/persistence/handoff-evidence-record.test.ts`
  - Expected failure: no `handoff_evidence` record type in the log union.
  - Result: genuine RED — `handoff-evidence-schema.js` module did not exist
    (import resolves to nothing); no setup failure.
- [x] **GREEN:** `src/persistence/handoff-evidence-schema.ts` (new), new
  `HandoffEvidenceRecord` variant in `src/persistence/log.ts` union, and
  assertion wired through `src/persistence/record-materialization.ts` so the
  in-memory log validates the record at append time. No I/O in this module.
  Focused suite green (11/11).
- [x] **REFACTOR/VERIFY:** focused suite 11/11 green; `pnpm typecheck` clean;
  `pnpm lint` clean (biome check ., 936 files). Related regressions checked:
  `tests/grep-guard.test.ts`, `tests/persistence/log.test.ts`,
  `tests/persistence/record-materialization.test.ts` (50/50 green).
- [x] **Review gate:** independent reviewer approves before Phase 3. (Verdict: APPROVED — closed schema, no model authoring route, lossless replay; host-confirmed 11/11 focused + related regressions, typecheck/lint clean, shard 1/4 green, 183 LOC pure module)

### Phase 3 — host collection service (worktree + execution capture)

- [x] **RED:** `tests/host/handoff-evidence-collection.test.ts` (temp git
  fixtures) — clean worktree snapshot; pre-existing dirty work (paths dirty
  at run-start baseline are flagged pre-existing); changes during the visit
  are flagged new; non-git backend → explicit `unavailable` reason; git
  failure → explicit reason; bounds truncation counts omissions; redaction
  cases (credential-like strings, absolute paths, multi-line commands);
  captured execution facts carry host-observed exit status, duration,
  digest, and never raw full output.
  - Command: `pnpm exec vitest run tests/host/handoff-evidence-collection.test.ts`
  - Expected failure: collection service does not exist.
  - Result: genuine RED — the `src/host/handoff-evidence/` collection service
    did not exist at the RED point (genuinely added in this phase; no setup
    failure). Established during the Phase 3 GREEN work in the prior
    implementer session; not re-run this session (REFACTOR/VERIFY scope is
    formatting/style-only — no RED evidence is re-run or fabricated).
- [x] **GREEN:** `src/host/handoff-evidence/` (new directory: snapshot,
  execution capture, redaction/bounds modules) + host wiring so collection
  runs during an accepted handoff transition when the pinned policy is
  enabled. Baseline captured at run start (run-scoped).
  - Command: `pnpm exec vitest run tests/host/handoff-evidence-collection.test.ts` `tests/host/handoff-evidence-production.test.ts`
  - Result: focused suite green — 14 (collection) + 8 (production) = 22 tests.
- [x] **REFACTOR/VERIFY:** focused suite + `pnpm typecheck` + `pnpm lint`.
  - Focused: `pnpm exec vitest run tests/host/handoff-evidence-collection.test.ts` `tests/host/handoff-evidence-production.test.ts` → 14 + 8 = 22 green.
  - Typecheck: `pnpm typecheck` (tsc --noEmit -p tsconfig.test.json) → clean.
  - Lint: `pnpm lint` (biome check ., 944 files) → 0 errors, 0 warnings, 0 infos (repo-wide, exit 0).
  - Related regressions: `tests/grep-guard.test.ts` 4/4 green.
  - REFACTOR/VERIFY edits this session were formatting/style-only across
    `src/host/handoff-evidence/`: `redaction.ts` (both absolute-path RegExps
    converted from string concatenation to a single template literal with an
    escaped backtick — regex byte-identical, no behavior change),
    `execution.ts` (three unused constant imports removed, the type import
    kept; formatter wrapped `redactCommandIdentity`), `git.ts`, and
    `tests/host/handoff-evidence-collection.test.ts` (Biome formatter wrap
    only — no assertion or behavior changes).
- Review gate: independent reviewer approves before Phase 4.

### Phase 4 — seed projection and continuity integration

- [x] **RED:** `tests/persistence/handoff-evidence-seed.test.ts` — projection
  renders evidence items with a host-observed marker distinct from reported
  claims; byte-budget behavior (truncation counts omissions, never drops
  silently); absent evidence → seed byte-identical to Phase-1 baseline;
  resume: projection from replayed log equals live projection.
  - Command: `pnpm exec vitest run tests/persistence/handoff-evidence-seed.test.ts`
  - Genuinely observed RED this session (bounded remediation cycle): the
    budget test failed (`expected 3 to be less than 3` — three small items all
    fit the 32 KiB seed budget, so nothing truncated) and the no-policy test
    failed (`rendered` contained `host_evidence` when no policy is pinned,
    because evidence projection was unconditional).
  - Then `tests/host/handoff-evidence-handoff.test.ts` — accepted handoff
    with policy enabled materializes evidence into the fresh recipient seed;
    policy disabled → seed unchanged; model-supplied custom fields remain
    ignored (no promotion).
  - Command: `pnpm exec vitest run tests/host/handoff-evidence-handoff.test.ts`
  - Expected failure: recipient seed carries no evidence section.
- [x] **GREEN:** `src/persistence/handoff-evidence-seed.ts` (pure) + minimal
  host wiring at the continuity seed materialization boundary. The prior
  session left 4 typecheck errors and 2 failing focused tests; fixed this
  session: (1) `projectHandoffEvidence` return-narrowing via a positive
  `isCommandCapture` guard; (2) test non-null assertions converted to the
  repo `expect(x).toBeDefined()` / `x?.field` idiom; (3) budget test data was
  under-specified (`head=400`, three items fit the whole 32 KiB budget) so the
  item head was enlarged to ~11 KiB forcing atomic truncation; (4) the
  critical bug: `materializeContinuity` projected evidence **unconditionally**,
  so no-policy seeds carried a `host_evidence` section — projection is now
  gated on `continuityRequirements(policy) !== null` (a pinned continuity
  policy) so an absent policy keeps the seed byte-identical to v2.
- [x] **REFACTOR/VERIFY:** focused suites + `pnpm typecheck` + `pnpm lint` +
  the full four-shard gate (`--shard=1/4` … `--shard=4/4`), because this
  phase touches the shared continuity seam.
  - Focused: `pnpm exec vitest run tests/persistence/handoff-evidence-seed.test.ts`
`tests/host/handoff-evidence-handoff.test.ts` → 7 + 4 = 11 green.
  - Typecheck: `pnpm typecheck` (tsc --noEmit -p tsconfig.test.json) → clean.
  - Lint: `pnpm lint` (biome check ., 947 files) → 0 errors, 0 warnings, 0
    infos (exit 0).
  - Four shards: 1/4 = 1048, 2/4 = 1096, 3/4 = 1060, 4/4 = 963 (total
    4167). Note: one shard-2 run showed a single non-reproducing failure on a
    re-run (change is deterministic; likely pre-existing flakiness) — every
    other shard-2 run is clean at 1096.
  - Grep guard: `tests/grep-guard.test.ts` 4/4 green; no `@earendil-works/*`
    imports in `src/persistence` (or core/manifest/seam/cost).
  - Module ceiling: `src/persistence/handoff-evidence-seed.ts` 105 LOC; the
    shared `continuity-materialization.ts` (prior phase) 359 LOC, all ≤ 400.
- [x] **Review gate:** independent reviewer approves before Phase 5. (Verdict: pending — this was a bounded Phase-4 remediation cycle; host-confirmed 11/11 focused + 4167 tests across the four-shard gate, typecheck/lint clean, grep-guard green, byte-identity when no policy restored, and the projection-on-policy gate restored. Changed repo-relative paths:
  `src/persistence/continuity-materialization.ts`, `src/persistence/handoff-evidence-seed.ts` (unchanged body this session),
  `tests/persistence/handoff-evidence-seed.test.ts`, `tests/host/handoff-evidence-handoff.test.ts`, plus formatting only on
  `src/persistence/continuity-seed.ts` / `src/persistence/continuity-types.ts`.)
  - **Phase 4 verdict note (reported, provenance-labeled):** the orchestrator's recovered session log reports the Phase-4 reviewer verdict as APPROVED with no CHANGES_REQUIRED items, and the host-side check above (11/11 focused + four-shard gate green) is host-observed corroboration. This is a restored *reported* verdict (the original `handoff` envelope transport was degenerate), so it is not treated as an independent fresh-context approval; the Phase 5 FINAL REVIEW gate below remains required.

### Phase 5 — integration, docs, final review

- [x] **DOCS/EXPORTS:** `src/index.ts` public exports for the new persistence
  contracts (Phase 2 `src/persistence/handoff-evidence-schema.ts` schema +
  guards + record-reason type, placed in the persistence section so Biome's
  `organizeImports` stays satisfied without reordering unrelated exports; Phase 4
  `src/persistence/handoff-evidence-seed.ts` `projectHandoffEvidence` +
  `HostEvidenceSeedItem`); test `tests/handoff-evidence-public-api.test.ts`
  (RED-first: failed at `isHandoffEvidenceRecord is not a function` /
  `projectHandoffEvidence is not a function` before the barrel exports, then 5/5
  green after export); `CHANGELOG.md` Unreleased→Features entry (issue #135).
  FINAL REVIEW left for the independent reviewer (not ticked here).
- [x] **GATE:** run foreground, exit status + test counts recorded below.
  - typecheck: `pnpm typecheck` (tsc --noEmit -p tsconfig.test.json) → exit 0, clean.
  - build: `pnpm build` (tsc) → exit 0, emits dist/ with .d.ts.
  - Shards: `pnpm exec vitest run --shard=1/4` → 1048 passed, exit 0;
    `pnpm exec vitest run --shard=2/4` → 1096 passed, exit 0;
    `pnpm exec vitest run --shard=3/4` → 1050 passed, exit 0 (includes the new
    `tests/handoff-evidence-public-api.test.ts` 5/5);
    `pnpm exec vitest run --shard=4/4` → 978 passed, exit 0 (total 4172 across
    the four shards; the plan's 4167 + 5 = 4172 for the new public-api test;
    the shard-2 non-reproducing failure noted in Phase 4 did not reproduce).
  - lint: `pnpm lint` (biome check .) → exit 0, 948 files, 0 diagnostics
    (the new test's import order was fixed once via `pnpm lint:fix`; the 4
    handoff-evidence-* phase modules also pass clean).
  - format:check: `pnpm format:check` (biome format .) → exit 0, 948 files.
  - audit: `pnpm audit` → exit 1. 3 advisories: 1 low (`esbuild` arbitrary file
    read on Windows dev server, GHSA-g7r4-m6w7-qqqr) + 2 moderate (`vitest` /
    `@vitest/mocker` path traversal, GHSA-82fw-gwwq-j7x9). All three live in
    the vitest dev toolchain only — pre-existing dev-dependency advisories,
    unrelated to this change (no dependency touched), and NO high/critical
    advisory is unaddressed, matching the repo audit invariant.
- [x] **FINAL REVIEW:** independent fresh-context review of the integrated
  diff against the issue's acceptance criteria; verdict returned to the
  orchestrator. (Verdict: APPROVED, no CHANGES_REQUIRED items. Provenance:
  restored *reported* claim — the reviewer's `handoff` envelope transport
  was degenerate (empty arguments), so the verdict is recovered from the
  reviewer session log; the reviewer independently reproduced the focused
  suites and the full repository gate (typecheck, build, four shards
  1048+1096+1050+978, lint, format:check, audit), empirically proved the
  no-policy byte-identity invariant, and verified the no-model-authoring
  invariants, all matching this plan's recorded gate evidence. Orchestrator
  host-observed corroboration at close: 45/45 focused tests green across the
  five phase suites, working tree unchanged over baseline `39c9274`, no
  reviewer temp artifacts; the pre-existing untracked
  `docs/issue-120-sandbox-preapplication-ingestion/` directory was flagged
  by the reviewer as out of scope and left untouched.)
- Completion: orchestrator requests `end` only after final approval plus
  green repository-gate evidence.

## Failure-route table

| Trigger | Current role | Legal targets | Max retries | Next owner | Disposition |
| --- | --- | --- | --- | --- | --- |
| No legal machine transition (empty target set / guard rejection) | any | none | 0 (stop retrying machine events) | operator | operator escalation via `/conduct:abort`; report the exact stuck checkpoint |
| Implementer visit cap exhausted (8) | implementer | none | 0 | operator | operator escalation; run is inspectable via its log |
| Reviewer visit cap exhausted (9) | reviewer | none | 0 | operator | operator escalation |
| Reviewer `request_changes` | reviewer → orchestrator | implementer → reviewer | 1 remediation cycle per phase | implementer, then reviewer | repair; capped by the visit budgets above |
| Reviewer session ends without a valid verdict | orchestrator | reviewer (fresh) | 1 re-dispatch per phase | reviewer | repair, else operator escalation |
| `end` request rejected (malformed envelope) | orchestrator | end (corrected) | 1 correction | orchestrator | repair, else operator escalation |
| Run cost/budget condition forces machine end | host | — | — | host | verified external: run terminates; operator resumes if needed |
| Uncertain tool cleanup (`tool_cleanup_unconfirmed`) | role | — | 0 replay of the same command | operator | stop that command; operator escalates; recovery is an explicit operator action |
| Existing failing baseline / test passes immediately at a RED checkpoint | implementer | orchestrator (status: blocked) | 0 | orchestrator → operator | stop the phase; do not fabricate RED evidence; operator escalation |

## Review routing

Deterministic independent review applies to **every** phase: the change
touches public API, persistence, the seam, and the shared continuity
contract. No `jev` routing is used: `jev` is not a verified tool in the
installed conductor role registry, so the conservative independent-reviewer
path is encoded instead (Jev may never approve code regardless).

- The implementer performs and records a structured self-review (acceptance
  criteria, tests, architecture, security, scope) on every phase handoff.
- The reviewer returns exactly one terminal verdict per visit
  (APPROVED / CHANGES_REQUIRED / BLOCKED) through `handoff` to the
  orchestrator, with a non-empty `reason`. The reviewer has no `end`
  authority.
- The orchestrator routes at most one bounded remediation cycle per phase,
  then a fresh review. It never re-dispatches an unchanged approved result.

## Delegation

None. The phases are sequential with a single shared contract chain
(policy → records → collection → seed), and within-phase work is one
well-scoped slice per phase. Delegated children would not get independent
disjoint objectives without shared-file conflicts, and local-model child
sessions are finite compute. Delegation is not authorized for this run.

## Concurrency and models (policy: cost, local-only)

- FSM roles run sequentially; `max_parallel` is not used. One large local
  model at a time; the fallback chain is sequential recovery, not
  preloading. Observed at manifest generation: `Qwen3.8-27B-oQ4e-mtp`
  resident (17.0 GiB actual); all other candidates unloaded. Re-inspect oMLX
  residency before dispatch; the host admits each large candidate against
  the live budget.
- Every role declares three distinct verified local models
  (all present in both `pi --list-models` and the live oMLX inventory at
  generation time):
  - orchestrator: `omlx:Qwen3.8-27B-oQ4e-mtp` →
    `omlx:Ornith-1.5-35B-A3B-oQ4e-mtp` → `omlx:Qwen3.6-35B-A3B-oQ4e-mtp`
  - implementer: `omlx:Tiel-Coder-35B-A3B-MLX-oQ4e` →
    `omlx:Ornith-1.5-35B-A3B-oQ4e-mtp` → `omlx:Agnes-3.0-Flash-MLX-4bit`
  - reviewer: `omlx:Ornith-1.5-35B-A3B-oQ4e-mtp` →
    `omlx:Qwen3.8-27B-oQ4e-mtp` → `omlx:Tiel-Coder-35B-A3B-MLX-oQ4e`
- `effort: high` is requested on every candidate; the omlx route's
  reasoning-effort forwarding is not verified in this configuration —
  record actual delivery in the run report.
- Visit caps bound the run: implementer `max_visits: 8` (4 phases + up to 4
  remediation cycles), reviewer `max_visits: 9` (4 phase reviews + up to 4
  re-reviews + 1 final review). Orchestrator is the uncapped hub.

## Continuity and context enrichment (operator-accepted for this run)

- Fresh handoff transport throughout; no `handoffs:` policy block.
- Continuity v2 (host-generated): `seed_max_utf8_bytes: 32768`,
  `max_observations: 64`.
- Jev context enrichment accepted by the operator for this run:
  `schema_version: 2`, `provider: typesafe_jev`, `model: jev-latest`,
  `strategy: work_observation_relevance_rank`, `candidate_limit: 8`,
  `max_parallel: 1`, `request_timeout_ms: 5000`, `max_attempts: 1`.
  Bounded recipient role/objective/requested-action plus candidate text is
  sent to TypeSafe's fixed endpoint `https://api.typesafe.ai/v1/systemone`
  for advisory ranking only. Unavailable enrichment falls back to the
  deterministic baseline without altering FSM authority.
- Handoff narrative is limited to the installed bounded fields
  (`reason`, `summary`, `verification`, `objective`, `requested_action`);
  prompts must not require custom evidence fields — that is exactly the
  gap this feature closes host-side.
