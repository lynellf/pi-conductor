# Issue #165: supervised execution on macOS

Status: **Acknowledged by the overseer for implementation.** Native safety
feasibility is a gate; dedicated macOS CI infrastructure is deferred.
Authority: issue #165; [FSM specification](../archive/orchestrator-fsm-spec.md)
§§10–12; [approved execution controls](../open-issues-september/spec.md) #75/#76.

## Objective

Make ordinary tool-using pi-conductor workflows usable on macOS without weakening
Linux supervision or reporting uncertain process cleanup as success. Support
`read`, `write`, `edit`, `ls`, `find`, `grep`, foreground `bash`, and bounded
`end_guard` execution. Apply the same ownership boundary to non-sandboxed delegated
file tools and other callers of the shared supervisor. Reject Linux-only features
before a production run admits a role, not after an orchestrator dispatches work.

This is a supervision feature, **not** a macOS sandbox. The existing foreground,
same-host trust model remains authoritative. No claim is made that arbitrary
privileged programs, service-manager activation, or deliberately unmarked
out-of-session workloads can be safely contained.

## Assumptions and approval decisions

1. Ordinary macOS role tools and end guards are required; a macOS replacement for
   Bubblewrap is not. Unsupported sandbox requirements must remain explicit errors.
2. Neither successful command exit nor successful process observation alone proves
   descendant cleanup. Missing, denied, redacted, malformed, or incomplete ownership
   observations remain unknown unless original evidence proves them unrelated or
   the explicitly approved real-UID trust boundary excludes them.
3. **Proposed implementation dependency:** a small packaged native macOS observer,
   built from package-owned source into a private cache using Apple's installed
   Xcode Command Line Tools/full Xcode. No downloaded executable, npm native/FFI
   dependency, Python dependency, root helper, or privilege escalation is proposed.
   A missing toolchain fails preflight with a specific capability diagnostic.
   Approval must explicitly accept this prerequisite; prebuilt release binaries
   would be a separate distribution/supply-chain decision.
4. Initial native verification is on Apple Silicon. Intel support must be exercised
   on an actual Intel macOS host before it is advertised as verified. The macOS
   version support range must likewise be recorded from real verification, not
   inferred from one host or an API's availability annotation.
5. The overseer approved matching Linux's **real-UID** foreground trust boundary.
   Unknown-marker candidates with a freshly observed different real UID are outside
   that same-account scan; positive markers still win. An effective-UID change alone
   never exempts a same-real-UID setuid process. Group/session settlement still
   observes all members. Privileged out-of-session and service activation remain
   unsupported; this is not cross-UID containment.
6. No execution policy, timeout/retry allowance, model selection, reducer legality,
   workspace confinement, or manifest-pinning behavior changes.

## Investigation and evidence

Baseline: v0.22.1, commit `00f09c8c795836d579df73122537dcefe0f9257e`.

- `src/host/execution/supervised-process-contract.ts` permits only `linux`.
  Direct execution of its capability function on the development Mac returned
  `{ "platform": "darwin", "supervised": false }`.
- `production-host-spawn.ts` rejects all seven executable tools on other platforms;
  `production-host-context.ts` and `end-guard-runner.ts` similarly gate end guards.
- `supervised-process-identity.ts` discovers groups and escaped marker-bearing
  descendants through Linux procfs. Cleanup, durable admission, and operator
  reconciliation also depend on that observation context. Widening the platform
  predicate is insufficient.
- A temporary, warning-clean native probe on macOS 26.5.2/arm64 successfully read
  process-group metadata, `ri_proc_start_abstime`, and `kern.bootsessionuuid`.
  A Node child inherited the execution marker and exposed it to observation.
- The same probe spawned `/bin/sleep` with the marker. `KERN_PROCARGS2` succeeded
  but returned **no environment entries and no marker**. Apple kernel source
  explicitly omits environment variables for restricted processes in applicable
  security configurations. An absent marker must not automatically mean unrelated.
- These probes establish API feasibility and a negative case only. They do **not**
  establish supervision, safe termination, global-scan completeness, or recovery.
  The temporary probe is not product code and is not included in the package.

Relevant boundaries and source anchors:

