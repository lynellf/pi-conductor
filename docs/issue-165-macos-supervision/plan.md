# Implementation plan: #165 macOS supervision

Authority: acknowledged `spec.md`. Dedicated macOS runner infrastructure is out of
scope. Native verification uses the SIP-enabled Apple Silicon development Mac.

## Ordered slices

1. **Native feasibility (blocks enabling macOS).**
   - [x] Reproduce ordinary macOS execution rejection with a failing test.
   - [x] Add bounded public-SDK native identity/session/marker observations;
     redacted/empty environment is unknown, never proven absent.
   - [x] Verify original-session exclusions, real restricted escaped processes,
     and at least 40 ordinary desktop commands without false cleanup success.
   - [x] Implement the overseer-approved Linux-equivalent real-UID scope, with
     separate native credential metadata, closed validation and setuid regression tests.
   - [x] Rerun the unchanged desktop campaign after alignment: 40/40 completed;
     retain unknown same-real-UID markers and all group/session members.
   - [x] Run an additional 200-command scoped desktop-churn campaign, separately
     counting native identity races and terminal unreadable-marker failures.
   - [ ] Resolve remaining guard/packed uncertainty and obtain detailed safety review.
   - Verify: native observer and macOS supervisor tests; warning-clean C build.
   - Files: native resource, macOS observer/runtime modules, native tests.
2. **File-tool supervision.** Depends on 1.
   - [x] Extract Linux identity contracts and settlement by responsibility,
     preserving Linux implementation semantics; route macOS observations.
   - [ ] Prove all six production file tools, timeout/abort cleanup, and mutation
     uncertainty behavior on macOS; keep Linux-specific observation tests scoped.
   - Verify: shared supervisor/file-tool tests, typecheck, build.
   - Files: identity/settlement facade modules, production/file-tool tests.
3. **Foreground commands and end guards.** Depends on 2.
   - [x] Admit a marker-visible leader before releasing arbitrary command effects;
     avoid relying on restricted-shell environment or PID reuse.
   - [x] Reproduce SIGPIPE false success and SIGUSR1 inspector activation; replace
     keeper self-signaling with bounded private terminal metadata and add native
     signal, missing-status, and closed-protocol regressions.
   - [ ] Verify bash, pipelines, end guards, deadlines, abort races, and escaped
     descendants; no keeper/leader exit can establish descendant cleanup alone.
   - Verify: supervisor, bash, end-guard, packed-package tests.
   - Files: supervisor transport/settlement modules, native integration tests.
4. **Admission/recovery.** Depends on 3.
   - [x] Add strict separately versioned macOS admission origin; preserve Linux v1.
   - [ ] Route reconciliation and dependent local-effect observations, reject
     foreign/malformed origins, retain blocked guard-resume behavior.
   - Verify: admission, persistence, reconciliation, controller recovery tests.
   - Files: admission schema/host capture, reconciliation/diagnostics, tests.
5. **Production capability preflight.** Depends on 4.
   - [x] Check all required roles/profiles/end guards before model work; reject
     Bubblewrap specifically on macOS without removing tools or confinement.
   - Verify: production/preflight tests and packed extension workflow.
   - Files: production preflight/context/spawn, package resources, tests.
6. **Final verification and review.** Depends on 5.
   - [x] Update platform documentation and changelog, explicitly marking acceptance as open.
   - [x] Run post-fix focused native tests (historical 149/149; draft checkpoint
     241/241), typecheck, build, lint, format and diff checks; the latest production
     audit passed, with the earlier registry-timeout retry retained separately.
   - [x] Complete a full native suite run and record its failed result; reproduce
     12 failures in a detached baseline worktree rather than assume all are baseline.
   - [ ] Complete failure triage and obtain real Linux runtime verification before
     claiming unchanged Linux behavior.
   - [ ] Review ownership, origin, observer-cache and cleanup safety; record any
     remaining limitations and tick only performed acceptance checks.
   - Verify: commands in `spec.md`, desktop campaign, git diff checks.

