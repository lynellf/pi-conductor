# Implementation plan: opt-in Jev recipient-context ranking

Status: **Specification approved; implementation is parent-owned at the corrective cycle, with final approval still blocked by missing genuine delegated-lane evidence and the repaired run's review transition.**

Run policy: **speed**. The topology fixes shared contracts first, then dispatches
two disjoint implementation lanes concurrently. Fresh FSM handoffs remain the
transport; the task manifest declares no `handoffs:` policy.

## Gate 0 — specification acknowledgement

- [x] Overseer acknowledges `docs/jev-context-ranking/spec.md` or requests revisions.
- [x] Requested changes are incorporated and the final revision is acknowledged (approved as written; no revisions requested).
- [x] Implementation lead records a clean full base SHA containing the acknowledged spec, this plan, manifest, and prompts.

**Stop:** no production edits, delegation, or `/conduct` run before Gate 0 is complete.

## Architecture decisions

- Enrichment is an optional host-side I/O step after accepted transition durability and before recipient prompt delivery.
- The existing continuity ledger is the only candidate source.
- Shared contracts use one strict TypeBox boundary and provider-neutral result types; v1 has one fixed-origin TypeSafe adapter.
- Ranking preserves deterministic section priority, never filters, and falls back atomically to the exact baseline.
- Completed/unavailable results are append-only and resume-authoritative.
- Direct HTTP avoids a new dependency; adding the SDK requires separate approval.

## Phase 1 — shared contract baseline (implementation lead, sequential)

The lead writes failing focused tests first, then commits a compile-clean shared
contract before delegation.

### Task 1: Manifest policy and boundary schemas

- [x] Add strict `context_enrichment` types, parser, and static validation.
- [x] Add TypeBox schemas/types for Score answers, durable judgments, and terminal enrichment records.
- [x] Add stable diagnostics, hard bounds, and omission compatibility tests.
- [x] Reject enrichment without continuity and unknown/missing fields.

**Likely files:**

- `src/manifest/types.ts`
- `src/manifest/parse.ts`
- `src/manifest/validate.ts`
- new `src/manifest/context-enrichment.ts`
- new `src/seam/context-enrichment.ts`
- `tests/manifest/continuity.test.ts`
- new `tests/manifest/context-enrichment.test.ts`
- new `tests/seam/context-enrichment.test.ts`

**Verify:** focused manifest/seam tests, `pnpm typecheck`, `pnpm lint`.

### Task 2: Durable identities and provider-neutral contracts

- [x] Define transition/input fingerprints and the strict completed/unavailable record.
- [x] Add additive record union/materialization support and duplicate/conflict checks.
- [x] Define provider-neutral `ContextEnricher` request/outcome contracts.
- [x] Define optional ranking input on `renderContinuitySeed` while preserving the two-argument baseline byte-for-byte.
- [x] Create and track compile-clean lane source/test files required by exact delegated projections.

**Likely files:**

- new `src/persistence/context-enrichment.ts`
- `src/persistence/log.ts`
- `src/persistence/record-materialization.ts`
- `src/persistence/continuity-types.ts`
- new `src/persistence/continuity-ranking.ts`
- new `src/host/context-enrichment/contracts.ts`
- new `src/host/context-enrichment/typesafe-client.ts`
- new `tests/persistence/context-enrichment-records.test.ts`
- new `tests/persistence/context-enrichment-ranking.test.ts`
- new `tests/host/context-enrichment-typesafe.test.ts`

**Verify:** focused persistence tests, `pnpm typecheck`, `pnpm lint`.

### Checkpoint A — delegation closure

- [x] Shared names/signatures are committed and immutable for the child batch.
- [x] Both child source/test paths are tracked at the same clean baseline.
- [x] Exact child projections exist in the materialized parent workspace.
- [x] No child needs sibling output or an unresolved design decision.
- [x] Grep guard confirms no Pi import entered pure layers.

## Phase 2 — mandatory concurrent delegated lanes

The implementation lead submits one blocking two-task batch after Checkpoint A.
Use exact `projection_paths`, the same baseline commit, `cleanup: delete`, and
`report_result`. Children have no shell authority; the parent runs all commands.

### JCR-CLIENT — `typesafe-client-worker` (corrective cycle: parent-owned)

