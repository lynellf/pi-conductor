# Progressive enhancement implementation plan

Authority: corrected overseer instruction authorizes specification, implementation,
shared fixes, CI scheduling change, commit/push and a PR from main without further
approval stops. Base: `00f09c8c795836d579df73122537dcefe0f9257e`.

1. [x] Write the design record and inventory; choose conservative baseline resume,
   closed strict policy and explicit backend requirements. Verify against current
   host/source/record contracts, not the parked Darwin branch.
2. [x] Reproduce shared timer overflow and close-observation cleanup bypass with
   deterministic tests; fix bounded timers/cleanup, then run shared focused tests
   and typecheck. Commit separately from feature detection.
3. [x] Correct CI scheduling to the registered runner label, retaining the existing
   Linux gates and minimum Node. No runner/server changes.
4. [x] Add pure closed execution policy and strict capability/baseline record
   contracts. Verify parsing, invalid combinations, timelines and log round trips.
5. [x] Add host capability selection/preflight and warning/record publication.
   Verify strict, required, all-role/profile and handoff-only cases with RED tests.
6. [x] Add bounded baseline process execution and SDK worker selection. Verify
   native success/failure, timeout/abort, output bounds, timer/deadline arbitration.
7. [x] Route shared/isolated role calls through a baseline controller; preserve the
   enhanced controller and legacy records. Verify durable-before-effect,
   uncertainty sealing and resume/replacement blocking.
8. [x] Add baseline end guards with truthful records and unchanged legacy budgets.
   Verify success/failure, retry accounting, uncertainty and resume blocking.
9. [x] Exercise the actual packed extension on macOS and run portable focused
   regressions. Review correctness/security/architecture before final commit.
10. [x] Run typecheck/build/lint/format/audit/full tests, record failures honestly,
    push and open the PR; obtain actual Linux CI execution and investigate results.

Verification evidence belongs in `verification.md`. Do not tick unperformed
steps, hide failed full runs with subsets, skip meaningful failures, merge/release,
port protected backend contracts or begin tool decoupling. Cross-model review is
not started implicitly in this autonomous instruction; deterministic RED tests
supply adversarial behavioral checks, and a fresh-context scoped read-only review
will inspect the new recovery/record boundary before finalization.
