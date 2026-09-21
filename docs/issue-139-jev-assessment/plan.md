# Implementation plan: issue #139 Jev advisory semantic assessment

Authority: the Jev enhancement comment on issue #139. If this plan
conflicts with that comment, the comment is authoritative. Parent plan
`docs/issue-139-host-phase-work-packets/plan.md` (all phases ticked) is
the foundation; this enhancement changes none of its contracts.

## Outcome

An **optional, advisory-only** Jev layer over the bounded phase work
packet and the worker/reviewer’s supported reported `reason`. Given the
packet’s host-observed facts plus the separate reported/untrusted
narrative, Jev classifies relevance, consistency, actionability, and an
advisory next action. The bounded typed result — with
confidence/probabilities, packet version/digest, and reason/packet
identities — is persisted as a terminal `jev_assessment` record and
rendered into the recipient seed as a separately labelled advisory
section. It is stale if either input changes.

The host remains authoritative for phase state, required verification,
gate status, routing legality, and completion. Jev judgments are never
evidence that a command passed and never permission to promote a gate.

## Design decisions

1. **Mirror the context-enrichment pattern, do not invent a new one.**
   Provider-neutral `AssessmentEnricher` interface (`assess` →
   typed outcome); fixed-origin TypeSafe HTTP adapter under
   `src/host/jev-assessment/`; async prepare-or-replay seam that
   persists exactly one terminal record before the recipient prompt;
   resume reuses the matching terminal without a new Jev call. The
   Score-only `typesafe-client.ts` is untouched — the assessment
   adapter is a new module for choice/noul questions.
2. **One request, four questions, same state.** Per the TypeSafe docs
   (“ask independent questions over the same state together”): one
   `POST /v1/systemone` call carrying `relevance` (choice),
   `consistency` (choice), `actionable` (noul), `next_action`
   (choice). Wire shapes verified against `docs.typesafe.ai`
   (choice `criteria` map, noul `{true,false}` criteria, MAP-keyed
   answers, noul answer `{type:"noul",noul}` with no confidence).
3. **The record cannot express approval.** By construction the
   `jev_assessment` schema has no gate-state, verdict, or
   verification-outcome field, so no code path can promote
   `incomplete` to `approved` or flip a host check. Negative tests
   prove it against approval-like prose.
4. **Nothing reads judgments for routing.** The loop appends the
   advisory rendering to the seed and nothing else. “Blocker/omission”
   from the comment surfaces as an explicit
   `recommendation: inspection recommended — <why>` text line for the
   recipient role, never as a machine blocker. Unavailable renders an
   honest unavailable line; loop behavior is otherwise identical.
5. **Inputs are durable record contents.** State is built from the
   persisted `phase_work_packet` (phase facts, bounded observed
   facts, reported narrative) — never from live transcripts. Replay
   identity is `(run_id, recipient_role, visit, packet_sha256,
   reason_sha256)`; a same-visit record with different shas fails
   closed (stale), it is never reused or silently re-run.
6. **Skip, don’t assess, when there is nothing to assess.** No
   reported `reason` (null/empty) ⇒ return null: no record, no seed
   delta, byte-identical legacy behavior. Policy absent ⇒ same.
   Policy enabled but no API key ⇒ one `unavailable/missing_api_key`
   terminal (mirrors the enrichment precedent), no retry, no
   fallback, routing unchanged.
7. **Opt-in manifest policy, minimal block.** New `jev_assessment:`
   mapping (`schema_version: 1`, `provider: typesafe_jev`, `model`,
   `request_timeout_ms`, `max_attempts`) wired through
   `manifest/{types,parse,validate}.ts`. Absent policy preserves
   legacy seeds byte-identically.

## State, questions, and thresholds

Bounded redacted state (named JSON fields; `redactOutboundText`
reused; reason/objective/action/summary truncated to 1000 chars each;
commands capped at 8 id+outcome entries; verification capped at 16
name+outcome entries — outcomes only, never prose claims):

```json
{
  "phase": { "kind", "phase_id|role", "gate_id|visit_index",
             "gate_state", "legal_action", "host_directive" },
  "observed": { "worktree", "commands", "verification" },
  "reported": { "objective", "action", "summary", "reason" }
}
```

| Question id | Type | Options / meaning |
|---|---|---|
| `relevance` | choice | `relevant` / `partially_relevant` / `irrelevant` — reason relevant to assigned phase work and acceptance criteria |
| `consistency` | choice | `consistent` / `contradicted` / `not_assessable` — reason vs host-observed evidence |
| `actionable` | noul | P(handoff actionable as stated; nothing concrete missing) |
| `next_action` | choice | `review` / `remediate` / `block` / `complete` — advisory recommendation |

