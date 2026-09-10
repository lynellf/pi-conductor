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

- [x] Prove delayed admission postpones cancellation with fake timers.
- [x] Cancel at the original deadline and prohibit operations after expired admission.
- [x] Pass focused admission/controller tests, typecheck, build, and lint (27 focused tests).

## Final verification

- [x] Independent code review; address findings.
- [x] Full tests, typecheck, build, lint/format checks, and dependency audit.
- [x] Repeat preserved-log/installed-SDK read probe with normal status polling.
- [x] Verify linked CLI resolves to the rebuilt checkout.
- [x] Run a bounded application smoke with fresh logs and report its exact scope/results.
- [x] Record measurements and commit the reviewed repair.

## Verification results (2026-09-10)

- Full suite: **2,197 tests across 210 files passed** in 200 seconds, including
  the new 2,001-record synthetic status/real-worker integration fixture and
  all ownership, admission, reconciliation, and package guards.
- Typecheck, build, lint, and format checks passed. Production dependency
  audit is clean. The full audit retains the existing one low and two
  moderate development advisories, with no high/critical findings and no
  dependency changes.
- The same preserved-log probe with Pi 0.85.1 and Node 26.5.0 now completes
  the read with status polling in **669 ms** (670 ms without polling).
  Before the repair it exceeded the eight-second deadline and settled after
  10,219 ms. The repaired probe performed one 174 ms initial stats refresh
  and left the worker's observation path free to progress during cooldown.
- The linked `conduct` executable resolves to this checkout's rebuilt
  `dist/bin/conduct.js`; the extension loads the same checkout's source.
- A fresh production-host smoke used the installed Pi SDK and live
  `openai-codex:gpt-5.6-sol` at low effort, with the actual status poller,
  two read-only FSM roles, a $1 run cap, 20-second tool deadlines, and a
  three-minute abort limit. It completed **orchestrator → checker →
  orchestrator → done** in **20.0 seconds**, with two reads and one grep
  completing in **724, 713, and 716 ms**. All three starts retained admission
  evidence and all three finishes confirmed cleanup. Reported usage cost
  was **$0.102741**. Both source-file hashes and the original unresolved-run
  log hash remained unchanged.
- Live-smoke stats refreshes peaked at 1.63 ms; the handoff notifications
  arrived within 220 ms of their durable transitions. This small-run result
  complements the preserved large-log probe; it is not a full campaign or
  a replay of the original concurrent delegation workload.
- The preliminary smoke manifest rejected a zero recovery allowance before
  run creation. The valid smoke used the required positive allowance of one;
  no tool timed out or retried.

## Limits retained

Admission capture itself still awaits read-only observation before the
controller starts its operation; a capture that never settles is not made
interruptible by this deadline-accounting fix. An expired capture cannot
launch an operation. Status snapshots may lag by the adaptive cooldown;
the spinner and elapsed-tool display continue from the last snapshot.
One synchronous refresh can still delay the event loop, but refreshes no
longer consume the entire interval repeatedly.
