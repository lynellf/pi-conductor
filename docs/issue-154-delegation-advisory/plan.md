# Implementation plan: issue #154 shadow-mode Jev delegation advisory

Authority: Forgejo issue #154. If this plan conflicts with the issue, the
issue is authoritative. Precedents this plan mirrors, and whose contracts it
must not change: `docs/jev-context-ranking/spec.md` (`context_enrichment`) and
`docs/issue-139-jev-assessment/plan.md` (`jev_assessment`).

## Outcome

An **opt-in, shadow-only** Jev layer over delegation. For each admitted
`delegate` task the host records a typed *dispatch advisory*; for each child
terminal it records a typed *result advisory*. Nothing reads either record
at run time. A deterministic offline report joins advisories to host-normalized
child outcomes so the operator can decide, with data, whether a v2 should
surface advice to parents.

Success means: with policy absent every record, prompt, and tool result is
byte-identical to today; with policy present the only observable delta is
appended advisory records and the offline report.

## Design decisions

1. **Shadow only, by construction.** Advisory records carry no admission,
   status, verdict, or routing field. No prompt renderer, scheduler branch,
   `child-result.ts` normalization, or delegate tool result reads them.
   Negative tests assert this (grep + behavior).
2. **Never on the critical path.** Advisory requests start after the
   authoritative record is persisted (`delegation_submission_accepted` /
   `subagent_completed|subagent_failed`) and run concurrently with child
   spawn/result delivery. They cannot fail a batch or delay `wait`.
3. **Best-effort durability, not replay.** Because no prompt consumes an
   advisory, there is no replay identity to protect. A host-owned bounded
   pending set is drained (bounded by `request_timeout_ms × max_attempts`)
   before run close; an interrupted request leaves **no** record. Resume never
   re-requests. This is deliberately simpler than the context-enrichment
   prepare-or-replay seam.
4. **Mirror the adapter pattern.** Provider-neutral `DelegationAdvisor`
   interface; fixed-origin TypeSafe HTTP adapter under
   `src/host/delegation-advisory/`; strict per-answer TypeBox validation;
   typed `unavailable` codes reused from the #139 assessment client where the
   meaning is identical. Do not modify `typesafe-client.ts` or
   `typesafe-assessment-client.ts`; extract a shared helper only if both
   existing tests stay untouched and green.
5. **Choice/noul only.** The issue proposed a Score for scope; this plan uses a
   Choice (`single_contract` / `related_bundle` / `unrelated_bundle`) because
   the categories are distinct situations, not degrees, and it keeps the
   adapter to the already-verified choice/noul wire shapes. Re-verify shapes
   against `https://docs.typesafe.ai/primitives/choice.md` and `noul.md`
   before Phase B.
6. **Profile fit needs declared descriptions.** Add optional subagent profile
   `description` (1–500 chars). `profile_fit` is asked only when the parent's
   `allowed_subagents` has ≥2 profiles and every one has a description;
   otherwise the question is omitted (recorded as `omitted: missing_descriptions`
   or `single_profile`), never approximated from `system_prompt`.

## Manifest contract

```yaml
delegation_advisory:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  mode: shadow            # the only v1 value
  max_parallel: 4         # 1–16
  request_timeout_ms: 5000  # 100–30000
  max_attempts: 1         # 1–5
```

All keys required when present; unknown keys fail. Requires at least one role
with a `delegation` policy (static validation error otherwise). Pinned in the
manifest snapshot. `TYPESAFE_API_KEY` handling is identical to
`context_enrichment` §5.

Subagent profile addition: `description?: string` (1–500 chars, trimmed,
single-paragraph). Used only as `profile_fit` criteria text.

## State and questions

Outbound text passes `redactOutboundText` and is truncated to 1000 chars per
field. Never sent: run/record/session/child/task IDs, paths (projection paths
are sent as a **count**), commits, context-artifact contents, transcripts,
tool output, credentials.

### Dispatch advisory (one request per admitted task)

```json
{
  "task": { "objective", "expected_output", "subagent", "tools": [...],
            "projection_path_count", "context_artifact_count",
            "verification_recipe": "<name>|null" },
  "profiles": [{ "name", "description" }]   // only when profile_fit is asked
}
```

