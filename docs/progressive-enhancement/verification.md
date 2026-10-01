# Progressive enhancement verification

## Current work

Design and implementation are authorized by corrected overseer direction.
Branch is based on main at `00f09c8c795836d579df73122537dcefe0f9257e`;
no code is taken from the parked native-observer draft #166.

## Shared supervisor fixes

- RED: three deterministic failures before correction: overflowing timer passed
  to Node, group observation exception bypassing cleanup, global observation
  exception bypassing cleanup. `/private/tmp/progressive-shared-red.log`.
- GREEN: chunked deadlines in admission and settlement, shared cleanup attempted
  before rejecting observation uncertainty. Focused 37/37 across four files;
  strict typecheck and diff check pass. These use synthetic identities/process
  transports and are not native Linux execution evidence.
- Initial focused run: 35/37. Two cleanup-diagnostic fixtures fell through their
  exhausted one-shot mocks into actual `/proc` reads on macOS. Both reproduced
  at exact main in a detached temporary worktree (11/13); the worktree was
  removed. Completed the mocks with a persistent false group result, preserving
  all ownership/signal assertions. No production cleanup predicate was weakened.
- Timer coverage includes rearming at 2,147,483,647 ms, cancellation after rearm
  and long unobserved-identity admission. No 30-day command was launched.

## Feature verification and decisions

- Closed portable/strict policy, table-driven host detection (including unusable
  Linux), required backend preflight, handoff-only/unused-profile behavior, strict
  TypeBox records and in-memory/file-backed round trips are covered.
- Native production-host baseline exercises write/edit/read/bash, legal handoffs
  and actual end guard. Capability record and stderr notice precede model requests.
  Nominal calls resume after an unrelated model failure; timed-out calls reject
  resume before a new host is created.
- Native packed **real extension**, loaded through public `DefaultResourceLoader`,
  executes the same four tools, two handoffs and actual successful guard on macOS.
  It records baseline tier and `not-guaranteed`; no enhanced tool starts occur.
  Standalone packed test passes. Earlier probe failures were fixture peer export
  resolution, nonexistent public `loadExtensions`, missing UI stub method and
  wrong log directory; preserved in local logs rather than called acceptance.
- Additional RED/GREEN: baseline cancellation must seal admission before pending
  work settles; unexpected direct foreground signal cannot become nominal success;
  reconciliation CLI cannot hide an interrupted baseline execution or accept an
  acknowledgment override. Staged Bubblewrap/unused-profile preflight revisions
  also had two deterministic RED cases. Actual failed guard, timeout/closed retry,
  missing executable, bounds, admission deadline and abort are covered natively.
- Focused shared/feature/package run initially 78/79 because of the packed fixture
  log-directory mistake; packed test subsequently passes. Separate latest
  cancellation/signal/CLI/guard/process/shared checks are 17/17 across five files.
  Final combined counts and full-suite results will be recorded below.

## Review

Fresh-context read-only `openai/gpt-6.1-sol` static review reports no material
findings **within supplied scope**: baseline process/controller/records,
capabilities/admission and tracked host/manifest/persistence diff. It ran no tools
and explicitly did not review three extracted options/adapter/policy files.
Those small modules were inspected locally; adapters preserve previous SDK bridge
behavior. CLI visibility and extra tests followed the review. Jev advice is not
proof or acceptance. Linux runtime verification remains a separate gate.

## Remaining gates

CI label matches the observed registered `docker-build` label; no server changes.
Native full suite is running; actual Linux CI execution and final quality gates
are pending. The recurring pnpm override-sync warning remains; dependencies and
lockfile have not been modified. Windows/other platforms are detection fixtures,
not native execution evidence. No dedicated macOS CI is added.