`inspectionRecommended` (pure, unit-tested heuristic, documented as
such): status `unavailable`, OR `consistency=contradicted` with
confidence ≥ 0.5, OR `actionable` ≤ 0.35, OR any choice confidence
< 0.4. Noul in [0.4, 0.6] renders “uncertain”.

## Record contract

Strict TypeBox `JevAssessmentRecord` in
`src/persistence/jev-assessment-record.ts`, added to the
`PersistedRecord` union + `record-materialization.ts` + public barrel.
Append-only, keyed by `(run_id, recipient_role, recipient_visit_index,
packet_sha256, reason_sha256)`:

- `packet_sha256` (sha256 of packet `rendered`), `reason_sha256`
  (sha256 of assessed reason text), `input_sha256` (sha256 of the
  full Jev state);
- packet source identity (`dispatch_source` kind + ts) and reason
  source key for audit readability;
- `judgments` (four answers with confidences/probabilities; noul
  has no confidence per the wire contract) or `failure {code,
  attempts}` when `unavailable`;
- `requested_model`/`actual_model`, `usage`, `ts`.

## Dispatch and resume protocol (loop seam)

In `runSessionTurn`, after a ready packet is ensured and only when
`packet.reported_narrative.reason` is non-null:

1. `host.prepareJevAssessment({packet, reason, ...})` → find terminal
   matching identity → return it (no Jev call); stale same-visit
   record → throw (fail closed).
2. Else if policy absent → null (legacy seed unchanged).
3. Else build state, fingerprint, single bounded attempt via the
   injected `AssessmentEnricher` (default: TypeSafe HTTP adapter with
   `TYPESAFE_API_KEY`), validate all four answers strictly, persist
   exactly one terminal (`completed` or `unavailable`), return it.
4. Append `renderJevAdvisory(record)` (`### jev_advisory`, labelled
   advisory inference, separate from host facts and reported
   narrative) to the seed.

## Acceptance criteria mapping

| Comment criterion | Planned implementation |
|---|---|
| Advisory only; never evidence/permission | record has no verdict/check fields; loop never branches on judgments; negative tests |
| Relevance / consistency / actionability / next-action | one 4-question Jev request over packet+reason state |
| Persist bounded result + identities; stale if inputs change | terminal record with shas; replay verifies, mismatch fails closed |
| Host-check green only from host records; approval needs checks + typed reviewer decision; missing decision stays `incomplete` | no code path touches gate/verification; tests assert packet + routing identical with/without Jev |
| Low-confidence/contradicted/unavailable adds blocker/omission, never silent route/fail-open | explicit inspection-recommendation / unavailable lines in advisory text; routing untouched |
| Consistent / contradicted / insufficiently specific reasons | three behavioral test cases over a fixed packet fixture |
| Advisory labelled separate from facts and narrative | `### jev_advisory` section with authority disclaimer |

## Phase map (TDD, sequential)

### Phase A — seam + record contract and pure assessment logic

- [x] **RED:** `tests/persistence/jev-assessment-record.test.ts`
  (schema validation, replay match, stale-sha mismatch, no
  verdict/check fields); `tests/host/jev-assessment.test.ts`
  skeleton for the pure `inspectionRecommended` + advisory renderer
  cases. Expect failure: modules do not exist.
- [x] **GREEN:** `src/seam/jev-assessment.ts` (question constants,
  TypeBox Q/A schemas, outcome + failure codes);
  `src/persistence/jev-assessment-record.ts` (record schema,
  assert, sha + replay helpers); wire `log.ts`,
  `record-materialization.ts`, barrel exports. Pure; no pi imports.
- [x] **Acceptance:** closed schemas reject unknown keys; replay
  matches exact identity only; stale shas fail closed; the record
  type cannot encode approval or a check outcome.
- [x] **Verify:** focused suites, `pnpm typecheck`, `pnpm lint`.

### Phase B — HTTP adapter (choice/noul) + provider-neutral fake

- [x] **RED:** `tests/host/jev-assessment-typesafe.test.ts`
  (4-question request shape, MAP-keyed answer validation per
  question, probability sum-to-one, choice-label mismatch,
  status-code mapping, timeout/retry bounds, fixed origin).
  Expect failure: adapter does not exist.
