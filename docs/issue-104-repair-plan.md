# Issue #104 repair plan

Implements the repair authorized after `issue-104-investigation.md`, under
the existing FSM spec §11.1/§11.8 and tool-execution deadline contract (#76).

## Scope and decisions

- Keep all persistence validation and process-ownership rules intact.
- Read one consistent log snapshot for `RunHandle.runStats()`.
- Separate the 250 ms spinner from stats refresh. Schedule the next refresh
  after the current refresh finishes, with at least 250 ms free time and a
  cooldown of nine times the refresh duration. This targets at most 10% of
  host time spent refreshing stats when validation is expensive.
- Reuse the last stats for spinner/elapsed rendering during that cooldown.
  No persistent-log cache, schema change, or new dependency is needed.
- Arm controller cancellation with the remaining original deadline after
  admission. Keep expired-capture no-launch behavior.
- Preserve original evidence and recovery uncertainty. Validate with isolated
  workloads before a bounded new application run; no automatic historical
  cleanup confirmation or full campaign restart.
- The exact historical leader-identity timing remains unknown; this repair
  targets the two reproduced defects. Broader lifecycle telemetry is deferred.

## Slice 1: status refresh progress

- [x] Prove repeated log reads and expensive-refresh starvation with regression tests.
- [x] Derive exit reason and status from one snapshot, preserving abort/done/failure precedence.
- [x] Decouple rendering and refresh; retain transition notifications and shutdown semantics.
- [x] Pass focused status/handle tests, typecheck, build, and lint (44 focused tests).

## Slice 2: original deadline

Depends on slice 1 verification; reproduction tests can be authored independently.

- [ ] Prove delayed admission postpones cancellation with fake timers.
- [ ] Cancel at the original deadline and prohibit operations after expired admission.
- [ ] Pass focused admission/controller tests, typecheck, build, and lint.

## Final verification

- [ ] Independent code review; address findings.
- [ ] Full tests, typecheck, build, lint/format checks, and dependency audit.
- [ ] Repeat preserved-log/installed-SDK read probe with normal status polling.
- [ ] Verify linked CLI resolves to the rebuilt checkout.
- [ ] Run a bounded application smoke with fresh logs and report its exact scope/results.
- [ ] Record measurements and commit the reviewed repair.
