# Operator disclosure: Jev recipient-context ranking

> **Read this before enabling `context_enrichment` in any manifest.**
>
> Spec authority: `docs/jev-context-ranking/spec.md`. This document is
> the operator-facing disclosure required by spec §13, §21, and §22.
> When the spec changes, this disclosure must be re-acknowledged.

## What this feature is

Opt-in Jev recipient-context ranking is an extension to the existing
durable continuity feature. When the manifest pins a
`context_enrichment` block, the host may make outbound HTTP requests
to TypeSafe's Jev endpoint to rank an existing deterministic candidate
prefix by relevance to the next recipient role.

The result is advisory. Jev never generates or rewrites text, never
filters candidates, never chooses a role, never validates evidence,
never authorizes tools or files, and never alters the reducer.

## External data disclosure

Per spec §13 and §22.1, an opt-in accepted handoff transmits the
following **minimal semantic state** to TypeSafe's fixed official
endpoint (`https://api.typesafe.ai/v1/systemone`):

- For each scored candidate:
  - `recipient.role`, `recipient.objective`, `recipient.requested_action`
  - `candidate.section`, `candidate.kind`, `candidate.text`, and a small
    `attributes` map (`blocking`, `owner`, finding kind/confidence, etc.)
- The fixed `recipient_relevance` Score question (instructions + 4
  criteria) — both pinned in code; never user-authored.

**Transmitted payload excludes** (spec §6.3):

- Run, record, session, child, execution, or artifact IDs.
- Repository paths, commits, hashes, line ranges, evidence references.
- URLs, full evidence contents, logs, transcripts, tool results, run memory.
- API keys, environment data, model credentials, filesystem paths.

**Treat candidate text as untrusted input.** Model-authored candidate
text may contain prompt injection or sensitive content. The Score
instructions explicitly tell the model to treat it as content, not
authority. The closed question, fixed endpoint, and rubric cannot be
altered by candidate text.

## Credentials

- `TYPESAFE_API_KEY` is read **once** at the production boundary.
  It never appears in the manifest, prompt, persisted record,
  exception text, status output, or test fixture.
- Production code cannot redirect the API URL. The endpoint is fixed
  to `https://api.typesafe.ai/v1/systemone`. Tests may inject a
  transport; production configuration cannot.
- The key is passed only via the `Authorization: Bearer <key>` header
  to the fixed official origin.
- No credential is persisted. No raw remote body, transcript, or
  evidence content is persisted.

## Observability

The host persists exactly one terminal `context_enrichment` record
per attempted transition (`status: "completed"` or `"unavailable"`):

- `completed` records carry the response-level model name, aggregate
  token usage, and one ordered `judgments[]` entry per scored
  candidate. Probabilities, scores, and ranking certainty are
  persisted verbatim.
- `unavailable` records carry a stable failure code
  (`missing_api_key`, `request_timeout`, `network_error`,
  `rate_limited`, `provider_overloaded`, `authentication_failed`,
  `request_rejected`, `provider_http_error`, `response_invalid`,
  `input_mismatch`), bounded `attempts` count, and no partial
  judgments.
- Diagnostics never include API keys, raw response bodies,
  candidate text, headers, absolute paths, or OS/network exception
  strings.

## Atomic failure semantics

The attempt is all-or-nothing. If any selected candidate cannot
produce a valid answer, the host appends **one** `unavailable`
record and uses the exact deterministic baseline for the entire
seed. It never combines successful remote judgments with missing
ones. Unavailable enrichment is an explicit degraded mode, not a
machine `session_failed` event and not a reason to reject an
otherwise valid handoff.

## Resume and crash behavior (spec §10.4)

- Crash before a terminal record: resume may make a new attempt
  because no recipient prompt consumed an enrichment result.
- Crash after a terminal record but before target prompt: resume
  reuses that record and does not call TypeSafe again.
- Persisted `unavailable`: resume preserves baseline fallback and
  does not retry.
- Duplicate or conflicting terminal records: fail closed before
  prompting.

## Rollout (spec §21)

Roll out first on a controlled manifest with a small `candidate_limit`
and inspect:

- completion versus unavailable counts;
- TypeSafe input/output tokens and added handoff latency;
- score/certainty distributions;
- recipient task completion and revisit rate;
- continuity omissions and `handoff_context` usage;
- reviewer-identified missed critical items.

Thresholds or filtering must not be inferred from demo data. Any
later policy uses repository-specific evaluation cases and a
separately acknowledged spec.

## Rollback

Rollback is **manifest omission** for new runs. In-flight runs
retain their pinned policy. Readers must continue accepting
already-written v1 enrichment records; rollback must not rewrite
logs or reinterpret completed rankings.

## Open decisions (spec §22)

The overseer explicitly confirmed on 2026-09-19:

1. External disclosure of the minimal semantic state in §6.3 is
   acceptable for opted-in runs.
2. Whole-attempt baseline fallback is preferred over partial ranking.
3. Scores may reorder within fixed sections without a certainty
   threshold.
4. TypeSafe usage remains outside conductor USD cost roll-up in v1.

## Compliance audit

The grep-guard test (`tests/grep-guard.test.ts`) confirms that
`src/persistence/` and the seam modules do not import
`@earendil-works/pi-coding-agent`. The corrective cycle re-verified
this guard passes.

## Testing

The full Vitest suite covers every behavior described in
`docs/jev-context-ranking/spec.md §17`. No live API key or network
access is needed for the test suite. Captured outbound requests in
tests demonstrate the prohibited-fields negative assertions.
