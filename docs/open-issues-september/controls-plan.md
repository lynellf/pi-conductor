# Approved execution controls implementation plan

User acknowledged the specification on 2026-09-08. Implementation uses Luna;
the main agent owns integration, independent review, gates, merge and assessment.
Baseline: remote main `a96bbf9`. Work takes place in the isolated review worktree;
concurrent edits in the original checkout remain preserved.

## Assumptions and boundaries

- Keep Pi 0.80.6 pinned and use public SDK interfaces only.
- Tool policy keys are `timeout_seconds`, `max_recoverable_timeouts`, and
  `termination_grace_seconds`, normalized to 300/2/2. The configured timeout may
  rise to 3,600 seconds; model-supplied values can only shorten it.
- Prove the supported process-cleanup platform before wiring execution. Unknown
  ownership on restart must stop resumably, never kill a possibly unrelated PID.
- Preserve confined file-tool surfaces for isolated roles and delegated children;
  adding deadlines does not grant them a shell.
- No fresh approval gate between phases; the specification is approved. Commit
  verified increments, then merge each complete issue with closure evidence.

## Phase 1 — #76 tool deadlines and cleanup

1. Supervised subprocess foundation (independent of manifest wiring).
   - [x] Own process groups, deadline/abort arbitration, termination escalation,
     bounded output and cleanup evidence; explicit platform admission.
   - [x] RED/GREEN real-process tests: silent hang, CPU loop, descendants/pipelines,
     normal exit and abort races. Focused tests and typecheck pass.
     Final foundation gate: 23 process tests, scoped strict typecheck and
     Biome pass; fast exits, bounded callbacks, stdin EPIPE and UTF-8 included.
     Independent review approved after reproducing and fixing successful exits
     with escaped descendants, close/deadline arbitration and dying-PID reads.
   - Files: new `src/host/execution/supervised-process*.ts` and focused tests.
2. Pinned policy contract (independent of subprocess foundation).
   - [x] Parse/validate/freeze role and subagent policy; omitted defaults and
     positive finite integer limits; programmatic invalid values rejected.
   - [x] Table-driven manifest tests and typecheck pass (60 focused tests).
   - Files: manifest policy module, types, parser, validator and focused test.
3. Durable execution lifecycle (depends on 1–2).
   - [ ] Typed start/result identities, one terminal result, recovery accounting
     across model fallback, restart reconciliation with explicit unknown ownership.
   - [ ] Append/reopen/order/privacy/restart tests and typecheck pass.
   - Files: execution ledger, additive persistence contract, log validation, tests.
4. Shared SDK path (depends on 1–3).
   - [ ] Enforce deadlines at executable boundaries; never replay commands;
     confirmed timeout permits repair, exhaustion/uncertain cleanup stops resumably.
   - [ ] File operations settle or stop with unconfirmed cleanup; intentional owner
     and delegation waits remain exempt. Focused tool/session integration tests pass.
   - Files: tool factory/wrappers, production-host narrow wiring, integration tests.
5. Isolated RPC and delegated children (depends on 4).
   - [ ] Same pinned deadlines/ownership/recovery contract crosses RPC; child tools
     retain confinement; cancellation waits for confirmed execution cleanup.
   - [ ] Shared/RPC/child tests prove timeout and abort outcomes, no hidden process.
   - Files: RPC configuration/bridge, child tool wiring, focused tests.
6. Operator visibility and issue gate (depends on 5).
   - [ ] Active tool/elapsed and timeout/recovery status, user documentation.
   - [ ] Independent review reconciled; full typecheck/build/test/lint/format/audit
     gates pass. Merge #76 and close only after acceptance is met.

## Phase 2 — #75 end guard (after Phase 1 gate)

7. Manifest and durable guard attempts.
   - [ ] Optional pinned command/deadline; typed start/result/reset records,
     three-failure budget per authorized request or ungated run.
   - [ ] Manifest and append/reopen/reset tests pass.
8. Guard execution and resume.
   - [ ] Execute only before mechanically legal role-issued orchestrator end;
     preserve pending request on failure; forced-close bypass; no success cache.
   - [ ] Success/failure/timeout/order/exhaustion/crash/unknown-owner tests pass.
9. Issue gate.
   - [ ] Document behavior; independent review and full gates pass; merge and close.

## Phase 3 — #77 asynchronous delegation (after Phase 2 gate)

10. Durable submission and task ledger.
    - [ ] Stable run/logical invocation/tool-call identity, atomic acceptance,
      fingerprints, pinned context/base/projection and fallback-persistent admission.
    - [ ] Duplicate/response-loss/different-input/restart tests pass.
11. Session scheduler and task operations.
    - [ ] One shared capacity pool; status/result/targeted wait/cancel; independent
      failures; exactly one terminal result and usage contribution per task.
    - [ ] Gated A/B/C tests prove early B review and C start while A remains active.
12. Parent/RPC lifecycle.
    - [ ] Public SDK notifications and durable retrieval; RPC submission identity;
      handoff/end blocking; fallback/abort/budget settlement; interrupted restart.
    - [ ] Shared/RPC response loss, targeted cancellation, replacement and cleanup
      regressions pass; old blocking delegate remains compatible.
13. Issue gate and final assessment.
    - [ ] Document tools/contracts; independent review and full gates pass; merge
      and close #77. Refresh remote issue inventory and post-merge assessment.

Each numbered slice is reviewed and committed after focused verification. Broad
integration slices are split further by concrete files as API evidence is found;
no unrelated refactors or dependency upgrades are included.

Integration inventory: Prewalk host validation (`prewalk-validation.ts`) also
executes role-triggered commands and must use the supervised boundary. Ordinary
host repository provisioning is distinct from model-issued executable tools;
this change does not silently broaden role shell permissions.
