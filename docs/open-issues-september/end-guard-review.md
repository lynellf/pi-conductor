# End guard review

The approved #75 contract adds a host check before an otherwise legal role end.
The reducer remains pure; forced cost closure bypasses the guard. Manifest,
records, execution and loop integration are reviewed as separate increments.

## Design decisions

- The loop owns start/result persistence around the host runner. A thrown append
  is ambiguous even when the write may have succeeded: no spawn follows an
  uncertain start, and no retry or accepted end follows an uncertain result.
- Process cleanup evidence is explicit. An unknown post-spawn failure closes
  admission for the primary checkout, including replacement role sessions.
  Abort waits for cleanup; an already-aborted request cannot spawn.
- Each output stream is decoded incrementally before the combined diagnostic is
  capped at 4 KiB of UTF-8. Error diagnostics obey the same cap.
- Gated retry identity includes the accepted request ordinal. A reused physical
  session file does not reuse a newly authorized request's budget. Guard success
  deferred by operator guidance does not erase prior failures.
- Gated exhaustion permits an operator resume and repair handoff. Only an
  exhausted ungated budget receives an explicit durable reset; resume reconstructs
  its current epoch first and validates ownership before constructing the host.

## Verification gates

- [x] Manifest omission, defaults, fractional/maximum deadlines, malformed input,
  immutability and actual canonical snapshot identity: 54 focused tests;
  strict typecheck and Biome passed before commit `28598c1`.
- [x] Runner cleanup, output bounds, cancellation and admission reviewed with
  real-process and controlled-boundary regressions: 18 tests; Biome and scoped
  source typecheck passed before commit `2f10b39`.
- [x] Durable ordering, uniqueness, byte limits, identity and restart validated:
  55 persistence tests, full typecheck and Biome passed before `853b266`.
- [x] Loop legality, retry correction, failure budgets, abort/guidance/cost-cap
  precedence and API resume proven through integration tests.
- [x] Full repository gates and final independent review passed: 167 files /
  2,009 tests, strict typecheck, build, lint, format and production audit.
- [ ] Merged tree verified against the tested head and #75 closed.

The public resume tests exposed a shared pinning gap: ordinary runs did not
snapshot normalized manifests unless trajectory or Prewalk was enabled. This
affects #76 policy as well as the new guard. The reviewed correction snapshots
every new run and resolves role/subagent tool defaults in that snapshot copy.
Existing snapshots and legacy no-snapshot logs retain their established resume
paths. This follows archived FSM §10 and the approved #76 pinned-policy contract.

Independent cross-layer review found and verified corrections for gated resume
resetting an exhausted request and ungated resets preceding resume validation.
Actual-loop tests cover writes that throw before and after durable append,
runner identity mismatches, retained pending requests, and process abort cleanup.

Pinned resume continues to run runtime model-provider checks against the saved
manifest. A separate no-snapshot fixture protects legacy YAML preflight. The
new-run trajectory fixture now expects a manifest snapshot while retaining its
fresh-conversation, lifecycle and transport assertions.
