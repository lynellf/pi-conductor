# Issue #111 — Workspace preparation evaluation

This experiment evaluates existing sandbox behavior before choosing a permission
API. It changes no production code or narrow-profile semantics. The user approved
evaluating a reusable broader profile first.

## Ordered experiments

1. [x] Verify an unchanged profile across two real sandbox delegation batches:
   concurrent independent children, failed verification and repair, later new
   files/test requirements, and explicit parent integration. Include more than
   64 materialized files in the broader snapshot.
2. [x] Compare the same deterministic work with a representative narrow selection.
   Record setup, dispatch, verification, and integration time separately. These
   are mechanics measurements, not evidence of model productivity.
3. [x] Run a bounded model comparison on an isolated workload with the same model
   and task criteria, retaining failed attempts and stating measurement gaps.
4. [x] Document reproducible configuration, authority/new-file/runtime constraints,
   measured results, and the smallest justified next step.

## Reuse the existing broader profile

For an operator-approved project snapshot, omit both the profile's
`workspace.projection` block and each task's `projection_paths`. The child then
inherits the clean parent's materialized files. A sparse parent still limits that
set. Merely setting `default_paths: [src, tests]` does **not** accomplish this:
profile defaults expand to at most 64 exact files, just like explicit task
selections. See [projection authority](delegation.md#projection-aware-child-authority-issue-52).

For example, add this profile to an existing valid manifest and include
`project-worker` in its parent role's `delegation.allowed_subagents`. Give that
parent a finite child allowance of at least four and `max_parallel: 2` for two
batches of two workers. The runtime and host approval must already satisfy the
[Bubblewrap prerequisites](delegation.md#bubblewrap-command-sandbox-issue-106).
Paths below are relative to the manifest directory where applicable.

```yaml
subagents:
  - name: project-worker
    models: [{ model: openai-codex:gpt-5.6-terra, effort: high }]
    max_session_cost_usd: 2
    system_prompt: project-worker.md
    completion_protocol: minimal
    execution:
      backend: bubblewrap
      runtime_root: prepared-runtime
      writable_paths: [src, tests]
      network: none
      environment:
        PATH: /usr/bin:/bin
        LANG: C.UTF-8
      max_output_bytes: 8388608
    tool_execution:
      timeout_seconds: 90
      termination_grace_seconds: 5
      max_recoverable_timeouts: 2
```

A suitable `project-worker.md` describes focused edits, meaningful verification,
inspection of `read_execution_output` after failures, repair and rerun, and an
honest final report of evidence and remaining gaps. The task packet identifies
the objective, likely files, and verification command. Those hints guide attention;
the admitted snapshot and write roots enforce authority. Do not put secrets in
that snapshot: tracked files are not automatically classified as safe to disclose.
Keep narrow profiles when disclosure or context constraints require them.

Use the same profile for later tasks whose dependencies or tests differ. The
parent reviews each attributable child diff, explicitly integrates accepted work,
and commits a clean baseline before the next batch. Siblings have private
materializations even when their permitted write roots overlap. Integration still
needs conflict and semantic review; successful child verification does not perform
that review for the parent.

Existing constraints still apply:

- Writable directories must have selected tracked descendants at admission and
  cannot contain excluded tracked descendants. New files beneath an admitted
  writable directory are supported; a completely new empty output root is not.
  Prepare an approved tracked descendant before dispatch when that root is needed.
- Dependencies and tools belong in the separately prepared, inventoried runtime.
  A broader source snapshot does not provide host `node_modules`, credentials,
  network access, or a dependency installation path. Put disposable test outputs
  in sandbox temporary storage or an admitted writable root.
- Git control files, sibling workspaces, and private host evidence remain outside
  child authority. The host checkout and control files must meet admission's
  ownership and mode requirements. The fixture creates private temporary repos;
  it does not repair permissions on a user's source checkout.
- Explicit/default projections retain the 64-file limit. Inherited snapshots
  avoid that particular limit, but larger snapshots still cost preparation and
  validation time. Output limits, command timeouts, cost caps, and child allowances
  remain finite; completing a batch does not refund child slots.
- This configuration uses existing admission and resume contracts. Accepted child
  identities and authority are pinned; changing the parent later does not widen
  an already accepted task. This experiment does not exercise a process restart
  through `resumeRun` and makes no new resume guarantee.

## Reproduce the mechanics check

The executable fixture is
[`bubblewrap-workspace-cycles.real.ts`](../tests/host/bubblewrap-workspace-cycles.real.ts).
With the existing real-sandbox test prerequisites prepared, run:

```sh
PI_CONDUCTOR_BWRAP="$APPROVED_BWRAP" \
PI_CONDUCTOR_BWRAP_SHA256="$APPROVED_BWRAP_SHA256" \
PI_CONDUCTOR_BWRAP_RUNTIME="$APPROVED_BASH_RUNTIME" \
pnpm exec vitest run tests/host/bubblewrap-workspace-cycles.real.ts \
  --config vitest.sandbox.config.ts
```

This uses the existing test fixture's Bash runtime contract, not an arbitrary
application runtime. It runs real sandbox commands with a deterministic stub
model. The parent introduces a later dependency and check script between batches;
these are scripted discoveries, not autonomous model discoveries. Every worker
writes an incorrect result, inspects its failing command output, repairs it, and
passes verification. The parent checks changed paths and contents before copying
and committing the chosen edits. No new runner or scheduler is introduced.

One sequential comparison on 2026-09-14 produced:

| Measurement | Broader snapshot | Narrow selection |
| --- | ---: | ---: |
| Materialized files, first / second batch | 83 / 85 | 58 / 60 |
| Initial fixture setup | 0.249 s | 0.247 s |
| Admission, first / second batch | 1.135 / 0.847 s | 0.617 / 0.553 s |
| Child lifecycle span, first / second batch | 1.231 / 1.340 s | 1.302 / 1.372 s |
| Command verification, aggregate across both batches | 2.271 s | 2.457 s |
| Entire blocking delegation, both batches | 26.851 s | 18.626 s |
| Parent review and integration, both batches | 0.032 s | 0.036 s |
| Later dependency/test preparation | 0.009 s | 0.010 s |
| Verified, explicitly integrated fixture edits | 4 | 4 |

Command time is summed across overlapping workers, not an additive wall-clock
phase. Admission and child spans are contained in delegation time, which also
includes preparation and settlement. Parent review is a scripted assertion, not
human or model review. Timing varies between runs; this single ordered pair is
not a statistically controlled speed comparison. It establishes feasibility and
shows that broader materialization has costs, rather than proving higher useful
work throughput. A final verification rerun with lifecycle-count assertions also
passed both modes; total delegation was 34.308 s broad and 28.061 s narrow,
further illustrating timing variation.

## Bounded model feasibility sample

The isolated application sample uses two public compiler feature contracts from
an identical prepared Git tree in each mode, with Terra at high effort. The broad
mode uses one reusable profile and 574 inherited files; the narrow mode retains
the existing two profiles and 63/62 exact task paths. Both use the same approved
2,217-file runtime (269.5 MiB), focused test commands, two concurrent workers,
$4 per-child cost cap, and five-minute batch deadline including preparation.
Existing lane write permissions differ from the broader directory write roots;
this compares the complete configurations, not just one isolated variable.

The harness uses the production delegate factory, scheduler, admission adapter,
and child sessions. It records lifecycle and command records, session transcripts,
terminal evidence, elapsed time, and provider usage. Model requests use the host's
existing provider authentication; credentials are not materialized in the child.
Inputs and runtime bytes are copied into private experiment directories, with
identical clean input trees checked before dispatch. The original application
checkout and campaign are untouched. Host Git preparation must preserve protected
control-file modes. An initial harness ESM import error and a rejected temporary
Git index mode were corrected before workers started; setup failures were retained
and are not counted as model work.

This is a first-pass feasibility sample. It does not establish accepted work per
hour over a sustained campaign: that requires completed work, independent review,
integration and later discovery cycles, with preparation and remediation costs
included. The executable stub fixture above covers the repeated sandbox mechanics
separately. Neither a passing fixture nor a child terminal label substitutes for
acceptance of the application change.

The bounded pair on 2026-09-14 ended as follows:

| Measurement | Broader snapshot | Narrow selection |
| --- | ---: | ---: |
| Accepted batch to first child start | 98.559 s | 19.270 s |
| Total dispatch through cancellation cleanup | 300.099 s | 305.088 s |
| Assistant turns, both workers | 50 | 64 |
| Provider usage cost estimate, both workers | $1.273 | $2.592 |
| Completed and independently accepted patches | 0 / 2 | 0 / 2 |
| Integrated patches | 0 | 0 |

Both pairs reached the deadline below their cost caps. Cancellation retained
failure records and marked the worktrees invalid; no cancelled output was
integrated. The deadline interrupted narrow verification, whose cleanup took
approximately five additional seconds. No projection or write-authority denial
was observed in either mode. Source inspection and editing were possible, and
focused tests executed inside the real sandbox.

The broader run first encountered absent `ls`/`sed` utilities. Its zone worker
reached the intentionally failing placeholder test. Its equip worker introduced
schema refinements incompatible with downstream `.omit()` calls, inspected that
error, and attempted repair before cancellation. This was a patch error, not
proof of a baseline runtime incompatibility. The narrow run also had failed
commands and ambiguous edit replacements, and remained incomplete. These are
real preparation/implementation costs, but they do not identify an authority gap.

This ordered pair has no accepted work with which to compare useful throughput.
Initial manual workload/runtime preparation and review time were not instrumented
as end-to-end phases, so the table must not be presented as a complete campaign
benchmark. Provider cost estimates exclude the outer investigation and review.
There was no completed application patch to independently verify and integrate;
that work is deferred, not credited as zero-cost acceptance. Reusing an already
prepared narrow manifest also excludes its original construction cost. Cache,
run order, differing authority sets and model variation prevent a causal claim
from the preparation-time difference alone.

## Decision and next step

Keep the existing broader configuration as an explicit operator choice. The real
fixture proves repeated batches with an unchanged profile, evolving files,
verification repair, private siblings and selected parent integration. No new
permission API is justified by this sample. Dynamic task write subsets would not
resolve the observed command assumptions, patch errors or preparation delay.

Issue #111's sustained accepted-work comparison remains open. Use a smaller,
independently verifiable semantic slice for the next application experiment,
state the runtime's available commands in both worker prompts, and allocate a
window that leaves time for independent verification and integration. Measure
initial setup and review as well as dispatch, alternate run order, and repeat
through a later discovery batch before comparing accepted work per hour. Inspect
the existing preparation phases to explain the observed delay before proposing
an optimization. Retain narrow profiles for workloads that require their smaller
disclosure boundary.

## Verification

The dedicated real-sandbox test passes both modes. The ordinary suite passes
2,745 tests across 256 files. Typecheck, build and lint pass;
production dependency audit reports no known vulnerabilities. The broader audit
also reports two moderate and one low development-tool advisories, with no
high/critical findings. No dependencies changed. The linked CLI resolves to this
repository's rebuilt `dist/bin/conduct.js`; there are no production behavior
changes to activate.