> **Corrective-cycle attribution note.** The original lane
> commit (892d3c7) is parent-owned per the prior cycle's
> request_changes finding. The corrective cycle is parent-owned
> as well (delegate tool remains unavailable) and ships as its own
> commit set; it is NOT a retroactive authorship claim on the
> original lane commit.

**Objective:** implement the fixed-origin TypeSafe HTTP adapter and focused tests.

**Write ownership:**

- `src/host/context-enrichment/typesafe-client.ts`
- `tests/host/context-enrichment-typesafe.test.ts`

**Read-only contract/context:**

- `AGENTS.md`
- `docs/jev-context-ranking/spec.md`
- `docs/jev-context-ranking/plan.md`
- `src/host/context-enrichment/contracts.ts`
- `src/seam/context-enrichment.ts`
- `src/manifest/context-enrichment.ts`
- `src/persistence/context-enrichment.ts`
- `src/manifest/types.ts`
- `src/persistence/log.ts`

**Acceptance:** exact request/rubric, fixed official origin, one candidate per
request, bounded concurrency/retries/timeouts, strict response validation,
aggregate usage, atomic unavailable outcome, and secret-safe diagnostics.

**Verification owner:** parent runs
`pnpm vitest run tests/host/context-enrichment-typesafe.test.ts`.

### JCR-RANK — `continuity-ranking-worker` (corrective cycle: parent-owned)

> **Corrective-cycle attribution note.** The original lane commits
> (7ed7b77, 3cbbe56) are parent-owned per the prior cycle's
> request_changes finding. The corrective cycle is parent-owned as
> well (delegate tool remains unavailable) and ships as its own
> commit set; it is NOT a retroactive authorship claim on the
> original lane commits.

**Objective:** implement pure candidate projection, within-section ranking,
annotation, and byte-stable baseline behavior.

**Write ownership:**

- `src/persistence/continuity-ranking.ts`
- `src/persistence/continuity-seed.ts`
- `tests/persistence/context-enrichment-ranking.test.ts`
- `tests/persistence/continuity-materialization-order.test.ts`
- `tests/persistence/continuity-materialization-truncation.test.ts`

**Read-only contract/context:**

- `AGENTS.md`
- `docs/durable-continuity/spec.md`
- `docs/jev-context-ranking/spec.md`
- `docs/jev-context-ranking/plan.md`
- `src/seam/continuity.ts`
- `src/seam/context-enrichment.ts`
- `src/persistence/context-enrichment.ts`
- `src/persistence/continuity-types.ts`
- `src/persistence/continuity-materialization.ts`

**Acceptance:** stable candidate identities, deterministic prefix, prohibited
outbound fields absent, fixed section order, stable score ties, unscored suffix,
host wrapper semantics, atomic byte truncation, and byte-identical disabled/
unavailable output.

**Verification owner:** parent runs the focused persistence test files above.

### Checkpoint B — child reconciliation

- [ ] Both task/result identities and effective projections are recorded.
- [ ] Every changed path is within declared child ownership.
- [ ] Child claims are checked against diffs; reports are not treated as proof.
- [ ] Accepted child patches are integrated in dependency order.
- [ ] Focused child-lane tests pass after each integration.
- [x] Any parent takeover has prior overseer authorization and explicit attribution.

> **Process note.** No genuine child task/result records exist in the
> current conductor run. The corrective implementation is explicitly
> parent-owned because delegation was unavailable; it makes no retroactive
> authorship claim on the original lane commits. Checkpoint B remains open
> until a capable runtime records substantive child contributions.

## Phase 3 — host integration and resume (implementation lead, sequential)

### Task 3: Production preparation and loop ordering

- [x] Implement host preparation over the pinned policy and accepted transition.
- [x] Read `TYPESAFE_API_KEY` only at the production boundary.
- [x] Persist completed/unavailable before recipient prompt delivery.
- [x] Await preparation from `loop-session-accepted` without changing reducer order.
- [x] Materialize ranked seeds only from durable matching records.

**Likely files:**

- new `src/host/context-enrichment/prepare.ts`
- `src/host/host.ts`
- `src/host/loop-types.ts`
- `src/host/loop-session-accepted.ts`
- `src/host/production-host.ts`
- `src/host/production-host-state.ts`
- `src/host/production-host-options.ts`
- `src/host/production-host-factory.ts`

