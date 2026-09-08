# Open issues — September 2026

Baseline: `main` 7f5dcd9, eight open issues, no open PRs.
User requested remediation, merge, then assessment. Main already includes
Prewalk (#78) and role-turn telemetry (#68); verify before treating trackers as
unimplemented. New controls use [the proposed spec](spec.md), awaiting acknowledgment.

## Ordered work

- [x] Read instructions, authoritative FSM spec, all eight issue bodies/comments,
  current remote state and existing telemetry spec; preserve clean prior branch.
- [x] #68: review merged telemetry against acceptance criteria and run its focused
  tests. Close only if complete; otherwise implement focused corrections.
- [x] #74: relocate README reference sections verbatim, add page TOCs/cross-links,
  preserve section coverage and local links, README <=300 lines. Verify section
  and link inventory; no runtime change or archive edits.
- [x] #73: reproduce repeated no-emission failure; permit three recovery prompts
  per invocation and include exhausted count in failure detail. Surface durable
  failure reasons/details in start/resume terminal messages. Verify focused loop
  and extension tests, cap/abort behavior and full gates.
- [x] #71: preflight unsupported trajectory versions and preserve actionable
  failure identity through handoff/terminal reporting. Verify unsupported version,
  failed admission and supported trajectory tests; never silently use fresh mode.
- [x] #67: inspect current public upstream runtime API; rerun compatibility spike
  only if supported public runtime identity transfer exists. Record evidence and
  leave open if upstream remains blocked; never bridge private fields. Latest
  Pi 0.85.1 remains blocked; see [SDK assessment](sdk-assessment.md).
- [ ] Acknowledge new controls specification before #75–#77 implementation.
- [ ] #75: manifest/persistence contract; host guard execution and retry behavior;
  success/failure/resume E2E. Gate each slice with focused tests and typecheck.
- [ ] #76: execution policy and process ownership; timeout/cleanup records;
  shared/RPC/child wiring; status and restart tests. Prove real process cleanup
  before relying on it from asynchronous delegation.
- [ ] #77: durable acceptance/task state; scheduler and shared budgets; parent
  tools/notifications; lifecycle settlement and recovery. Use deterministic gated
  workers; preserve blocking compatibility and confined projections.
- [x] Review complete fixes; run lint/typecheck/build/tests/format/audit. Final
  source gate: 137 test files, 1,797 tests passed. Production audit: zero; full
  audit: one low esbuild finding, zero moderate/high/critical, after targeted
  transitive security patches. See [review](review.md).
- [x] Commit and merge the verified issue fixes; close only issues
  whose implemented acceptance criteria are met on remote main.
- [x] Assess merged main: issue status, verified behavior, operational limits,
  architecture/maintenance risks and prioritized remaining work.

Dependencies: #73 terminal diagnosis supports #71. #76 supervised process
cleanup supports both #75 guard execution and #77 asynchronous delegation.
Implement #76 process supervision before #75 execution wiring; manifest work can
precede that boundary.
#74 and #68 review are independent. #67 may depend on upstream API availability.
Assessment follows remote merge verification; no release/publish is requested.

Merged implementation: PR #79,
`d628f8de4791d07b4e96baae43c7956fc3961a37`. See the
[post-merge assessment](assessment.md) for remaining priorities and limits.
