# Durable continuity ledger implementation plan

Status: **Acknowledged by overseer on 2026-09-18; Gate 0 satisfied. Implementation and dispatch are authorized against the pinned revision.**

Spec: `docs/durable-continuity/spec.md`

This plan optimizes elapsed implementation time by fixing shared contracts
first, then dispatching three disjoint delegated lanes concurrently. The spec
acknowledgement gate below has been satisfied by the overseer; `/conduct` may
now be invoked against the pinned revision.

## Gate 0 — overseer acknowledgement

- [x] Overseer acknowledges `docs/durable-continuity/spec.md`.
- [x] Requested spec changes, if any, are incorporated and re-acknowledged.
- [x] The implementation lead confirms the acknowledged revision/commit in the
      run record before changing implementation code.

**Stop condition:** no implementation, delegation, or conductor run before all
Gate 0 boxes are checked.

## Phase 1 — shared contract baseline (implementation lead, sequential)

The implementation lead owns this phase because all delegated lanes depend on
its exact public contract. Commit the phase before delegation so every child
starts from one immutable base commit.

### Tasks

- [x] Add the continuity manifest policy and strict parser/static validation.
- [x] Define the TypeBox `ContinuityPacketV1`, item, and `EvidenceRef` schemas;
      derive TypeScript types with `Static<>`.
- [x] Add pure normalization, UTF-8 measurement, ID, supersession, and packet
      validation contracts with stable diagnostics.
- [x] Define versioned envelope, evidence-resolution, ledger, and bounded-seed
      types.
- [x] Define a narrow pure materializer API consumed by host and CLI lanes.
- [x] Add focused red tests for shared contracts, then make them green.
- [x] Confirm no pi imports entered pure layers.
- [x] Commit the shared baseline and record the commit in the parent packet.

### Acceptance

- [x] Omitted continuity policy is backward-compatible.
- [x] The exact v1 schema and bounds in the spec have one runtime source of
      truth.
- [x] Reachable `minimal` children are rejected only when delegated continuity
      is required.
- [x] All three lanes can code against named, committed interfaces without
      editing the same production files.

### Verification

```text
pnpm vitest run <focused shared-contract test files>
pnpm typecheck
pnpm lint
```

## Phase 2 — concurrent delegated implementation

Dispatch exactly one batch of the three tasks below after Phase 1 is committed.
Use fresh context, `cleanup: delete`, exact projection paths, and the committed
baseline SHA. Children return `report_result` with a valid continuity packet.
They do not commit, integrate, or edit `.okf/`.

### Lane A — FSM handoff transport and fresh-role seed

Owned behavior:

- [x] Extend handoff seam validation with optional/required continuity.
- [x] Resolve run-local handoff evidence and persist packet/resolutions through
      the accepted-handoff record.
- [x] Reject malformed required packets before reducer invocation.
- [x] Materialize and inject the bounded continuity seed into fresh FSM role run
      memory without duplicating raw packet content.
- [x] Preserve legacy accepted handoff behavior.
- [x] Add focused handoff, restart, and run-memory tests.

Must not edit delegated-child, CLI, manifest-contract, or OKF files.

### Lane B — delegated-child completion

**Disposition:** The original DC-CHILD attempts
(`5244a451`, `6c995dc5`, `55d4cdbf`, `0b34662a`, `1e71f18a`) returned no
accepted write; the parent takeover was recorded honestly at that point.
After the later review blocker, one narrow authorized child run
(`f4ab4aac-6e7b-4ac5-8bac-9080a6af34e3`) dispatched child `ecf36bf0`
(`child-continuity-worker`, `minimax:MiniMax-M3`) against the clean head. The
child made one substantive test contribution covering child-produced packet
evidence under delegated authority. The parent inspected the diff and found
that its fixtures mirrored authority logic and omitted terminal settlement;
the parent refactored the contribution to use production
`recordBackedContinuityAuthority` and real durable execution records, adding
orphan, unfinished, duplicate-start, wrong-task, sibling, and cross-run
regressions. The parent validation is committed at `3f3246c`; do not
attribute the parent fixture refactor to the child.

Parent-takeover behavior:

- [x] Extend `report_result` and child result mapping with optional continuity.
- [x] Enforce required delegated continuity for successful results.
- [x] Bind child provenance from host-owned task/observation state.
- [x] Resolve evidence only within the uniquely granted child/task authority.
- [x] Persist packet/resolutions in existing durable child terminal/completion
      records and reconstruct them through a reopened production log.
- [x] Route invalid required packets to the existing bounded protocol-failure
      path.
- [x] Preserve optional and legacy/minimal behavior.
- [x] Add focused observation, mapping, persistence, authority, and restart tests.

The takeover does not edit FSM handoff, CLI, manifest-contract, or OKF files.

### Lane C — ledger materializer, renderer, and read-only CLI

Owned behavior:

- [x] Implement the pure chronological ledger fold and explicit supersession.
- [x] Implement deterministic bounded seed selection and omission counts.
- [x] Implement JSON, escaped Markdown, and verified OKF-candidate renderers.
- [x] Add `conduct continuity-report` using the production log reader.
- [x] Fail closed on malformed/unsupported historical records.
- [x] Add focused materializer and CLI tests, including byte-identical replay.

Must not edit handoff transport, delegated-child integration,
manifest-contract, or `.okf/` files.

### Child completion requirements

Each child report must include:

- changed paths;
- tests written and commands run;
- exact outcomes and unresolved failures;
- implementation assumptions;
- security/compatibility concerns;
- a valid continuity packet with evidence references;
- a declaration that no commits and no `.okf/` edits were made.