- `src/host/execution/{supervised-process*,tool-admission.ts}`: live ownership,
  admission, deadline/abort arbitration, output, and cleanup.
- `src/persistence/tool-admission.ts`: Linux-only v1 durable observation origin.
- `src/host/execution/tool-execution-{resume,reconciliation}.ts`: restart barriers
  and explicit operator confirmation; reconciliation never kills or replays work.
- `src/host/{end-guard-loop,end-guard-runner}.ts` and
  `src/persistence/end-guard.ts`: start-before-spawn, terminal-before-end, guard
  budgets, and conservative unfinished-attempt handling.
- `src/host/controller/local-effect-runtime.ts`: additional shared-supervisor
  consumer; requires marker and session observations during recovery.
- `src/host/execution/sandbox/`: separate Linux/Bubblewrap observation and
  confinement boundary, not a portable fallback.

## Design contract

### 1. Separate process observation from platform-neutral lifecycle ownership

Keep one lifecycle owner for deadline, abort, terminal arbitration, and cleanup.
Introduce a narrow internal platform observation boundary rather than duplicating
all tool controllers or substituting a promise timeout. Linux retains its procfs
backend and current ownership rules; macOS gets its own backend.

The backend must provide bounded identity, process-list, group/session, marker,
and original-origin observations. All callers, including controller local-effect
recovery, must use the correct backend. Do not leave Linux-only observations behind
an expanded `darwin` capability predicate.

macOS observations must:

- Use native process metadata, not rounded `ps` start dates or command-line matches.
- Retain PID, high-resolution boot-relative start identity, current group/session,
  process state, and the minimum identity-only origin needed for recovery. Keep
  64-bit time values as validated decimal strings, never lossy JavaScript numbers.
- Verify identity around multi-call metadata/marker observations. PID reuse,
  exec/session transitions, and disappearance are distinct from permission denial.
- Distinguish complete marker absence from unavailable/redacted marker evidence.
  A successful `sysctl` with omitted environment is **not** complete absence.
- Enumerate completely or fail closed; retry bounded sizing races and reject
  truncation. Never interpret a capped result list as exhaustive.
- Retain separately validated real and effective UIDs. The denied/redacted marker
  scan matches Linux's real-UID boundary; do not substitute the effective UID or
  apply this exclusion to owned group/session settlement or positive markers.
  Recheck both credentials around native observations; incomplete metadata is not
  an exemption. Effective UID still governs native visibility/time representation.
- Preserve existing original-evidence exclusions for genuinely unrelated
  processes without adding exemptions by executable name, Apple signature,
  current PPID, current service association, or a new recovery-time baseline.
- Return sanitized identity/status results only. Process arguments and environments
  may be examined privately but must never enter protocol output, records, error
  messages, debug logs, or persistent files. Pass markers privately, not in argv.

**Feasibility gate (first):** before enabling macOS, prove an implementable distinction
between complete and redacted marker observations and demonstrate ordinary
foreground-command success with SIP enabled. Exercise at least 40 ordinary
commands on the development desktop and report every false-uncertain outcome.
Public candidates are `proc_pid_rusage` (raw Mach start ticks), `getsid(pid)`,
`KERN_PROC_PID`, and bounded `KERN_PROCARGS2`. An environment truncated at argv
is unknown, not absent; no `csops`/private-header dependency is approved. Original,
freshly reverified pre-existing session identities can support the existing live
session exclusion; a current PPID, unrelated-looking group, or merely old session
leader cannot independently authorize an exclusion. File tools come first, then
bash/end guards; both share this global-scan feasibility requirement. If available native interfaces cannot
establish this safely, stop and revise the design; do not infer completeness from
an empty environment or enable a weaker backend. Native APIs outside the supported
SDK require an explicit documented compatibility decision, not silent reliance.

### 2. Preserve supervised execution and cleanup semantics

Each executable has a unique owned supervision identity and a finite original
wall-clock deadline. Preserve start-before-spawn ordering and any caller-requested
stdin-release barrier. Abort and timeout have one cleanup owner and one terminal.
Process observation, admission, and mutation-lock waits consume the existing
budget; progress/output never resets it.