## Draft follow-up performed

- [x] Preserve the latest full-run result (334 failures / 60 files) and create a
  count-checked [per-file inventory](failure-inventory.md); only 12 failures are
  baseline-reproduced, and root-cause triage remains incomplete.
- [x] Inspect the three full-run candidates while alive with matching identities;
  retain same-real-UID/new-session unknown markers without name/signature exemptions.
- [x] Reproduce and fix close/cancellation races, duplicate private members,
  timer-delivery versus wall-deadline races, and post-admission transport errors.
- [x] Reproduce keeper NODE_DEBUG argv/env leakage; minimize keeper startup env
  while preserving the workload's environment after durable release.
- [x] Correct per-test mock/cache lifetime under isolate:false and prove native
  churn instrumentation is active (more than 200 actual observer invocations).
- [x] Complete three fresh-context transport review cycles and first cache/recovery
  reviews; [record findings and triage](review-findings.md), not whole-feature approval.
- [ ] Correct/re-review open setup/cleanup/session findings and obtain actual Linux
  execution; the review escalation limit and feasibility gate remain blockers.
- [ ] Obtain design direction on same-real-UID restricted new-session provenance
  and observer bootstrap settlement before advancing native enablement/acceptance.

## Current gate: blocked, not ready to ship

See [verification.md](verification.md). The overseer approved matching Linux's
real-UID boundary. Native observations now retain independently validated real and
effective UIDs; the unchanged 40-command campaign passed after the change. A first
broader native run passed 126/127 tests, with a guard cleanup-unconfirmed result;
20 reduced timeout reproductions passed, and an instrumented native run passed
127/127. A subsequent packed run passed all six file tools but failed packed bash
fixture cleanup with an observation error, reproduced in the completed full suite.
A shared time-representation issue was reproduced and fixed; the final focused run
passed 149/149. The full suite completed with 332 failed tests; 12 baseline failures
were separately reproduced. These failures remain under triage, not erased by green
subsets. The peer-reviewed signal defects were subsequently reproduced and fixed;
29 outcome/protocol regressions passed at that checkpoint. The first scoped-churn
campaign passed 200/200 with 1,118 updates, and packed bash passed six runs. The
latest full run then failed churn (198/200) and reproduced packed EACCES. The three
live inspected candidates had matching Mach identities, both UIDs 501, unknown
markers and independent sessions/groups; original exclusion proof was insufficient.
Follow-up hardening passes 42 targeted tests; the latest broader run passes 155/156
with another packed cleanup-unconfirmed EACCES. The later PID was gone before fresh
inspection, which is not cleanup proof. Its instrumented campaign passed 200/200
(1,018 updates, 1,027 native calls), without erasing the failed full campaign.
A draft PR is open for review, not acceptance. Composite acceptance boxes remain
unticked; Linux CI is waiting, root-cause triage is partial, and new cache/cleanup
review findings remain open. Native feasibility requires design direction.

## Decisions and risks

- Restriction detection uses observable complete environment data, not a private
  code-signing API. Empty/redacted data remains unknown unless original evidence
  excludes the candidate. A process escaping into a new session with hidden
  environment remains cleanup-unconfirmed.
- Own-spawn PID alone is insufficient across fast-exit/reuse. If needed, a small
  Node leader awaits private release before spawning commands and remains alive
  until command exit; this is supervision, not a sandbox.
- A same-host boot UUID and raw Mach identity values must never be interpreted as
  Linux ticks. Recovery never manufactures an original snapshot.
- Compiler setup must be trusted, bounded and non-triggering. Review found open
  settlement, hard-timeout, tooling-trust and lock/publication gaps; the current
  draft does not yet establish that contract. No automatic installation is allowed.
- No new npm dependency or lockfile change. Intel/Rosetta/older-macOS verification
  and dedicated CI infrastructure are not represented as performed.