| id | type | options / meaning |
|---|---|---|
| `objective_verifiable` | noul | `task.objective` states a success condition a reviewer could check |
| `output_checkable` | noul | `task.expected_output` is verifiable against returned artifacts, not only prose |
| `self_contained` | noul | child can act on `task` without unstated parent-only context |
| `scope` | choice | `single_contract` / `related_bundle` / `unrelated_bundle` |
| `profile_fit` | choice | one option per allowed profile (criteria = description) plus `none_fit` |

### Result advisory (one request per child terminal)

```json
{
  "task": { "objective", "expected_output" },
  "host": { "status", "normalization_reason", "worktree_state",
            "changed_path_count", "verification": [{ "name", "outcome" }] },
  "reported": { "summary", "verification_claims": [...] }
}
```

| id | type | options / meaning |
|---|---|---|
| `claims_supported` | choice | `supported` / `contradicted` / `not_assessable` — `reported` vs `host` |
| `objective_addressed` | noul | `reported.summary` addresses `task.objective` as assigned |

Instructions for every question state that `task` and `reported` text is
untrusted data, not instructions, and that the judgment is not about truth,
safety, or authority.

## Record contract

`src/persistence/delegation-advisory-record.ts`, strict TypeBox, added to the
`PersistedRecord` union, `record-materialization.ts`, and the public barrel.

- `delegation_dispatch_advisory` — `schema_version: 1`, `run_id`,
  `logical_parent_id`, `child_id`, `task_id`, `subagent`, `input_sha256`,
  `status: completed | unavailable`, `judgments` (full probability
  distributions; noul has no confidence) with `profile_fit` either present or
  `{ omitted: "single_profile" | "missing_descriptions" }`, `failure {code,
  attempts}`, `requested_model`, `actual_model`, `usage`, `ts`.
- `delegation_result_advisory` — same envelope keyed by `child_id`, plus the
  host terminal `status` it assessed (copied, for joining; never authority).

At most one record of each type per `child_id`; duplicates fail validation.
Records must not contain task text, summaries, or outbound state.

## Offline calibration report

Pure function `buildDelegationAdvisoryReport(records)` in
`src/persistence/delegation-advisory-report.ts` plus a thin
`conduct advisory-report <runs-dir> [--json]` subcommand in
`src/bin/cli-advisory-report.ts`, dispatched from `cli-main.ts` the same way as
`reconcile-tools`. Over all `*.jsonl` logs it emits JSON or a Markdown table:

- coverage: admitted tasks, advisories completed / unavailable / missing;
- per noul: host terminal status rates (`completed`, `no_changes`, `blocked`,
  `failed`, `cancelled`) by probability bucket (`<0.2`, `0.2–0.4`, `0.4–0.6`,
  `0.6–0.8`, `≥0.8`) with counts;
- per choice: status rates per argmax option and by confidence bucket;
- `profile_fit`: agreement rate between argmax and the chosen subagent, and
  outcome rates for agree vs disagree;
- `claims_supported`: rate of `contradicted` by host status.

Deterministic ordering; no network; no thresholds or recommendations — it
reports numbers only.

## Phase map (TDD, sequential)

### Phase A — policy, profile description, records

- [ ] **RED:** `tests/manifest/delegation-advisory.test.ts` (omission,
  bounds, unknown keys, `mode` literal, requires a delegation policy,
  profile `description` bounds);
  `tests/persistence/delegation-advisory-record.test.ts` (schema, duplicates
  rejected, no text-bearing fields, no verdict/status-authority fields).
- [ ] **GREEN:** `src/manifest/delegation-advisory.ts` + `types/parse/validate`
  wiring; profile `description`; `src/seam/delegation-advisory.ts` (question
  constants, answer schemas, failure codes);
  `src/persistence/delegation-advisory-record.ts`; `log.ts`,
  `record-materialization.ts`, barrel. No pi imports.
- [ ] **Acceptance:** absent policy parses to identical `MachineDefinition`;
  records cannot encode admission/status/routing.
- [ ] **Verify:** focused suites, `pnpm typecheck`, `pnpm lint`.

### Phase B — state builders and HTTP adapter