Authorize a group signal only after freshly verifying the admitted leader's
identity and ownership. If the leader is gone, signal only individually reverified
owned members; do not authorize a negative-PGID kill from a historical PID.
Retain graceful termination, bounded escalation, post-termination group settlement,
and escaped-descendant checks. Confirmed cleanup requires all required observations
to settle; an observation failure, surviving escaped descendant, or helper failure
cannot produce a successful result.

Account for restricted Apple executables when admitting a shell leader. If a
trusted marker-visible supervisor/keeper is needed, it must stay owned until the
workload and cleanup settle, propagate real exit/output outcomes, and have tested
crash/parent-disconnect behavior. Such a keeper does not itself prove detached
children are gone; native descendant observation remains mandatory.

Workload signal outcomes must not be re-raised in the Node keeper: Node ignores
SIGPIPE by default and reserves SIGUSR1 for inspector activation. Use a bounded,
closed private terminal-status frame and disable SIGUSR1 inspector activation in
the keeper. Missing, malformed or oversized status cannot establish workload
success; deadline, abort and cleanup arbitration remain supervisor-owned.
Sources: [Node signal behavior](https://nodejs.org/download/release/v22.19.0/docs/api/process.html#signal-events),
[the inspector-disable flag](https://nodejs.org/download/release/v22.19.0/docs/api/cli.html#--disable-sigusr1),
and [child close ordering](https://nodejs.org/download/release/v22.19.0/docs/api/child_process.html#event-close).

No detached/background workloads become supported. A foreground command can still
activate an external service; preserve the existing conservative uncertainty
behavior. No automatic tool replay, edit rollback, fallback after unknown cleanup,
or poisoned-mutation-lock release is introduced.

### 3. Persist platform-specific admission without changing historical meaning

Retain the exact Linux v1 admission contract. Add a separately versioned,
strict TypeBox macOS admission shape containing an explicit platform/backend,
original boot/observer context, identity-time representation, and original
pre-launch evidence. The implemented v2 draft preserves original session-leader
identities with explicit Mach/wallclock representations as well as the same-user
Mach boundary; recovery freshly reobserves witnesses, never replaces them.
Never synthesize Linux namespace strings for macOS.

Do not compare Linux start ticks with macOS identity values or wall-clock record
timestamps. Recovery validates origin before using original age/identity exclusions;
a reboot, foreign origin, malformed evidence, unknown backend, or unavailable
observation refuses confirmation. Legacy Linux records remain Linux records and
must not be reinterpreted on a Mac. Existing absent-evidence records retain their
conservative recovery path; they do not acquire a replacement baseline.

Tool reconciliation remains leased, append-only, explicit, and observation-only.
Live owned processes or uncertain observation block `--confirm-cleanup`; absent
markers alone are not independent proof of unmarked-descendant cleanup. Preserve
operator attestation and partial-effects inspection requirements. Diagnostics must
name the platform, representation of `start_time`, and failed capability rather
than suggesting nonexistent `/proc` paths on macOS.

End guards retain start-before-spawn and terminal-before-accepted-end ordering,
primary-checkout execution, bounded output, retry budgets, and cost-cap bypass.
An unfinished or cleanup-unconfirmed guard continues to block resume before host
construction. This change does not introduce automatic guard replay or promise a
new operator-repair command for historical unresolved guard records. If enabling
any new guard recovery path becomes necessary, specify its durable evidence and
explicit acknowledgment separately before implementing it.

### 4. Preflight the complete configured production workflow

Production CLI and extension start/resume must check required capabilities before
role/model execution or workload effects. Check top-level roles, the end guard,
and referenced delegated profiles/other executable paths, not just the initial
orchestrator's tools. Resume checks the pinned manifest, not replacement YAML.
Keep static manifest validity separate from runtime host capability; pure manifest
validation must not import pi or perform OS inspection. Custom/stub hosts retain
their existing deterministic testing seam.

Report which role/profile/feature requires the missing capability. Distinguish:
ordinary supervised macOS execution, missing/incompatible native observer or
permissions, and Linux-only Bubblewrap/kernel-namespace features. A required
Linux-only feature fails specifically before dispatch; never fall back to ordinary
unsandboxed execution, remove tools, or skip an end guard.

Probe the installed developer directory without triggering Apple's toolchain
installation dialog before invoking any compiler shim. The observer cache lives
under a per-user 0700 directory; validate the arm64 linker signature and account
for kernel architecture separately from Node/Rosetta architecture. Rosetta is not
advertised until tested. Extract the existing oversized supervisor/identity
modules by responsibility as part of the backend boundary, not as an unrelated
cleanup.

The native observer cache is host-owned, canonical, private, versioned by packaged
source/protocol and architecture, and validated before use. Reject unsafe paths,
symlinks, changed artifacts, wrong architecture/protocol, partial compilation,
and concurrent cache-publication ambiguity. Compiler/setup subprocesses are bounded
trusted setup operations with their own owned settlement; backend preparation must
not recursively depend on an already-prepared backend. No automatic toolchain
installation, network download, or security-setting change is permitted.

## Project structure and style

Implementation belongs in small `src/host/execution/` backend modules, with packaged
native source in a dedicated `resources/` directory, additive pure schemas in
`src/persistence/`, production capability integration, and platform-aware CLI
observation diagnostics. Tests belong in `tests/host/`, `tests/persistence/`,
`tests/bin/`, and packed-package fixtures. Keep pi imports out of the pure core.

Reuse the existing Node >=22.19.0 ESM runtime, TypeScript, Vitest, TypeBox, Biome,
and pinned Pi SDK (0.80.6 development baseline), plus the proposed native C observer.
Use strict TypeScript, named exports, no `any`, and the repository module-size
limits. Prefer explicit typed observations, for example:

```ts
type MarkerObservation =
  | { readonly state: "present" }
  | { readonly state: "absent"; readonly visibility: "complete" }
  | { readonly state: "unknown"; readonly code: string };
```

This illustrates the completeness boundary, not an approved public API. Native code
must build warning-clean, validate every length/result, and bound allocations.

## Verification and acceptance

Use Vitest contract tests plus real OS subprocess and packed-extension tests. Mocked
`darwin` values on Linux do not establish macOS support. Linux procfs-specific tests
remain Linux-specific; shared behavior tests run on both supported backends. Do not
turn meaningful failing coverage into blanket skips.

- [x] Inspect issue #165, controlling specs, production gates, shared callers,
  persistence, reconciliation, and real macOS identity/marker feasibility.
- [x] Overseer acknowledges this spec and its native-toolchain prerequisite;
  dedicated macOS CI runner setup is explicitly deferred.
- [ ] Feasibility gate passes for native visibility, identity, enumeration, and
  foreground commands with SIP enabled; independent safety review completed.
- [ ] Real macOS role workflow reads/writes/edits and exercises all six file tools
  plus foreground bash through the production/packed extension path.
- [ ] Success/nonzero exit, silent/CPU hang, pipeline, abort/timeout races,
  TERM-resistant children, leader exit, and admission callback failure settle
  with one truthful terminal. Verify no late writes after confirmed cleanup.
- [ ] A live detached descendant, including a restricted Apple executable with
  redacted environment, cannot be reported as success or confirmed cleanup.
- [ ] Denied/redacted/incomplete observations, helper failure, identity reuse,
  session changes, and unrelated siblings do not cause blind signals or false
  cleanup confirmation. Real fixtures always clean their own test processes.
- [ ] End-guard pass/failure/timeout/abort and uncertain-cleanup cases preserve
  budgets, pending end requests, terminal ordering, and forced-close semantics.
- [ ] Crash/restart, origin mismatch, original admission restore, malformed/legacy
  evidence, blocked resume, and explicit tool reconciliation pass on macOS;
  unresolved guards remain blocked. No ambiguous effect is replayed.
- [ ] Non-sandboxed delegated file tools and shared local-effect recovery are
  exercised; required Bubblewrap/controller sandbox features fail preflight
  explicitly on macOS before role work or command effects.
- [ ] Native-cache/package tests cover missing compiler, invalid observer,
  unsafe cache paths, bounded setup failure, and installed package resources.
- [ ] Linux regression gates remain green; macOS verification is repeatable in
  CI or a documented native runner. Intel/version-range claims are evidence-backed.
- [x] Update `README.md`, `docs/execution-controls.md`, `docs/end-guard.md`, and
  relevant diagnostics/changelog to describe the verified support boundary.

Commands after implementation:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm exec vitest run tests/host/supervised-process.test.ts tests/host/end-guard-runner.test.ts tests/host/end-guard-resume.test.ts tests/packed-file-tools.test.ts tests/packed-bash-supervision.test.ts
pnpm lint
pnpm format:check
pnpm audit --prod
git diff --check
```

Add explicit native macOS backend suites and a bounded crash/escaped-descendant
fixture before implementation acceptance. Native CI configuration is an approval
deferred by the overseer; the current workflow runs only on Ubuntu. Repeatable
native tests on the development Mac are the macOS acceptance gate for this issue.

## Implementation acceptance status

Acceptance remains open. Native integration covers packed file tools/bash, guards,
actual CPU hangs, timeout/abort cleanup, admission, cache safety, and explicit
reconciliation. Before real-UID alignment, strict global screening of
post-admission foreign-UID restricted processes rejected ordinary commands: a
40-command campaign completed 39 and reported one cleanup-unconfirmed observation;
a preceding campaign reported two. Some warmed campaigns completed all 40.
Do not discard that history, turn failures into skips or advertise the backend
as accepted.

The overseer approved Linux's existing **real-UID** trust boundary for denied
marker observations, not an effective-UID shortcut. Native metadata and the closed
protocol now retain both UIDs, and regression tests retain same-real-UID setuid
uncertainty and all group/session members. The unchanged desktop campaign completed
40/40 after this change. A first broader native run passed 126/127 tests, with
an uncertain guard timeout. A shared time-representation bug was then reproduced
and fixed; the final focused native run passed 149/149 tests. Packed bash still
reported uncertain observation, and a full native suite completed with 332 failed
tests; failure triage remains incomplete. The earlier failures remain part of the
verification history, not erased by green subsets. See [verification notes](verification.md).
The peer-reviewed keeper signal defects were reproduced and fixed with native
regressions. The draft-checkpoint focused run passed 241/241 tests across 31 files,
including a 200-command scoped-churn campaign. Packed bash passed six subsequent
runs without reproducing the earlier candidate; its root cause remains open.
Linux runtime regression verification and remaining independent safety reviews
are also pending. The overseer authorized a commit/push/draft PR checkpoint, not
merge, release, or acceptance based on passing native subsets.

## Boundaries

- **Always:** preserve original logs/workspaces; verify fresh ownership before
  signals; await owned cleanup; keep uncertainty observable; run real native
  safety tests and Linux regressions before advertising support.
- **Ask first:** acknowledge this new spec, native-toolchain/distribution choice,
  reliance on non-public native interfaces, new dependencies, CI changes, or a
  new guard-reconciliation contract.
- **Never:** remove platform gates without verified capability, disable SIP,
  elevate to conceal denied observations, infer ownership from a name/PID alone,
  silently replace Bubblewrap, rewrite legacy evidence, or report a test skip as
  native verification.

## Official sources

Checked against the installed Apple SDK and Apple's published kernel source:

- [libproc declarations](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.h)
  and installed SDK `libproc.h`: process enumeration and native observations.
- [Process metadata](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h):
  BSD state, group and identity fields; distinguish public SDK from private flavors.
- [Public sysctl metadata](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/sysctl.h):
  `e_pcred.p_ruid` is real UID; `e_ucred.cr_uid` is effective UID. The installed
  SDK agrees, and `fill_user64_eproc` fills these from independent credential getters.
- [Resource metadata](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/resource.h)
  and [implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_resource.c):
  `ri_proc_start_abstime` and its native representation.
- [Process observation implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c):
  permissions, vanished processes, and identity-query constraints.
- [sysctl implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c):
  `sysctl_procargsx` environment redaction and `kern.bootsessionuuid`.

Published upstream `main` sources explain behavior, not a guarantee for all macOS
versions. Record the actual SDK/OS versions and pin relevant source revisions when
finalizing the native implementation and its support matrix.
