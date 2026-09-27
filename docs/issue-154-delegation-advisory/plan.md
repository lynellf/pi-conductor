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

1. **Shadow only, by construction.** Advisory records carry no authoritative
   admission or child-lifecycle status, verdict, or routing field. The record
   contract may carry the advisory request outcome (`completed | unavailable`)
   and a copied host terminal status solely for offline joining; neither is an
   admission decision or runtime authority. No prompt renderer, scheduler
   branch, `child-result.ts` normalization, or delegate tool result reads these
   records. Negative tests assert this (grep + behavior).
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

- [x] **RED:** `tests/manifest/delegation-advisory.test.ts` (omission,
  bounds, unknown keys, `mode` literal, requires a delegation policy,
  profile `description` bounds);
  `tests/persistence/delegation-advisory-record.test.ts` (schema, duplicates
  rejected, no text-bearing fields, no verdict/status-authority fields).
- [x] **GREEN:** `src/manifest/delegation-advisory.ts` + `types/parse/validate`
  wiring; profile `description`; `src/seam/delegation-advisory.ts` (question
  constants, answer schemas, failure codes);
  `src/persistence/delegation-advisory-record.ts`; `log.ts`,
  `record-materialization.ts`, barrel. No pi imports.
- [x] **Acceptance:** absent policy parses to identical `MachineDefinition`;
  records cannot encode authoritative admission/status/routing.
- [x] **Verify:** focused suites, `pnpm typecheck`, `pnpm lint`.

### Phase B — state builders and HTTP adapter

- [ ] **RED (historical execution unverified; not recovered):**
  `tests/host/delegation-advisory-state.test.ts` (redaction, truncation,
  prohibited-field absence, `profile_fit` inclusion/omission rules, adversarial
  task text cannot alter question set);
  `tests/host/delegation-advisory-typesafe.test.ts` (one request per advisory,
  exact question set, MAP-keyed answer validation, probability sums, label
  mismatch, status mapping, retry bounds, fixed origin, key only in
  `Authorization`). Original Phase B RED execution evidence is unavailable. By
  explicit user authorization, replace this gate with retrospective independent
  test review and targeted behavioral mutation checks in an isolated temporary
  copy. Mutation evidence is not historical RED evidence; do not rewrite working
  code or tests to manufacture TDD provenance.
- [x] **Substitute gate (authorized replacement for RED above):** retrospective
  test review plus 24 targeted mutations of `state.ts`, `typesafe-wire.ts`,
  `typesafe-delegation-client.ts`, and the Noul schema, run in an isolated
  scratch copy against both Phase B suites. 20 were killed on the first pass.
  Two survivors exposed real gaps (the answer-id set check on the
  `profile_fit`-omitted path; an empty-string API key). Two tests were added
  (no production change), and both mutants are now killed. The two remaining
  survivors are equivalent: `labels.includes(choice)` is implied by the exact-key
  plus probability-maximum checks, and an extra loop iteration is unreachable
  because every attempt path returns or continues within `max_attempts`.
- [x] **GREEN:** `src/host/delegation-advisory/{contracts,state,typesafe-delegation-client}.ts`.
- [x] **Acceptance:** malformed answers ⇒ typed `unavailable`, never partial
  judgments; no raw bodies/exceptions escape.
- [x] **Verify:** focused suites, `pnpm typecheck`, `pnpm lint`.

### Phase C — shadow wiring

- [x] **RED:** `tests/host/delegation-advisory-shadow.test.ts` — with an
  injected fake advisor: dispatch hooks run after
  `delegation_submission_accepted`; result hooks run after
  `subagent_completed|subagent_failed`; never-resolving advisor work does not
  delay spawn, `wait`, or result. Assertion-level RED was observed for both the
  absent dispatch hook, projection work occurring before the next event-loop
  turn, and unbounded pending overflow. The suite also verifies result rejection mapping,
  drain/drop, bounded/redacted records, strict result projection, and no replay
  request.
- [x] **GREEN:** `src/host/delegation-advisory/shadow.ts` (bounded pending set,
  `max_parallel`, a hard pending cap of four jobs per parallel slot, and drain;
  state projection, redaction, hashing, and advisor call deferred to a later
  immediate turn) and minimal hooks at the confirmed seams:
  `scheduler.ts` acceptance and the terminal `onTerminal` callback after
  `factory-records.ts` appends the child record; production host constructs the
  TypeSafe advisor only with policy.
