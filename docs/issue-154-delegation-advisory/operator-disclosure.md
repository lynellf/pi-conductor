# Operator disclosure: shadow-only delegation advisory

> **Read this before enabling `delegation_advisory` in a manifest.**
>
> Authority: `docs/issue-154-delegation-advisory/plan.md` and issue #154.
> This disclosure describes the v1 opt-in data flow; it does not authorize any
> runtime use of advisory judgments.

## What this feature does

`delegation_advisory` opts a host into bounded TypeSafe Jev Choice/Noul requests
for admitted delegated tasks and their terminal results. The feature is
**shadow-only**: it appends typed dispatch/result advisory records, but neither
records nor judgments affect admission, scheduling, prompts, child-result
normalization, tool results, status, verdict, or routing. They are available
only to persistence validation and the offline report.

Without the manifest block, the host does not construct an advisor or append
advisory records. With it, the only intended observable difference is
best-effort advisory records and the report described below. Advisory requests
start after their authoritative delegation record is persisted and cannot delay
spawn, `wait`, result delivery, or admission. At run close the host drains only
for the configured `request_timeout_ms × max_attempts` budget; unfinished work
is dropped without a record. An interrupted request leaves no record; resume
never re-requests an already-admitted child.

## External data disclosure

Each request uses the fixed official endpoint
`https://api.typesafe.ai/v1/systemone`. Outbound text is passed through
`redactOutboundText` and bounded to 1000 characters per field. The state builder
caps effective tools, host verification entries, and reported claims at 16 each;
profile candidates are limited to the profiles allowed by the pinned parent
policy.

A dispatch request may send:

- task objective, expected output, and selected subagent profile name;
- up to 16 effective tool names and an optional verification recipe name;
- projection-path and context-artifact **counts**, never their paths/content;
- declared subagent profile names/descriptions only if at least two profiles
  are allowed and every one has a description.

If profile-fit criteria are ineligible, that question is omitted and the record
stores `single_profile` or `missing_descriptions`. The host never derives
criteria from `system_prompt`.

A result request may send the objective and expected output; the host-normalized
status, normalization reason, and worktree state; a changed-path **count**; and
bounded reported summary/verification claims. The host verification list is
currently always empty: the child-terminal seam carries the child's claims, not
host-observed pinned-recipe outcomes, so `claims_supported` is expected to lean
toward `not_assessable` in v1. No raw tool or execution output is sent.

The outbound payload never contains run, record, session, child, task, execution,
or artifact IDs; repository or filesystem paths; commits or hashes; artifact
contents; transcripts; tool output; environment data; or credentials. Task and
reported text is untrusted data, not instructions. Fixed questions cannot be
changed by that text.

## Credentials and provider behavior

- `TYPESAFE_API_KEY` is used only in the `Authorization` header to the fixed
  HTTPS origin. It is not included in the manifest, prompt, logs, records, or
  diagnostics.
- No raw response body or exception text is persisted. A malformed or
  unavailable request yields one `unavailable` advisory with a bounded failure
  code and attempt count; partial judgments are not recorded.
- `max_parallel` is 1–16, `request_timeout_ms` is 100–30,000, and
  `max_attempts` is 1–5. API usage is outside the host's model-cost rollup.
- The CLI report is local and offline: it reads `*.jsonl` run logs, makes no
  network request, and does not modify them.

## Durable records and report

Each admitted task may have one `delegation_dispatch_advisory`; each terminal
child may have one `delegation_result_advisory`. Persisted records include run,
parent, child, and task identities for append-only storage and offline joining,
plus bounded hashes, model/usage metadata, request outcome, and typed judgments;
they never store task or reported prose. Those identities are not sent to
TypeSafe. `status` on a record is the request outcome (`completed` or
`unavailable`). The copied `host_status` on a result record is solely an
observation for joining the offline analysis; it is not machine status or
authority.

Generate the aggregate report after collecting the desired run logs:

```sh
conduct advisory-report <runs-dir>
conduct advisory-report <runs-dir> --json
```

The report contains admitted-task and advisory coverage, probability/confidence
buckets, host-terminal status counts/rates, profile-fit agreement/outcomes, and
contradicted-claim rates grouped by host status. It emits aggregate numbers and
does not expose task prose, child/run identities, paths, or recommendations.
No network access or API key is needed to produce it. Buckets are descriptive
report groupings, not action thresholds.

The report is calibration data, not evidence that a model judgment is correct.
Do not infer automatic routing, filtering, admission, or profile selection from
it. Any v2 feature that surfaces advice requires a separate design and review.

## Rollback

Omit `delegation_advisory` for new runs. A run already pinned to the policy may
finish bounded pending work as described in the plan. Existing logs remain
append-only; removing the policy does not rewrite or reinterpret advisory
records. Offline reporting remains optional.
