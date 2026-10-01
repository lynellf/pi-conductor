# #165 scoped safety-review findings

These are scoped adversarial reviews, not feature approval. Fresh-context reviews
used the supplied contracts and source artifacts with no tools or edits; judgments
were checked against source and the controlling specification. The signal/
settlement artifact reached the **three-cycle escalation limit** with material
findings still open. Do not treat the corrected subsets as a completed safety gate.

## Reproduced and corrected in the follow-up

| Finding | Evidence | Correction |
| --- | --- | --- |
| Close can overwrite timeout/abort after awaiting live-group or escaped-descendant cleanup | Four deterministic RED cases: cancellation × cleanup branch | Recheck cancellation ownership after cleanup; one shared cleanup promise |
| Duplicate JSON members can establish apparent private status success after `JSON.parse` discards evidence | Two RED duplicate-member frames | Require the exact canonical trusted-emitter frame, in addition to closed shape/value checks |
| Expired wall deadline can lose when an overdue timer has not been delivered | Three RED cases: empty scan, live-group cleanup, escaped cleanup | Recheck wall deadline/abort at terminal claims and after required awaits |
| A post-admission child `error` is incorrectly labeled not-started and bypasses cleanup | RED synthetic `EPERM` event on an admitted child | Route admitted transport errors through the existing cleanup owner; no not-started claim |
| Workload `NODE_DEBUG=child_process` activates keeper diagnostics that dump private argv/env | Native RED `/bin/echo` case; synthetic workload environment, no ambient secrets | Keeper uses only fixed PATH/LANG and its private ownership marker; full intended workload environment is restored after admission |

The keeper-debug failure was found during source inspection, not reported by the
first scoped review. Its retained RED log has the test ownership nonce redacted;
the failure count and synthetic debug-leak evidence are retained. The change also
keeps other workload-specific startup flags out of the keeper; it is not a new
sandbox claim or a restriction on the released workload's intended environment.

Targeted verification after these corrections: **42/42 tests across four files**
(settlement races, private status protocol, native signal/outcome/FD/debug tests,
and preload-admission barrier). Native minimum-Node verification remains open;
the local native runtime is Node 25.6.0, while authoritative signal/debug behavior
was checked against Node 22.19.0 documentation.

## Signal/settlement cycle 3: open

1. **Long timer overflow.** `supervised-process-settlement.ts` schedules an
   unchecked `processDeadline - Date.now()` delay. Node converts delays greater
   than 2,147,483,647 ms to 1 ms; the timer callback does not recheck expiration.
   The supervisor's option validation has no explicit upper bound. Caller limits
   and the admission timer must be investigated together; silently truncating or
   extending the deadline is not an acceptable patch. This counterexample has not
   yet received a separate runtime reproduction or baseline attribution.
2. **Close-observation failure bypasses cleanup.** The catch around group/global
   close observation marks the terminal unconfirmed, removes cancellation and
   rejects without calling the shared cleanup owner unless cancellation already
   won. The uncertainty label is conservative, but a potentially surviving marked
   descendant receives no further cleanup attempt. Source confirms the missing
   call; a deterministic failure-path test and correction are still needed.

Additional deadline investigation: `runSupervisedProcess` gives `onStart` an
effective deadline before awaiting it, then derives `processDeadline` afterward.
Check the caller-derived budget and persistence contract before accepting this
ordering; no claim is made that this is a reproduced baseline or a new regression.

## Observer runtime/cache review: open

The following are source-level findings; no live compiler escape or toolchain
replacement experiment was performed.

- **Uncertain-lock/publication bypass (review findings 1 and 6, one root issue):**
  disk cache hits and the in-memory fast path do not check `build-lock`. A valid
  binary/receipt can be accepted while another publication remains active or its
  lock is retained. Lock-aware publication/admission tests are missing.
- **Setup settlement proof:** successful compiler return, or a numeric status on
  an error from any setup helper, clears the build lock without descendant
  settlement evidence. Numeric parent exit alone is not the specified proof.
  Bootstrap settlement must not recursively require an already-built observer.
- **Synchronous timeout bounds:** `execFileSync` uses default SIGTERM. Node's
  documentation explicitly says it continues waiting if the child handles that
  signal without exiting. The 30-second/two-second options are not independently
  hard return bounds. Bounded setup/observer termination needs design and tests,
  not an assumption that trusted tooling cannot hang.
- **Tooling input trust:** the compiler selection checks canonical target UID 0,
  but not parent writability, compiler write/ACL permissions or SDK trust. SDK
  canonicalization alone does not establish trusted headers. Validate the actual
  installed-tooling boundary without installing tools or weakening permissions.
- **Unsanitized setup failures:** architecture discovery, cached codesign and
  some filesystem operations sit outside the fixed-error wrapper. Their exceptions
  can expose raw setup diagnostics/paths rather than the specified capability
  error. Exercise these failure paths.
- **Exact private-directory mode:** the predicate excludes group/other bits but
  accepts owner mode 0500 (and special bits), despite claiming exact 0700. This is
  a contract mismatch, not proof that the accepted read-only mode grants outsiders
  access. Add exact-mode tests rather than overstate its severity.

## Admission/recovery review: triage

1. **Mach age exclusion: contract mismatch, not an accepted bug.** The review
   prompt accidentally omitted the controlling specification's preserved original
   age exclusion and explicitly pinned Mach boundary. A same-kind Mach birth
   strictly before the original boundary is permitted evidence for an
   **unknown-marker global** candidate; marker-positive ownership still wins.
   The proposed no-witness counterexample therefore does not violate that
   controlling contract. Wallclock age must never be compared with Mach.
2. **Owned-session filtering: open.** `readProcessSessionMembers` applies Mach age
   and preexisting exclusions after matching the requested session. The contract
   says owned group/session settlement observes all members, regardless of UID.
   Review the reachable session consumers and representation/PID-reuse cases;
   prove that no live owned member is hidden. Do not weaken the global real-UID
   boundary or use a current service/name classification as a substitute.
3. **Oversized capture: impossible native counterexample.** The reviewer supplied
   16,385 valid session leaders, but `observer-protocol.ts` rejects more than
   **16,384 total processes** and the C observer has the same bound. Session
   witnesses are a subset of those processes, with unique PIDs. Such a snapshot
   cannot reach production capture; a mock bypassing the parser does not prove an
   unbounded admission. No schema bound was relaxed and no extra witness truncated.

## Remaining scope and escalation

- Same-real-UID restricted **new-session** desktop candidates remain a demonstrated
  native feasibility blocker; see [failure-inventory.md](failure-inventory.md).
- Remaining cleanup/observation-race/parser-compatibility and Linux-extraction
  reviews, and corrected cache/recovery re-reviews, are not complete.
- Actual Linux runtime results are absent; queued Actions checks are not execution.
- Stop advancing native enablement/acceptance pending design direction on provenance
  and bootstrap settlement. Keep the draft open, fail closed, and do not release.
- No additional cross-model review was requested or performed in this follow-up.

Local review artifacts: `pi-conductor-165-signal-review{,-cycle2,-cycle3}.txt`,
`pi-conductor-165-cache-review.txt`, `pi-conductor-165-recovery-review.txt`.
Relevant retained RED/GREEN logs: `pi-conductor-165-peer-followup-red.log`,
`pi-conductor-165-terminal-authority-{red,green}.log`,
`pi-conductor-165-keeper-env-red.log`, and
`pi-conductor-165-hardened-targeted.log`. They are local investigation evidence,
not checked-in process-output dumps.