- [x] **GREEN:** `src/host/jev-assessment/contracts.ts`
  (`AssessmentEnricher` interface) +
  `typesafe-assessment-client.ts` (fixed origin, one request,
  strict per-answer validation, typed failures, `missing_api_key`
  static enricher). Do not touch `typesafe-client.ts`.
- [x] **Acceptance:** malformed answers become typed `unavailable`
  codes, never partial judgments; credentials never leave the
  Authorization header; no raw exceptions escape.
- [x] **Verify:** focused suites, `pnpm typecheck`, `pnpm lint`.

### Phase C — prepare-or-replay, manifest policy, loop wiring

- [x] **RED:** extend `tests/host/jev-assessment.test.ts` (skip
  when reason null / policy absent; reuse without Jev call;
  unavailable persists once with no routing delta; consistent /
  contradicted / insufficiently specific reasons;
  approval-impossible even for approval-like prose; failed host
  check never overridden). Expect failure: prepare + hook missing.
- [x] **GREEN:** `src/host/jev-assessment/prepare.ts` (state
  builder with bounds/redaction, fingerprint, replay-or-attempt,
  exactly-one terminal, advisory renderer);
  `src/manifest/jev-assessment.ts` + `types/parse/validate`
  wiring; `Host.prepareJevAssessment?` + StubHost +
  production-host-state/production-host; call in
  `loop-session-turn.ts` after a ready packet when reason present;
  append advisory rendering.
- [x] **Acceptance:** all comment gate-policy bullets hold;
  policy-absent and reason-absent runs are byte-identical to
  legacy; resume performs zero Jev calls.
- [x] **Verify:** focused suites, `pnpm typecheck`, `pnpm lint`.
  (Four foreground shards run once in Phase D.)

### Phase D — final integration and independent review

- [x] **Regression coverage:** #139 packet byte-stability without
  policy; #137 narrative still reported-only; #135 evidence still
  the sole verification source; reducer inputs and handoff schemas
  untouched (grep + tests).
- [x] **Repository gates:** `pnpm typecheck`, `pnpm build`, four
  foreground `pnpm exec vitest run --shard=1/4` … `--shard=4/4`,
  `pnpm lint`, `pnpm format:check`, `pnpm audit --audit-level high`.
  (Shard 4: one pre-existing env failure in
  `controller-effect-implementation-inventory` — fails identically on
  the clean tree. An end-guard lease flake surfaced during shards was
  bisected to pre-existing timing sensitivity tipped by per-prompt
  dynamic imports; the advisory seam now uses static imports.)
- [x] **Review gate:** independently verify advisory-only
  enforcement, cutoff/sha determinism, resume idempotency,
  missing-verdict blocking, blind spots (direct FS reads,
  key-absent runs), and no reducer/handoff-payload regression.
- [x] **Completion:** tick only performed boxes; CHANGELOG entry
  for the new public persistence contract.

## Failure handling

| Trigger | Disposition |
|---|---|
| Policy absent or reason null | return null; no record; legacy seed byte-identical |
| No API key with policy enabled | persist one `unavailable/missing_api_key` terminal; advisory unavailable line; no retry |
| Provider/timeout/shape failure | persist one `unavailable/<code>` terminal; advisory unavailable line; routing unchanged |
| Same-visit terminal with different shas | throw stale-input materialization error; operator inspects; never reuse, never auto-rerun |
| Assessment record fails validation on replay | fail closed; do not substitute or regenerate |

## Deliberately out of scope

Manifest-policy tuning UI, new verification execution, re-collecting
#135 evidence, delegated-child assessment, reducer/handoff-schema
changes, model/provider routing changes, and multi-packet trend
analysis are out of scope. Thresholds stay heuristics with unit
tests, not enforcement.

## Dependency order and risks

Seam/record → adapter → prepare/policy/wiring → gates. Sequential:
each layer’s identity contract (question ids, shas) is the next
layer’s replay key.

| Risk | Mitigation |
|---|---|
| Choice/noul wire shape drift vs official API | shapes verified against docs.typesafe.ai (choice criteria map, noul answer, MAP-keyed answers); strict per-answer validation fails closed |
| Advisory prose mistaken for verdict | record cannot encode verdicts; renderer carries authority disclaimer; negative tests with approval-like prose |
| Threshold arbitrariness becomes policy | single `inspectionRecommended` predicate, documented heuristic, boundary unit tests |
| Extra Jev cost per dispatch | skip when reason null; resume reuses; one request per assessed dispatch; opt-in policy |
| Packet byte-stability regression | policy-absent path returns null before any rendering; existing packet tests unchanged |
