# Progressive enhancement for host execution

Status: design record; end-to-end implementation authorized by the overseer's
corrected direction. This replaces the proposed native macOS observer direction
in #165 / #166. That draft remains reference only; none of its observer, keeper,
compiler/cache or private-API work is imported here.

## 1. Objective and scope

pi-conductor is a context-handoff state machine, not an OS sandbox. Ordinary
shared-workspace workflows must work wherever Pi and Node work. Preserve today's
Linux supervision as an enhancement; provide explicitly weaker, bounded execution
on other hosts. Never weaken a manifest-declared security requirement.

Decisions authorized to the implementer: baseline recovery policy, strict-policy
shape, host detection and visible degradation. No further human approval stops
are required for this work. Merge/release and tool decoupling are not in scope.

Assumptions: the existing Pi public tool factories, Node executable and writable
run/session directories are available. Missing essential SDK/file-system support
is a genuine startup error, not an OS enhancement to pretend is available.

## 2. Capability inventory and boundaries

Detection belongs in `src/host/execution/`, before any role/model work, and examines
all roles and enabled profiles, not just the starting role. An OS name alone does
not establish usable Linux observation: check the current process's procfs,
identity/credential interfaces and admission-origin files. Probes do not execute
model commands, download tools, install software or expose environment values.

| Feature | Enhanced guarantee and detection | Portable baseline / requirement |
| --- | --- | --- |
| FSM, handoff/end validation, visit/cost caps, context, records | Existing pure contracts; no OS probe | Unchanged on every host; no reducer changes |
| Shared `read/write/edit/ls/find/grep` | Public SDK worker, deadline, verified descendant cleanup; procfs plus packaged worker seam | Same public SDK worker and bounded output/deadline; best-effort cancellation only |
| Foreground `bash` | Existing detached Linux supervision, marker/identity observations, owned TERM/KILL and settlement | Plain Node spawn; POSIX process-group TERM/KILL where possible, child termination elsewhere; no descendant-cleanup proof |
| Durable tool admission and reconciliation | Existing boot/namespaces/original evidence and existing schemas | Separate baseline start/terminal records, no fabricated admission witness, no `cleanup_confirmed` |
| `end_guard` | Durable attempt, bounded output and confirmed supervised cleanup | Execute the declared command and enforce its deadline; record baseline tier and `not-guaranteed` cleanup; do not omit the guard |
| Bubblewrap delegated commands/verification | Explicit pinned sandbox policy and existing approval, probe, namespace and protected-file checks | Unavailable without the existing Linux backend; explicit requests fail preflight, never ordinary spawn |
| Repository controller, local effects, privileged Git/remote effects | Controller ownership/approval plus protected descriptors, trusted Git and supervised effects | Unavailable on non-Linux hosts in this change; an explicit controller fails preflight, even if its first step looks portable |
| Delegation, exact/snapshot child authority and child cancellation | Existing protected Git/artifact admission, original child authority and cleanup contract | Non-Linux delegation is unavailable in this change: its protected `/proc/self/fd` and settlement dependencies cannot be replaced by weaker reads. Declared delegation fails preflight, not silently removed |
| Worktree/copy role workspaces and file confinement | Existing Git snapshot/projection and path checks, public RPC tools | Preserve confinement and selected backend; use baseline file workers. Missing Git/backend support is an error, never switch to shared/unconfined execution |
| Container workspace / container shell | Already unavailable backend | Still explicit preflight failure on every host; not an implicit enhancement |
| Artifact collection, progressive disclosure, sparse Git | Existing checked roots, limits and required external programs/options | Keep checks; do not loosen trusted Git/descriptor predicates. Detectable unsupported explicit configurations fail, runtime dependency failures remain errors |
| Optional repository evidence / advisory enrichment | Existing bounded evidence and advisory semantics | Existing unavailable-evidence reporting remains; no new privilege or tool implementation |
| RPC, telemetry, CLI/extension | Public SDK and normal Node file/process APIs | No native observer/CLT dependency; headless and UI warnings both supported |

"Any OS" does not mean every existing opt-in backend works on every OS. In
particular, protecting delegated/controller authority is not an optional cleanup
improvement. This is a deliberate narrower boundary than treating all unsandboxed
child execution as portable. Tool decoupling/consumer-supplied companion tools are
recorded as future direction only.

## 3. Tier selection and required features

Two execution tiers: `enhanced` and `baseline`. Capability detection selects the
tier once per production host admission, and records that selection. Linux with
usable observation keeps its existing execution path and record meaning. A Linux
host without those capabilities may select baseline for an ordinary workflow;
strict or dependent configurations must reject. Runtime observation/persistence
failure after enhanced admission is never a reason to retry under baseline.

Add a host-only manifest policy (closed keys, pinned in the existing snapshot):

```yaml
execution_policy:
  mode: portable  # default when absent; alternatively strict
```

`strict` rejects any requested executable tool or guard that would be baseline.
A handoff/end-only run does not require enhanced process support. Explicit
sandbox, controller, delegation or unavailable workspace requirements reject
independently of this mode. A configured timeout remains enforced on baseline;
its presence alone is not a requirement for proved descendant cleanup.

The parser/validator remain pure: they validate the closed policy shape, never
inspect the OS. It is not added to MachineDefinition.

## 4. Visible degradation and durable meaning

Before any model request, persist `execution_capabilities` with schema version,
run ID, platform, selected execution tier, and bounded stable degradation codes.
Show the same degradation before role work through the current UI when available
and stderr in headless/library operation. A missing UI must not hide the warning.
The notice names what remains and what is lost: bounded foreground execution,
no confirmed descendant cleanup, no automatic command replay and blocked resume
following uncertain execution. Resume re-detects and emits a fresh observation;
it never rewrites the historical execution tier.