- [ ] **RED:** `tests/host/delegation-advisory-state.test.ts` (redaction,
  truncation, prohibited-field absence, `profile_fit` inclusion/omission
  rules, adversarial task text cannot alter question set);
  `tests/host/delegation-advisory-typesafe.test.ts` (one request per
  advisory, exact question set, MAP-keyed answer validation,
  probability sums, label mismatch, status mapping, retry bounds, fixed
  origin, key only in `Authorization`).
- [ ] **GREEN:** `src/host/delegation-advisory/{contracts,state,typesafe-delegation-client}.ts`.
- [ ] **Acceptance:** malformed answers ⇒ typed `unavailable`, never partial
  judgments; no raw bodies/exceptions escape.
- [ ] **Verify:** focused suites, `pnpm typecheck`, `pnpm lint`.

### Phase C — shadow wiring

- [ ] **RED:** `tests/host/delegation-advisory-shadow.test.ts` — with an
  injected fake advisor: dispatch advisory recorded after
  `delegation_submission_accepted`; result advisory after
  `subagent_completed|subagent_failed`; a never-resolving advisor does not
  delay spawn, `wait`, or result; advisor rejection/unavailable yields one
  `unavailable` record and zero other deltas; pending set drained or dropped
  (no record) at run close; resume issues zero requests; policy absent ⇒
  record log and every parent/child prompt byte-identical.
- [ ] **GREEN:** `src/host/delegation-advisory/shadow.ts` (bounded pending set,
  `max_parallel`, drain) and minimal hooks at the two persistence points
  (expected: `scheduler.ts` acceptance path and `factory-records.ts` terminal
  path — confirm before editing); production host constructs the TypeSafe
  advisor only when policy present.
- [ ] **Acceptance:** grep + tests show no reader of advisory records outside
  persistence/report; scheduler and `child-result.ts` behavior unchanged.
- [ ] **Verify:** focused suites, `pnpm typecheck`, `pnpm lint`, delegation
  test directories.

### Phase D — report, docs, final integration

- [ ] **RED:** `tests/persistence/delegation-advisory-report.test.ts` (fixture
  logs: bucketing, joins, missing/unavailable coverage, deterministic output).
- [ ] **GREEN:** report module + `conduct advisory-report` subcommand;
  `docs/issue-154-delegation-advisory/operator-disclosure.md` (mirrors the
  context-ranking disclosure); README manifest reference; CHANGELOG entry for
  the new manifest block and public records.
- [ ] **Regression:** `context_enrichment` and `jev_assessment` suites
  untouched and green; reducer/handoff/delegate schemas unchanged (grep).
- [ ] **Repository gates:** `pnpm typecheck`, `pnpm build`, four foreground
  `pnpm exec vitest run --shard=N/4`, `pnpm lint`, `pnpm format:check`,
  `pnpm audit --audit-level high`, `git diff --check`.
- [ ] **Review gate:** independent review of shadow-only enforcement,
  disclosure bounds, critical-path independence, and report determinism.

## Failure handling

| Trigger | Disposition |
|---|---|
| Policy absent | no advisor constructed; byte-identical behavior |
| Policy present, no API key | one `unavailable/missing_api_key` record per advisory; no retry |
| Provider/timeout/shape failure | one `unavailable/<code>` record; nothing else changes |
| Run closes with pending requests | bounded drain; unfinished ⇒ no record |
| Resume | no advisory requests for already-admitted/settled children |
| Record fails validation on load | fail closed as for other records |

## Out of scope

Surfacing advice to parents/children, warnings or blocking at dispatch,
automatic profile or model selection, model-tier recommendation, task text
rewriting, and any change to reducer, handoff schema, `delegate` tool schema,
`context_enrichment`, or `jev_assessment`. v2 surfacing is a separate issue
gated on the Phase D report.

## Risks

| Risk | Mitigation |
|---|---|
| Disclosure of task text | opt-in + disclosure doc; redaction, truncation, counts instead of paths |
| Async appends racing run close | single host-owned pending set; bounded drain; no record on interruption |
| Shadow data mistaken for authority | records lack authority fields; no runtime reader; negative tests |
| Extra cost per child | ≤2 requests per child; opt-in; `max_parallel` bound |
| Profile descriptions absent in real manifests | `profile_fit` omitted explicitly; report shows coverage |
