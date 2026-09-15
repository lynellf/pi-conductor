# Issue #113: recovered retries and finalization failures

This repair implements the issue's acceptance criteria under the retained-context
contract and FSM spec §§11–12. It preserves accepted transitions and terminal
usage; finalization is a separate host outcome, not a second lifecycle event.

## Decisions

- Pi SDK 0.80.6 exits before tool execution when an assistant response ends in
  `error` or `aborted`. Its retry preparation removes the failed response from
  active messages while leaving the session-file audit entry intact.
- Only a failed response superseded by another assistant response without an
  intervening user/tool message qualifies for retry projection. Durable tool
  execution or delegation admission contradicts that classification and keeps
  pairing validation strict. Exhausted retries remain subject to pairing checks.
- Hash and validate the audited source branch. Restore a new effective branch
  when required, without rewriting the original source or charging its usage
  again. Ordinary restoration continues to use the SDK's exact branch operation.
- Capture, disposal, and commit failures append a bounded, attributed
  `run_finalization_failed` record. The receiver cannot start after that failure.
  The accepted checkpoint and the original lifecycle/cost records remain intact.
- Capture/commit recovery requires explicit context reset, preserving the current
  receiver. Disposal failure requires inspection and cleanup before a fresh run;
  a context reset cannot attest disposal. Existing unfinished-tool, compaction
  uncertainty, and run-lease checks remain authoritative.
- If writing the diagnostic itself fails, live completion still rejects and the
  handle reports failure. Durable reporting cannot be guaranteed when storage
  rejects the write.

## Verification

- [x] Reproduce capture/disposal/commit failures through the public API before
  changing finalization; all three tests initially rejected after saved handoff.
- [x] Real SDK with deterministic provider: partial call, retry, executed read,
  handoff, receiver, later retained invocation. No partial-call execution or
  admission; failed usage and original audit history remain present.
- [x] Public API fault injection verifies one accepted transition, one terminal
  usage record, no receiver spawn, persisted failure, and blocked ordinary resume.
- [x] Explicit reset resumes capture/commit failures at the accepted receiver;
  disposal failure remains blocked even with reset.
- [x] Independent Luna/Terra review resolved, including compaction preservation
  and terminal status precedence.
- [x] Read-only validation of the reported session passes with 100 audited
  entries and 99 effective entries; the source bytes are unchanged.
- [x] Full tests (2,852 tests across 268 files), strict typecheck, build, lint,
  and format pass. A stale recovery-text expectation found in the first full
  pass was corrected; the complete rerun is green.
- [x] Production dependency audit passes. The full development audit reports
  two moderate findings in Vitest/mocker (GHSA-82fw-gwwq-j7x9) and one low esbuild
  finding (GHSA-g7r4-m6w7-qqqr), with no high or critical findings. Dependency
  upgrades are outside this repair.
- [x] Linked `conduct` resolves to this rebuilt checkout and reaches the CLI
  usage response without an SDK import failure (usage exit status 2).

Historical run files are read-only evidence. No historical run is automatically
resumed, reset, reconciled, or rewritten by this repair.
