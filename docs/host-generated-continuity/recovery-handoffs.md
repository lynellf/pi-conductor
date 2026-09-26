# Model-exhaustion recovery and v2 continuity

A provider failure can exhaust a role's approved models. The host then appends the
existing synthesized `role_unavailable` handoff to the pinned orchestrator. This is
not a worker's terminal tool call: it has no agent `accepted_control` envelope.
The preceding `session_failed` already records its unsuccessful outcome.

The strict v2 observation materializer previously validated **every** accepted
handoff as an agent envelope. The next dispatch (or a restart after it) therefore
failed with `accepted_control_v2_invalid_schema`. All actual agent envelopes could
be valid; the missing envelope belonged to host recovery. Restart immediately at
the synthesized handoff had a separate missing-envelope failure in resume seeding.

## Repair contract

- Identify only the existing sentinel, matching reason, null source context,
  worker-to-pinned-hub route, and preceding same-run failed invocation. An intervening
  session start/terminal or accepted transition cannot stand in for that failure.
- Require same-run pinned manifest membership. Unknown or contradictory records
  retain the normal strict failure behavior.
- In strict v2 reconstruction, retain the `host_failure` observation and omit the
  synthetic routing record; do not fabricate a successful worker return.
- For v2 resume immediately at recovery, use the same host-authored unavailable-role
  seed as the live loop. Ordinary agent envelopes still require full validation.
- Preserve legacy projection behavior, reducer decisions, caps and append-only logs.
  No backfill, record rewrite, model substitution or automatic retry is introduced.
  An explicit operator resume remains distinct from unlimited automatic retries.

## Verification

`tests/host-generated-continuity/recovery.test.ts` covers strict replay, JSON round
tripping without mutation, nine rejected near-misses, legacy projection preservation,
a live stub-provider failure followed by another available role, and file-backed
resume both immediately at recovery and after a subsequent valid dispatch.

The initial test-first run reproduced the materialization error and both resume
failures. An early integration fixture without explicit v2 policy was corrected
before accepting those resume failures as RED evidence. No external provider is
needed for these regression tests.

Focused continuity, fallback, resume, return narrative and architecture tests pass,
as do typecheck, build and lint. All four full-suite shards were executed. The
initial six protected-effect inventory failures were caused by group-writable files
in the new checkout; tightening only that checkout's source permissions made the
affected effect tests pass. One provider-retry child-protocol test still fails and
was reproduced on the unchanged source baseline as well. The complete suite is
therefore not claimed green; the failing baseline is outside this recovery fix.

Read-only replay of the actual interrupted history succeeded with strict v2
validation and preserved its failure and current task context. Operational logs,
workspace backups and resume receipts are retained outside the repository.
