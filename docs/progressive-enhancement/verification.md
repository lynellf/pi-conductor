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

Latest local feature acceptance is **85/85 across 17 files**; typecheck, build,
full Biome lint/format, production audit and diff check pass. Native full run:
**477 failed / 4,034 passed / 11 pending**, 432 files, 88 failed files. It predates
later fixture/capability/CLI follow-ups. Direct Linux supervision and protected
backend tests remain nonportable; not every failed case has been baseline
reproduced. Do not call the full macOS suite green or classify every failure as
Linux-only. Three stale capability-record/UI/container expectations were corrected
without weakening ownership/cleanup assertions. Windows/other platforms are
selection fixtures, not native execution evidence.

Actual Linux CI now executes on `docker-build`, Node 22.19.0 and pnpm 10.33.1:

- Run 965 failed lint on generated workspace-local store indexes. External job
  cache selection retains the frozen dependency graph and all lint inputs.
- Runs 966/967 failed workflow validation: runner context is unavailable in
  job-level env. Selection moved to an early step's environment file. An
  intermediate nonexistent host option also failed local typecheck and was
  removed; that failed result is not called verification.
- Run 968: **27 failed / 4,500 passed**, 6 failed / 429 passed files. Protected
  runtime/dependency inventories rejected CI cache/file metadata; the unreadable
  predecessor fixture also depended on a non-root inaccessible absolute path.
- Run 969: **7 failed / 4,520 passed**, 3 failed / 432 passed files. Job-owned pinned
  Node and private dependency copies removed earlier runtime failures; remaining
  protected dependency permissions and root DAC bypass stayed red.
- Run 970 failed because the unprivileged identity could not access pnpm under
  the root home. Its pinned setup destination moved into job temp.
- Run 971: **7 failed / 4,520 passed**, 3 failed / 432 passed files. Permission
  tests now execute unprivileged without skips. Remaining protected *source*
  metadata and an introduced CLI controller-repair filesystem coupling were
  identified. The existing CLI test reproduces RED locally; explicit controller
  repair now retains its independent authority seam, while baseline inspection
  and confirmation barriers remain enforced.

CI corrections tighten job-local modes (never production trust predicates), use
private copies of the pinned Node/pnpm, and run the unchanged full suite under an
unprivileged identity. No shared runner/server settings, system binaries, lockfile
or dependencies are changed. Missing predecessor SDK sessions can open as empty
sessions: separately noted existing behavior, not fixed by this scoped change;
the unreadable test uses an actual non-file source on every account.

A follow-up full Linux run remains the final gate. The recurring local pnpm
warning remains. No dedicated macOS CI is added.