**Verify:** focused loop/production-host tests and reducer call-count assertions.

### Task 4: Restart, compatibility, and public wiring

- [x] Reuse matching terminal records on resume with zero extra API calls.
- [x] Permit retry only when a simulated crash left no terminal record.
- [x] Fail closed on stale fingerprint, duplicate terminal, malformed, or unsupported records.
- [x] Preserve trajectory selector, artifact, legacy handoff, and no-policy paths.
- [x] Add public exports/JSDoc only where existing package policy requires them.
- [x] Document external disclosure, credentials, observability, rollout, and rollback.

**Likely files:**

- `src/host/api.ts`
- `src/host/api-resume-state.ts`
- `src/index.ts`
- new `tests/host/context-enrichment-loop.test.ts`
- new `tests/host/context-enrichment-resume.test.ts`
- `tests/host/continuity-host-seed-restart.test.ts`
- `README.md` or a narrow operator document selected during implementation

**Verify:** focused host/restart/compatibility tests, `pnpm typecheck`, `pnpm build`.

### Checkpoint C — end-to-end behavior

- [x] Stub TypeSafe E2E proves accepted transition → durable ranking → ranked recipient seed.
- [x] One candidate failure proves one unavailable record and exact baseline seed.
- [x] Restart after completed and unavailable records makes no API call.
- [x] Captured outbound states contain none of the prohibited fields.
- [x] Reducer/checkpoint/visit behavior matches a no-enrichment control run.

## Phase 4 — independent review

The reviewer receives the acknowledged spec, baseline/integration commits, full
diff, child records, focused evidence, and complete gate results. It remains
read-only and checks:

- opt-in and exact baseline compatibility;
- TypeSafe API/rubric conformance;
- semantic separation of relevance, ranking certainty, and finding confidence;
- transition/input identity, append ordering, duplicate handling, and resume;
- candidate completeness, section priority, ties, and byte accounting;
- fixed-origin credential/privacy/prompt-injection boundaries;
- atomic failure and safe diagnostics;
- reducer/core boundaries and no dependency addition;
- substantive child contributions and parent integration mapping; and
- exact verification evidence.

- [x] Reviewer returns `approve` or bounded `request_changes` with evidence.
- [x] Implementation lead resolves every blocking finding and reruns affected gates.
- [ ] Reviewer approves the final integrated revision.

> **Corrective cycle review note.** The original Phase 4 cycle
> returned `request_changes` (six P0/P1/P2 findings). The parent-owned
> corrective cycle addresses the code findings, but Checkpoint B and the
> missing child-lane evidence remain open; a reviewer must re-validate
> the revised HEAD before approval.

## Phase 5 — complete repository gates

- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] `pnpm lint`
- [x] `pnpm format:check`
- [x] `git diff --check`
- [x] `pnpm test` or complete deterministic shard union
- [x] `pnpm audit --audit-level high`
- [x] `git status --short` and final diff inventory inspected

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Ranking certainty is mistaken for truth | Distinct names, host wrapper, tests, and reviewer axis. |
| External data disclosure is broader than intended | Minimal state builder with captured-request negative assertions and fixed origin. |
| One flaky request discards useful rankings | Explicit all-or-nothing baseline fallback; measure unavailability before considering partial ranking. |
| Resume reranks and changes context | Durable transition/input fingerprints and terminal-record reuse. |
| Ranking disrupts critical ordering | Fixed section priorities; only within-section movement; no filtering. |
| Annotations consume seed budget | Exact byte accounting and rollout measurement; baseline remains available by omission. |
| Direct HTTP drifts from API | Strict TypeBox response checks and official-doc review before implementation. |
| New logic bloats large files | New single-purpose modules; integration modules only delegate. |

## Planned commit sequence

1. `feat: define context enrichment contracts`
2. `feat: add typesafe relevance ranking primitives`
3. `feat: persist ranked recipient context`
4. `test: cover context enrichment restart boundaries`
5. `docs: document opt-in context enrichment`
6. Narrow review fixes as separate commits

## No-run reminder

The manifest and prompts document the originally approved topology. The
implementation and corrective cycle were authorized by the overseer; this run
must not be represented as having child-lane evidence that it does not contain.