The parent validates claims against the child workspace and durable evidence.
Child self-report is not sufficient proof.

## Phase 3 — parent integration and cross-lane wiring

- [x] Validate all three child results and continuity packets.
- [x] Inspect child workspace diffs before applying any patch.
- [x] Apply lanes in order: C pure materializer, A handoff, B child completion.
- [x] Resolve interface mismatches centrally; do not ask concurrent children to
      rewrite shared contracts after the batch.
- [x] Add cross-lane evidence resolvers and production dependency wiring.
- [x] Ensure run-memory and child prompts explain continuity semantics and
      prohibit hidden reasoning/secrets.
- [x] Update public barrels/JSDoc and user-facing documentation.
- [x] Add an end-to-end restart test covering one handoff plus one child result.
- [x] Add a public compatibility test for a legacy record stream.
- [x] Commit the integrated implementation before review.

## Phase 4 — independent review

**Current disposition: independently approved.** A direct independent review at
the pre-remediation head `17b129560af988be70dfd00779faa153ee84218a` returned
`request_changes` for duplicate/malformed pinned snapshots, legacy parentless
child starts, role-visit evidence scope, repository resolution, and stable
required-child-packet diagnostics. Those findings are addressed in follow-up
commits `728a439270a2a5980df1efc8876aae7b9971d3e3`, `15e3fa6`, and `3fdb605`.
A fresh read-only review of clean implementation HEAD `3a89948` returned
`APPROVE`; the documentation closure head is `f144954`. Its verification and
the final report are recorded below.

An independent reviewer receives the acknowledged spec, plan, integration
commit, focused test evidence, and diff inventory. The reviewer does not modify
code.

Review axes:

- [x] spec conformance and scope discipline;
- [x] reducer purity and host/core boundaries;
- [x] TypeBox single-schema discipline;
- [x] append-only durability and restart behavior;
- [x] evidence authority, provenance spoofing, and cross-run denial;
- [x] UTF-8/item/seed bounds and adversarial input;
- [x] legacy manifest/record/minimal-child compatibility;
- [x] deterministic rendering and Markdown safety;
- [x] tests, docs, and public API quality;
- [x] no runtime `.okf/` mutation.

The reviewer returns `approve` or `request_changes` with concrete file/line or
contract evidence. The implementation lead resolves all blocking findings and
records dispositions before the full gate.

## Phase 5 — full verification

The previous gate evidence was stale and shard 3 exposed an unhandled Vitest
worker RPC timeout even though its assertions passed. The packed cleanup probe
is now split into separate test files so no single file exceeds Birpc's fixed
60-second task-update timeout. Record only exact current-head results below.
The full suite below is the authoritative gate for `3fdb605`; the affected
shards were also rerun at that commit.

- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] `pnpm lint`
- [x] `pnpm format:check`
- [x] `git diff --check`
- [x] `pnpm test` at `3fdb605`: 358 files and 3,687 tests passed; explicit exit 0 and no unhandled errors.
- [x] standalone shard evidence: the six-shard sequence at `728a439` recorded exit 0 for shards 1, 2, 4, and 5; shards 3 and 6 passed on their explicit individual reruns. The affected shards were rerun again at `3fdb605`: `--shard=3/6` (60 files; 480 tests; exit 0) and `--shard=6/6` (58 files; 649 tests; exit 0). The initial sequence exposed one artifact-store test flake in shard 3 and one supervised-process cleanup-timing flake in shard 6; neither reproduced on its recorded individual rerun. No shard reported an unhandled error after the packed-test split.
- [x] `pnpm audit --audit-level high` (no high/critical advisories; 1 low and 2 moderate reported)
- [ ] inspect `git status --short` and final diff inventory after this plan update
- [x] reconcile the pre-fix shard-3 `Timeout calling "onTaskUpdate"` and the two post-fix one-off test flakes as inconclusive; the final full suite and individual shard reruns completed with exit 0.
- [x] update only completed checkboxes in this plan

Long suites stream output. No `tail` pipeline may hide the running process or
exit status. Partial shards are never described as the full gate.

## Phase 6 — final report and optional curation

- [x] Produce `docs/durable-continuity/report.md` with run ID, manifest path,
      pinned base SHA, child IDs, model/provider routing, lane inventory,
      integration commits, reviewer disposition, and exact verification
      outcomes.
- [x] Render `continuity-report --format okf-candidates` for remediation run `f4ab4aac-6e7b-4ac5-8bac-9080a6af34e3`; the read-only output is `{"candidates":[],...}` with no candidates.
- [x] Give the empty candidate set to the independent reviewer for selective
      review; no candidate required promotion.
- [x] Record the curator no-op in the final report; child/task-log content was
      not promoted wholesale and `.okf/` was not mutated.
- [ ] Present the final implementation to the overseer for end-of-loop review.

## Planned commit sequence

1. `feat: define durable continuity contracts`
2. `feat: persist continuity across handoffs and children`
3. `feat: add continuity ledger reporting`
4. `docs: document durable continuity operations`
5. Any review fixes as narrowly scoped follow-up commits

The implementation lead may split commits more finely if that improves review,
but must not squash away provenance needed to audit delegated integration.

## Rollback

The feature is opt-in. A regression can be contained by omitting `continuity`
from manifests while retaining additive record readers. Do not remove readers
for already-written v1 records. A code rollback must preserve the ability to
read accepted legacy and v1 records or ship an explicit migration first.