- [x] **Acceptance:** grep + tests show no reader of advisory records outside
  persistence/report; scheduler admission/terminal handling and `child-result.ts`
  behavior remain authoritative and unchanged.
- [x] **Verify:** focused suites, `pnpm typecheck`, `pnpm lint`, delegation
  test directories.

### Phase D — report, docs, final integration

- [x] **RED:** `tests/persistence/delegation-advisory-report.test.ts` (fixture
  logs: bucketing, joins, missing/unavailable coverage, deterministic output).
- [x] **GREEN:** report module + `conduct advisory-report` subcommand;
  `docs/issue-154-delegation-advisory/operator-disclosure.md` (mirrors the
  context-ranking disclosure); README manifest reference; CHANGELOG entry for
  the new manifest block and public records.
- [x] **Regression:** `context_enrichment` and `jev_assessment` suites
  untouched and green; reducer/handoff/delegate schemas unchanged (grep).
- [x] **Repository gates:** `pnpm typecheck`, `pnpm build`, four foreground
  `pnpm exec vitest run --shard=N/4`, `pnpm lint`, `pnpm format:check`,
  `pnpm audit --audit-level high`, `git diff --check`.
- [x] **Review gate:** independent review of shadow-only enforcement,
  disclosure bounds, critical-path independence, and report determinism.

> **Review gate outcome:** no blocking findings.
> - *Shadow-only:* the only references to advisory record types are the shadow
>   writer, log parsing/validation (`log-file*`, `in-memory-log`,
>   `record-materialization`), the barrel, and the offline report. No prompt,
>   scheduler branch, `child-result.ts`, or delegate tool result reads them.
>   Append-time duplicate rejection is swallowed by `DelegationAdvisoryShadow`,
>   so a load-time history check can only see records that already passed it.
> - *Critical path:* scheduler hooks are synchronous enqueues wrapped in
>   `try/catch` after the authoritative append. State projection and the advisor
>   call are deferred to `setImmediate`. Drain runs only in `runWithCompletion`
>   close, before lease release, and errors there are swallowed.
> - *Disclosure:* matches the state builders. Correction made: result requests
>   always send an empty host `verification` list (the terminal seam has no
>   host-observed recipe outcomes), so `operator-disclosure.md` now says so and
>   notes that `claims_supported` will lean toward `not_assessable` in v1.
> - *Report determinism:* pure over records, with sorted run IDs and grouped
>   keys, fixed buckets and statuses, and argmax ties broken lexically.
> - *Non-blocking notes for v2:* (1) the drain budget
>   `request_timeout_ms × max_attempts` excludes retry backoff (≤1.5 s) and
>   queued jobs behind `max_parallel`, so these surface as `missing` coverage;
>   (2) dropped in-flight requests are not aborted and finish in the background
>   within their own per-attempt timeouts, with results discarded; (3) an
>   unexpected advisor rejection is recorded as `network_error` with 1 attempt.

> **Initial Phase D gate attempt:** `pnpm typecheck`, `pnpm build`, `pnpm lint`,
> `pnpm format:check`, `pnpm audit --audit-level high`, and `git diff --check`
> passed, as did Vitest shards 2/4, 3/4, and 4/4. Shard 1/4 and an isolated run
> exposed an environment-sensitive failure in the existing Issue #57
> minimal-child retry test: unisolated SDK settings prevented the scripted
> provider retry, while an empty isolated agent directory passed. The test now
> supplies isolated SDK retry settings using a temporary `PI_CODING_AGENT_DIR`;
> no production code or Issue #154 behavior was changed.
>
> **Phase D repository gate rerun:** the focused Issue #57 suite passes (10/10).
> All four foreground Vitest shards pass (1/4: 105 files, 1097 tests; 2/4: 105
> files, 1160 tests; 3/4: 105 files, 1132 tests; 4/4: 102 files, 1052 tests).
> Typecheck, build, lint, format check, high-severity audit, and diff check pass.
> The independent review gate remains open.

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