Enhanced tool records retain their exact historical schemas and cleanup meaning.
Baseline tools use separate strict TypeBox `baseline_execution_started` and
`baseline_execution_finished` records with run/logical/physical session and call
identity, deadline/elapsed time, execution tier and outcome. Persist a start
before side effects and exactly one terminal. Cleanup is always `not-guaranteed`;
no arguments, environment, raw output or guessed process identity is persisted.
End-guard records gain an additive explicit baseline tier and `not-guaranteed`
cleanup combination, checked for consistency. Absent tier remains historical
enhanced semantics; legacy passed guards still require confirmed cleanup.

Normal baseline completion permits the next tool/transition without pretending
the descendant set is empty. A successful guard establishes exit-zero only under
the recorded baseline contract. Timeout, abort, transport/persistence uncertainty
seals admission and stops the invocation. No timeout-recovery allowance can
justify another attempt with potentially live prior work.

## 5. Baseline lifetime and recovery decision

Use isolated SDK workers instead of promise-racing in-process file mutations:
a blocked SDK call cannot retain the host event loop or mutate indefinitely in
it. Process deadlines include admission time, are checked at terminal claims,
and use bounded timer chunks (Node overflows delays above 2,147,483,647 ms).
Output remains bounded; stdin errors are handled. On cancellation attempt group
termination while the live child handle is available on POSIX, and direct-child
termination elsewhere. Settle within a finite grace/force window and detach
streams if descendants keep them open. Never signal a recovered numeric PID or
claim that a missing process proves cleanup.

Resume options considered:

1. Continue from checkpoint: simplest, but may overlap a still-running side effect.
2. Explicit acknowledgment override: makes uncertainty visible, but would need a
   new operator-authority record/API, and is not ownership or cleanup proof.
3. Block unresolved baseline work: safest small feature-detection change.

**Decision: option 3.** An unmatched baseline start, or terminal timeout/abort/
transport uncertainty, blocks resume and replacement before any model/tool work.
Ordinary durably completed/failed calls permit checkpoint resume. There is no
baseline reconcile-tools proof or acknowledgment override in this change. The
operator inspects partial effects/survivors and may intentionally start a new run;
the old execution never becomes `cleanup_confirmed`. This trades interrupted-run
convenience for avoiding automatic ambiguous re-execution.

Enhanced unresolved records retain the existing reconciliation requirement even
when resumed on a baseline host. Changing OS cannot reinterpret old records.

## 6. Shared fixes and CI

First fix the two pre-existing Linux supervisor bugs in an independent commit,
with deterministic RED tests: overflowing admission/settlement timers, and the
close-observation exception branch that fails without attempting shared cleanup.
Keep cancellation precedence and single cleanup ownership. Do not import the
Darwin transport. Follow with feature detection and baseline implementation.

CI's registered runner offers `docker-build`, not `ubuntu-latest`. Change the
workflow scheduling label only as needed to reach that runner; preserve frozen
pnpm install, Node 22.19.0 and lint/typecheck/full tests. If the runner's default
image cannot execute those actions, use an explicit Linux CI job container rather
than modifying server infrastructure. Actual CI execution, not queueing, is the
Linux regression evidence.

## 7. Implementation structure and conventions

Keep `src/core/` untouched. Pure policy in `src/manifest/`, strict record schemas
in `src/persistence/`, host detection and baseline process/controller helpers in
`src/host/execution/`. Route shared and isolated role tools consistently. Preserve
existing Linux sandbox/controller modules; do not port their trusted filesystem
contracts. No dependencies/lockfile changes, native builds or private APIs.

Follow strict TypeScript, named exports, TypeBox, small single-purpose modules
and Biome. For example, select a backend explicitly rather than swallowing its
failure and retrying:

```ts
const execute = tier === "enhanced" ? runSupervisedProcess : runBaselineProcess;
```

## 8. Verification and acceptance

Commands: `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm format:check`,
`pnpm test`, `pnpm audit --prod`, `git diff --check`. Focused Vitest tests live in
`tests/host/`, `tests/manifest/`, `tests/persistence/`; packed coverage lives in
`tests/packed-progressive-enhancement.test.ts`.

- Deterministic RED/GREEN coverage for both shared bugs; one cleanup promise and
  cancellation/observation-error settlement remain covered.
- Table-driven detection/preflight tests: Linux available/unavailable, Darwin,
  Windows and other platforms; all-role/profile scanning; strict policy,
  required backend rejection and pure handoff-only workflows.
- Baseline real subprocess success, spawn failure, output bounds, hangs,
  abort/deadline races, no automatic replay and truthful terminal records.
- Strict record validation and file-log round trips, crash starts and timed-out
  terminals blocking resume, normal completion resuming, and enhanced legacy
  records never acquiring baseline meaning.
- Native macOS packed-extension E2E: ordinary tools and a legal handoff/end,
  visible and durable baseline selection, bounded guard success/failure and
  timeout stop. No CLT/compiler/observer dependency.
- Existing Ubuntu/Linux full regression executes on CI with no weakened Linux
  assertions. macOS cannot turn Linux-only runtime tests into Linux evidence.

Always preserve pinned manifests, durable-before-effect ordering, bounded
records and warnings. Never claim stronger cleanup than the selected backend,
weaken explicit security, silently switch workspaces, replay ambiguous work,
modify server infrastructure, merge #166 or start tool decoupling.
