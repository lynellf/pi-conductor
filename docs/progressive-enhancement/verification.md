# Progressive enhancement verification

## Recovery review follow-up — current revision

The overseer's amended §5 now permits bounded recovery after observed foreground
close without claiming descendant cleanup. See `review-follow-up.md` for scope,
RED/GREEN history, three scoped static reviews and deferred platform/workspace work.

Native macOS arm64, Node **25.6.0**, pnpm **10.32.1**: strict typecheck, build,
lint, format check, production audit (no known vulnerabilities), and diff check
passed. Focused final acceptance passed **144/144 tests across 23 files**, including
actual packed-extension execution, known/unknown/late close, timeout/abort budget
and real production model fallback, guard correction and resume, mutation-path
recovery, persistence ambiguity, legacy barriers and enhanced uncertainty mapping.
No full native suite was rerun or claimed green; the earlier 477-failure inventory
remains a limitation, not a reason to skip Linux assertions.

Final local logs: `/private/tmp/progressive-feedback-final-{types,build,lint,format,audit,acceptance}.log`.
Actual full Linux CI **run 979** passed at recovery code commit
**`8da0245bcec4ef25bdfdca73f3ac8f70b4bb7a93`**: **4,547/4,547 tests across
438/438 files**, with frozen install/build, lint and strict typecheck under Node
**22.19.0**, pnpm **10.33.1**. The full suite ran unprivileged, with no platform
skips or weakened enhanced/protected assertions. Job 983 completed successfully;
retained log: `/private/tmp/progressive-feedback-ci-979.log`.

The acceptance/documentation follow-up changes only this file and
`review-follow-up.md`; it does not change the code tested by run 979. Its separate
CI rerun must be observed before claiming final-head CI, but is not substituted
for the complete source-revision result. Earlier runs below verify the initial
implementation, **not this recovery revision**. Initial documentation-only run
973 at `2ad5327` was also confirmed successful during this follow-up.

## Initial PR acceptance (before recovery review follow-up)

Implementation is committed and published in PR #167. **Actual Linux CI run 972
passes all 4,527 tests across 435 files**, plus frozen install/build, lint and
strict typecheck, at code commit `ea47922`. Local feature acceptance is 85/85
across 17 files, including the real packed extension on macOS. Full native macOS
suite is **not green**; see the retained 477-failure run below. The overseer's
subsequent recovery revision is tracked in `review-follow-up.md` and supersedes
this initial all-interruptions-blocked policy; new verification is recorded below. Windows/other
platforms have selection fixtures, not native execution evidence. No merge/release.

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

- Run 972, code `ea47922`: **4,527/4,527 tests, 435/435 files pass**. Frozen
  install/build, lint and strict typecheck also pass under Node 22.19.0. Source and
  private dependency permissions are tightened in this job only; all ownership,
  cleanup and permission-denial assertions remain. No blanket skips or production
  trust relaxations were added. This is real Linux execution, not a native-macOS
  fixture or queued workflow.

Final local gates pass: typecheck/build/lint/format, production audit (no known
vulnerabilities), diff check and 85/85 feature tests. PR #167 is open against main;
#166 remains parked/unmerged. No tool decoupling, dependency/lockfile updates,
server/runner configuration changes, merge or release. The recurring local pnpm
warning remains. No dedicated macOS CI is added.
