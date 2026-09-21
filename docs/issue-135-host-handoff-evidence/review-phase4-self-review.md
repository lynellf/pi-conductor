# Phase 4 self-review — issue #135 host-observed handoff evidence (bounded remediation cycle)

**Reviewer:** independent reviewer (fresh context). **Self-reviewer:** implementer (Tiel-Coder variant).
**Cycle:** Phase 4 bounded remediation cycle routed back after the initial Phase-4 GREEN
regressed two invariants. This is one of the permitted `request_changes` remediation
cycles (plan Failure-route table).

---

## 1. Acceptance criteria (each mapped to evidence)

| Phase-4 criterion (plan RED) | Status | Evidence |
|---|---|---|
| Projection renders host-observed items with a marker distinct from reported claims | ✅ | `tests/persistence/handoff-evidence-seed.test.ts` "projects each record…" asserts `kind === "host_evidence"` and `"confidence" in item` / `"statement" in item` are both false (finding vs host-fact distinction). |
| Byte-budget truncation counts omissions, never drops silently | ✅ | "renders evidence items atomically and counts every dropped item in omissions" — 3 × ~13.7 KiB items exceed the 32 KiB budget; asserts `admitted < items.length`, `admitted + seed.omitted.items === items.length`, and `rendered` contains `host_evidence`. |
| Absent evidence → seed byte-identical to Phase-1 (v2) baseline | ✅ | `tests/host/handoff-evidence-handoff.test.ts` "leaves the seed byte-identical to the v2 baseline when no policy is pinned": `rendered` not contains `host_evidence` and `"host_evidence" in seed.sections` is `false`. |
| Resume: projection from replayed log equals live projection | ✅ | "projection from a replayed log equals the live projection" — re-projecting an identical list is a no-op change. |
| Accepted handoff, policy enabled → evidence materialized into recipient seed | ✅ | "materializes host-observed evidence into the seed when the policy is enabled" (handoff test 1). |
| Policy disabled → seed unchanged | ✅ | handoff test 2 (above). |
| Model-supplied custom fields never promoted into host evidence | ✅ | "ignores model-supplied custom fields (no promotion into host evidence)" (handoff test 3): a `handoff_evidence` field inside the continuity payload is ignored because it is not a `handoff_evidence` **record type**. |

## 2. Tests

- Focused: `pnpm exec vitest run tests/persistence/handoff-evidence-seed.test.ts` `tests/host/handoff-evidence-handoff.test.ts` → **11/11** (7 + 4).
- Genuinely observed RED this session before fixing (retained, not re-fabricated):
  - Budget test: `expected 3 to be less than 3` — the prior-session test data (`output_head` 400 B) fit entirely inside the 32 KiB budget, so nothing truncated.
  - No-policy test: `rendered` contained `host_evidence` when no continuity policy was pinned.
- NOT run / not fabricated this session: the initial-phase RED (module already existed; prior session's RED is documented in the plan and left untouched).

## 3. Architecture

- `src/persistence/handoff-evidence-seed.ts` (105 LOC ≤ 400): pure, no I/O, `projectHandoffEvidence(records, runId)`. Exposes NO model-facing constructor path — only host-produced `HandoffEvidenceRecord`s flow in. `CommandCapture` narrowing uses a positive `isCommandCapture` type guard (the prior negated `!isUnavailable` filter did not narrow the array element type under strict TS, which was the source of the 2 remaining typecheck errors).
- Wiring is at the single materialization boundary only: `src/persistence/continuity-materialization.ts` now calls `projectHandoffEvidence(records, policy.run_id)` **only when `continuityRequirements(policy) !== null`** (i.e. a continuity policy is pinned). This is the precise "policy active" signal — `ContinuityPolicyV1` always carries required `require_handoff`/`require_delegated_result`, so `requirements !== null` exactly when the host's own `isLegacyContinuityPolicy` gate admits a seed. No reducer/FSM/continuity-v2 contract change.
- `continuity-seed.ts` / `continuity-types.ts` changes this session are formatting-only (Biome); the conditional `omitHostEvidence`/`freeze` logic (from the prior session) remains and correctly suppresses the `host_evidence` key when empty, preserving byte-identity.

## 4. Security / invariants

- **No model authoring:** records are built by the host collection path only; the model can never emit a `handoff_evidence` record. Confirmed: a model-supplied `handoff_evidence` payload field is ignored (not promoted).
- **No silent fallbacks / fabrication:** unobservable facts are explicit `unavailable` markers in the record (Phase 3); the seed projection never guesses a state.
- **Read-only host surface:** unchanged from Phase 3 (`git rev-parse`/`git status --porcelain -z` only).
- **Grep guard green (host-observed):** no `@earendil-works/pi-coding-agent` imports in `src/persistence` (or `core/manifest/seam/cost`); `tests/grep-guard.test.ts` 4/4.
- **No secrets / absolute paths / raw output** in the seed (Phase 3 bounds carry through the projection).
- **Determinism:** projection is a pure function over records; resume reproduces the live item list.

## 5. Scope

- In scope: Phase-4 typecheck errors, the two failing focused tests, byte-identity when no policy, and the projection-on-policy gate.
- Out of scope (Phase 5, intentionally untouched): `src/index.ts` exports, `CHANGELOG.md`, final repository gate, `report.md`.

---

## Host-observed facts vs reported claims (envelope integrity)

Host-observed (verified by running the repo): focused 11/11; `pnpm typecheck` exit 0;
`pnpm lint` 947 files, exit 0; shards 1/4=1048, 2/4=1096, 3/4=1060, 4/4=963;
grep-guard 4/4; no pi imports in `src/persistence`. **Reported/untrusted**
(the host directive) names the same bugs; it additionally asserted a "no-policy
test" failure — which *does* reproduce here — but asserted a "2 failing tests"
count that under-counts because the budget test also failed; both failed and
both pass now.

## Remaining risks / open questions

- **One non-reproducing shard-2 failure** appeared in a single run of the
  four-shard gate; every other shard-2 run (×5) passed cleanly at 1096. The
  change is fully deterministic, so this is almost certainly pre-existing flaky
  behaviour, not a regression. No evidence was captured of which test it was.
  Reviewer may re-run `--shard=2/4` twice to confirm stability.

## Reviewer requested action

`requested_action: verify-and-approve-or-request-changes`. Independently
reproduce the 11/11 focused gate and the four-shard gate; confirm the
no-policy byte-identity invariant by rendering a seed with `{ run_id }` only and
asserting no `host_evidence` section; confirm `materializeContinuity` still
projects evidence when a legacy continuity policy is pinned.
