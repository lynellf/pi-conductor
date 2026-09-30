# Long-run packet budget recovery

Issue #139 requires bounded rendering without discarding essential process facts.
A long-running build reached 114 cutoff keys: the rendered source-index header
alone prevented the packet from fitting its 4,096-byte budget, even after all
optional evidence rows and reported narrative had been removed. Strict append
correctly rejected the 4,145-byte result before prompting the recipient.

## Repair

The pure renderer now replaces an oversized cutoff-key display with its exact
count, SHA-256 of the JSON key array, and explicit dispatch source key, but only
when that representation is smaller. The full cutoff, dispatch identity and
structured evidence stay in the durable record. Saved packets are never rerendered
or rewritten. No manifest, cost/visit cap or byte limit changes.

Optional-row budgeting is separated into a small pure module. Omission counters
are rendered and measured on every pass (previously command/verification counters
were appended after the last render). Large optional dirty-path lists can also be
reduced, with an exact count; the revision, process state and blockers are retained.
An irreducible over-budget packet still fails strict persistence validation.

## Evidence and limits

- Test-first reproduction: seven failing behavior cases, one existing fail-closed
  case passing. Failures included long-history append, four omission-footer cases
  and a large worktree snapshot, not fixture/setup errors.
- Nine regression tests now pass: deterministic compact rendering; preserved source
  arrays; file-backed append/reopen/exact reuse; UTF-8 omission accounting; retained
  worktree revision; missing-review blocking; and impossible-budget rejection.
- Related focused packet/continuity coverage passed (100 tests before the final
  blocker regression was added); the final nine-test file also passed separately.
- Typecheck, build, lint and whitespace checks passed. Four full test shards ran:
  4,394 passed, one failed. The provider-retry case in
  `tests/host/issue-57-minimal-child-protocol.test.ts` is the same failure previously
  reproduced on the unchanged baseline; the full suite is not claimed green.
- Read-only replay of the interrupted dispatch produces a valid 2,858-byte packet
  under the unchanged 4,096-byte cap, preserving all 114 structured cutoff keys.
  All 17 previously persisted packets still validate; lookup reuses saved bytes.

This is a display/materialization repair, not a routing decision or a new retry
policy. No model invocation, dependency change, log mutation or approval bypass
was used to verify it. Local self-review covered provenance, immutable replay,
unchanged strict validation and finite row-removal loops; this is not a claim of
independent review or merge approval.
