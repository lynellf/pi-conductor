# Issue #115 proposed implementation outline

Status: [spec](spec.md) acknowledged; implementation in progress with Terra,
Luna, and Sol. No further human approval gates precede completion.
Each task should remain a focused change of roughly five files;
split schema consumer migrations into successive verified slices if necessary.

## A. Durable contracts and native identity

- [x] Add controller configuration/protocol schemas and incompatible-field checks.
  - Acceptance: opt-in is explicit; bounded closed schemas; existing manifests
    parse unchanged; controller-owned delegation policy needs no fake SDK tool
    or orchestrator model; steering is explicitly unsupported.
  - Files: controller manifest module, manifest schema/validator, focused tests.
  - Verify: table-driven valid/invalid manifest and protocol tests; typecheck.
- [x] Add definition, activation, plan, action receipt and event-cursor records.
  - Acceptance: validate chronology, stable IDs, duplicate/conflicting action
    fingerprints and interrupted/uncertain/repair outcomes; inline recoverable
    requests; decision revision separate from event cursor; host-agnostic persistence.
  - Files: controller persistence schemas/timeline, record union, tests.
  - Verify: malformed/mixed chronology tests and grep guard.
- [x] Version native admission origins and extract shared structured admission.
  - Acceptance: legacy SDK IDs remain unchanged; controller IDs are distinct;
    accepted arguments/bindings retrievable; no second scheduler/child runner.
  - Files: delegation persistence identity, scheduler, facade, tests.
  - Verify: legacy replay, mixed origins/scope isolation, capacity and
    duplicate-submission tests across activations.
- [x] Migrate affected native consumers and stable controller budget scoping.
  - Acceptance: no assumed tool-call field; resume cannot refill lifetime slots.
  - Files: delegation factory/coordinator/reconcile and focused tests, in slices.
  - Verify: existing native admission/cancellation/reconciliation suites.

Phase A verified: 2,906 tests across 272 files; typecheck, build, lint and
format checks pass. Production audit is clean; the full audit retains the
existing two moderate and one low development advisories, with no high/critical
findings. The controller runtime remains fail-closed until integration lands.

## B. Approved executable mechanics

- [x] Generalize executable-operation provenance without changing supervision.
  - Acceptance: planner/adapter execution records identify real operations;
    SDK tool records remain readable; existing ownership gate still fails closed.
  - Files: execution origin schema/controller contracts and consumers, in slices.
  - Verify: tool execution, sandbox lifecycle and legacy timeline tests.
- [x] Implement approved pinned controller/adapter runtime preflight and runner.
  - Acceptance: fixed argv, immutable complete runtime, no credentials/network,
    bounded JSON, deadline/abort, exact host approval and no unsafe fallback.
  - Files: host controller runtime, runner, protocol adapter, tests.
  - Verify: malformed/oversized output, changed runtime, denied capability,
    sandbox confinement and cleanup fixtures.
- [x] Implement local adapter publication and bounded artifact/receipt reads.
  - Acceptance: actual preparation/validation/bookkeeping executes; private
    staging cannot escape; immutable exact outputs consumed by native projection.
  - Files: controller adapter/publication/read modules and focused tests.
  - Verify: escaping symlinks, invalid output, publish crash and binding tests.
- [x] Add an explicit host-issued artifact source for native child context.
  - Acceptance: immutable prepared adapter outputs reach authorized native tasks;
    current Git-file/inline sources remain unchanged; no arbitrary path resolution.
  - Files: context-artifact seam/schema, resolver, admission binding and tests.
  - Verify: producer/consumer authority, changed digest, bounded read and denial.

Phase B verified: the full 280-file suite completed with two failures; the
packaging test encountered the in-progress module split and the short-deadline
process test failed under concurrent validation. Both passed after the files
were frozen, together with the final artifact and executable-host tests (28
tests in the focused rerun). Seven real Bubblewrap checks pass. Typecheck,
build, lint and formatting pass; independent review found no remaining blocker.

## C. Deterministic orchestration

- [ ] Implement serialized event/cursor pump and atomic plan-intent persistence.
  - Acceptance: compare revision before effects; dedup returns original receipt;
    independent completion intake; bounded no-progress/run budgets; no polling;
    every decision kind persists cursor/state, with inline requests before effects.
  - Files: controller state, event pump, plan admission and tests.
  - Verify: simultaneous/out-of-order facts, stale decision, facts arriving during
    planning, duplicate ID within a plan, decision/intent crashpoints.
- [ ] Implement asynchronous action lanes through the shared native facade.
  - Acceptance: verified B terminal supplies C while A remains held; multiple
    free slots fill without parent inference; adapter outcomes produce events;
    one fenced append boundary, per-lane FIFO with no cross-lane dependency claim.
  - Files: dispatcher/native facade binding, receipt handling and tests.
  - Verify: deterministic A/B/C, last-slot contention, cross-lane independence,
    epoch/late-callback and capacity tests from verification.md.
- [ ] Integrate exclusive controller RoleSession and explicit audit provenance.
  - Acceptance: existing loop alone reduces; no SDK parent/session transcript;
    failure escalates without provider fallback; abort/end/cost-cap close cannot
    resurrect admission; origin enrichment preserves non-SDK logical session IDs.
  - Files: controller session, production spawn/control and lifecycle plumbing,
    in focused slices with tests.
  - Verify: reversible finish gate; typed machine-rejection/guard-retry delivery;
    unsupported steering; typed host-only cap termination before seam validation
    while waiting or planning, reducer-fed end without fabricated capture; abort, cleanup and
    model regressions; audit consumers do not parse controller logs as Pi logs.
- [ ] Integrate resume and operator reconciliation for controller operations.
  - Acceptance: same pinned authority and action namespace; derive missing native
    receipt; no accepted child replay; uncertain ownership/effects block.
  - Files: controller recovery, resume integration, reconciliation command/tests.
  - Verify: every crashpoint in spec §6 and verification.md, including planner
    cleanup then reinvocation, private preparation effects before acceptance,
    explicit repair records, and revocation without authority substitution.

## D. Evidence, delivery, and review

- [ ] Add phase metrics and bounded status with durable source references.
  - Acceptance: separate planner, admission, setup, worker and idle delays;
    no false cross-restart duration or coordinator model usage.
  - Files: controller metrics, status consumers, tests.
  - Verify: fake-clock metrics tests and missing-notification replay.
- [ ] Add generic executable example, migration documentation and public exports.
  - Acceptance: preparation → native delegation → validation → receipt → finish
    works with synthetic workers; repository scheduling responsibility explicit.
  - Files: examples/controller, docs guide, public barrel, example test.
  - Verify: real approved sandboxed planner/adapter JSON stdin/stdout smoke through
    the CLI with synthetic native workers: runtime verification, staging
    publication, delegation, result validation, receipt retrieval and finish.
- [ ] Run independent review and full repository gates, addressing findings.
  - Verify: pnpm typecheck/build/test/lint/format:check/audit; record actual results.
- [ ] Rebuild and verify the linked CLI contains the implementation for testing.
  - Verify: resolve `conduct` to this checkout and run the synthetic example.

Terra owns native execution/lifecycle slices; Luna can own independent protocol,
fixtures and documentation slices once their contracts are agreed. Sol reviews
durability, authority and cancellation after each integrated contract boundary.
Shared-file changes remain serial. No per-phase human approval is required after
the initial spec acknowledgment; evidence and checked boxes gate progression.
