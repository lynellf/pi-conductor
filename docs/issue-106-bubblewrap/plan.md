# Issue #106 implementation plan

Status: Specification acknowledged on 2026-09-12. Policy, immutable runtime
capture, durable admission, and the production-policy capability probe pass
their focused and real-backend gates. Private command materialization, confined
file tools, validated ingestion, production command execution, and retained
output tools also pass. SDK child wiring and restart integration remain in
progress; delegated command execution remains disabled.
Contract: [spec.md](spec.md). Luna, Terra, and Sol performed independent
configuration, lifecycle, and security investigations. Root coordinates review,
integration, and final verification. No stage requires a separate human review
after the new spec is acknowledged, unless the contract changes.

## Preparation completed

- [x] Read the issue, existing delegation/workspace/execution contracts, and repo rules.
- [x] Map configuration, accepted-submission pinning, child tools, and output gaps.
- [x] Verify the upstream CVE advisory and installed distribution package evidence.
- [x] Inspect pinned Bubblewrap source for status, namespace, and control-FD ordering.
- [x] Reject `--block-fd` as a fail-closed authorization mechanism.
- [x] Finish independent review of the concrete draft and reconcile findings.
- [x] Obtain overseer acknowledgement of the new specification.

## Increment A — policy and pinning (Luna)

1. Add strict manifest parsing/validation and resolved file-only/Bubblewrap policy.
   Scope: new manifest module, profile types, parse/validation wiring, focused tests.
   Acceptance: omission preserves old behavior; malformed and unsupported fields
   fail; writable authority cannot exceed selected projection.
   Verify: focused policy tests, typecheck, lint.
2. Pin canonical policy/runtime identity into accepted submissions before queueing
   and repeat the identity on child start. Update strict durable schemas together
   with the host admission path; retain file-only legacy behavior.
   Acceptance: changed policy changes fingerprint; duplicates/restart cannot
   broaden authority; invalid persisted policy rejects dispatch.
   Verify: submission/restart tests and schema round trips.

Dependencies: acknowledged spec. No child Bash enabled by this increment.

Progress:

- [x] Parse and validate explicit Bubblewrap policy, omission defaults, literal
      environment/runtime paths, writable-path syntax, and output limit.
- [x] Fix fresh-host consumption of the manifest's pinned tool-policy defaults.
- [x] Reproduce and repair both behaviors with focused tests; review PATH authority.
- [x] Add and test the pure writable-authority predicate, including omitted
      tracked/sparse descendants and profile-root restrictions on new files.
- [x] Retain complete tracked metadata in parent capture; prove ordinary and
      sparse-index omissions cannot disappear from writable-authority checks.
- [x] Resolve writable authority against the exact admitted task projection.
- [x] Pin runtime identity and accepted/start records; exercise changed-input restart.

The host-owned admission adapter resolves exact projection authority, copies and
verifies a private runtime, persists metadata, and runs the fixed capability
probe before returning an accepted descriptor. Batch admission rejects an opt-in
without this adapter. Direct SDK child creation remains disabled pending the
execution and file-tool gates; no opted-in profile falls back to file-only.

The authority resolver requires the complete pinned-base tracked path set,
including paths omitted by the parent sparse checkout. A directory cannot cover
any tracked path outside the child's exact selection. Effective profile
allowed/default roots also bound new-file creation: selecting
`src/feature/a.ts` cannot grant `src` when the profile grants only `src/feature`.
With no profile projection policy, the explicit execution writable root defines
the new-file namespace, subject to the same excluded-descendant check. Base
capture and actual file-type validation for command project materialization
remain in increment C. The resolver and admission adapter do not expose Bash.

## Increment B — prerequisite and bootstrap proof (Terra; Sol reviews)

3. Implement read-only patched-build provenance and capability preflight.
   Scope: prerequisite module, version/backport evidence type, focused tests.
   Acceptance: reject this host's current unverified build, setuid binaries,
   missing namespaces/options, and changed binary identity; never install or
   change host security settings.
   Verify: unit fixtures plus inert probe on an authorized patched runtime.
4. Prove the trusted bootstrap release protocol with real Bubblewrap/Node FDs.
   Scope: fixed bootstrap, launcher, status parser, real integration tests.
   Acceptance: EOF, bad token, persistence failure, and host death before release
   never execute the sentinel command; final namespace-init identity is bound
   before release; user code inherits only intended stdio.
   Verify: real tests against the exact supported patched build, including
   startup/final namespace changes and descendant cleanup. A skip is not green.

Dependencies: acknowledged spec and a verified patched test runtime. If the
protocol or its identity proof cannot be implemented as specified, stop this
increment and revise the contract before exposing Bash.

Progress:

- [x] Static prerequisite assessment and exact approved-build binding pass review.
- [x] Obtain operator authorization for the bounded patched-runtime preparation.
- [x] Verify upstream tag/signature binding, build and stage 0.12.0 unprivileged,
      inventory minimal Bash files, and run upstream tests with skips reported.
- [x] Install the protected binary and obtain authorized host namespace access.
- [x] Implement and verify the static filesystem/capability observer against the
      exact host-approved upstream build, including rejection before execution.
- [x] Connect static evidence and the inert production-policy capability probe
      to runtime admission; distribution-backport collection remains unsupported.
- [x] Run the real patched-runtime capability and bootstrap proof.

The admission adapter consumes static observation plus the separately approved
fixed native probe. The probe uses the production mount plan, accepted runtime
snapshot, strict namespace/mount observations, and verified bootstrap.
Production child tools remain gated until C–E are complete.

## Increment C — private execution files (Sol; Terra reviews)

5. Materialize pinned runtime/project inputs and explicit writable subtrees.
   Scope: separate materialization/mount-plan modules and filesystem tests.
   Acceptance: no shared writable inodes, `.git`, private host paths, or hidden
   authority expansion; read-only inputs cannot be replaced through ancestors.
   Verify: input-link/special-file tests, actual bwrap path/write/network denials.
6. Serialize child file tools and commands; reconcile validated regular-file
   changes into the host-owned child worktree using no-follow traversal.
   Scope: child operation gate, safe ingestion, focused tests; harden only Git
   entry points used by the new consumer.
   Acceptance: symlinks/FIFOs/hardlinks cannot cross into host reads or writes;
   denied changes fail visibly; partial execution files stay inspectable.
   Verify: adversarial post-command file-tool and patch-ingestion tests.

Dependencies: A and B. Keep runtime preparation generic; no repository-specific
commands, automatic installation, acceptance policy, or publication logic.

Progress:

- [x] Materialize exactly selected project files into sealed base and independent
      writable copies; bind strict metadata, identities, inventories, and bootstrap.
- [x] Verify actual production mounts preserve private writes between launches
      while rejecting read-only writes and mountpoint replacement.
- [x] Serialize child operations through an owner-scoped gate, including queued
      cancellation, active cleanup, and permanent sealing on uncertainty.
- [x] Implement six confined file tools with descriptor-anchored traversal;
      reject links, special files, changed identities, and unsupported output.
- [x] Bound search execution in a terminating worker with a strict TypeBox
      transport; retain the gate until worker settlement.
- [x] Stage and validate complete bounded deltas before touching the generated
      Git worktree; preserve explicit durable incomplete-application evidence.
- [x] Constrain the new consumer's Git calls to a protected absolute executable,
      captured control identities, raw blobs, and a constructed environment.
- [x] Verify adversarial file access, ingestion, Git, and delegation admission;
      preserve the dispatch guard until D and E pass.

Verification: 233 ordinary test files / 2,528 tests pass on the stabilized C
tree. All 21 real Bubblewrap tests in five files pass against the approved build,
including actual project materialization and production mount construction.
Typecheck, build, repository lint, and production dependency audit pass.
This checkpoint does not expose delegated Bash or establish its output,
cancellation, or restart lifecycle; those remain D/E delivery gates.

## Increment D — execution and output (Terra; Luna assists tests)

7. Extend the correlated execution timeline with sandbox identity observation
   and terminal categories; wire runner settlement into the existing controller.
   Scope: durable schema/timeline, controller seam, runner, focused lifecycle tests.
   Acceptance: start precedes setup; identity precedes release; one terminal;
   ordinary nonzero exit remains a command result; timeout/cancel await cleanup.
   Verify: state-machine/race/persistence-failure tests.
8. Add private output spool, durable references, and child-scoped bounded retrieval.
   Scope: spool module, output schema, retrieval tool, focused tests.
   Acceptance: full retained output after preview truncation, explicit cap/disk
   failure, immutable attribution, no path input or cross-child reads.
   Verify: large-output, truncated-UTF8, storage-failure, and reference-access tests.

Dependencies: A–C and verified bootstrap protocol.

Progress:

- [x] Add strict correlated sandbox start/READY records and namespace/origin
      validation; retain readiness through later terminal materialization.
- [x] Add the generic controller lifecycle seam with durable readiness before
      authorization, cancellation arbitration, and cleanup settlement barriers.
- [x] Verify setup/persistence failures, cancellation at phase boundaries,
      timeout classification, and ambiguous terminal persistence without replay.
- [x] Implement production command pipes with bounded framing, output
      backpressure, exact release/deny, and independent physical draining.
- [x] Verify production pipes against real Bubblewrap, including nonzero status,
      stderr, background output, and the ambiguous normalized status 137.
- [x] Finish reviewed private output persistence and retained-prefix retrieval.
- [x] Obtain the [command status clarification](signal-result-contract-proposal.md).
- [x] Persist normalized status, unknown signal classification, host termination,
      output references, and conservative cleanup in correlated terminal records.
- [x] Implement and verify the complete production runner.
- [x] Verify actual cancellation and output settlement through that runner.

The independent readiness/pipe work does not expose a Bash tool. The controller
accepts a host-owned lifecycle adapter; the production sandbox implementation
and its terminal evidence remain required. Sandbox records are explicitly
excluded from legacy marker-based reconciliation while E is unfinished.

Output storage persists a strict immutable run/child/execution/supervision
attribution before spawn. Its read primitive validates that private metadata
and the retained file digest, including verified prefixes of incomplete capture.
A child can inspect its own earlier command output. The model-facing retrieval
tool, controller terminal output references, and their complete ownership
cross-checks remain part of D/E wiring; the storage primitive is not yet exposed
to models. Capture failure is a one-way notification to the runner, avoiding a
cycle between termination and spool finalization.

The approved result contract now records this clarification: the supported Bubblewrap
status interface maps both an explicit `exit(137)` and SIGKILL to 137. Real tests
confirm the pinned-source finding. The accepted amendment reports this number
and unknown command signal classification, with host-requested cancellation
recorded separately. The overseer acknowledged the amendment on 2026-09-12.

## Increment E — delegated feedback and restart (Luna/Terra; Sol reviews)

9. Expose sandbox Bash/output retrieval only to admitted opted-in children.
   Scope: child tool surface/session wiring and synthetic SDK-session tests.
   Acceptance: a child fixes a failing synthetic test locally and returns an
   inspectable patch; two children do so concurrently without shared mutations.
   Verify: real backend with credential-free provider-driven child sessions.
10. Exercise per-child/global cancellation, host death, and restart/reconciliation.
    Scope: sandbox reconciliation, child disposal barriers, Linux process tests.
    Acceptance: no launcher-only cleanup proof, no replay, no sibling signals,
    and partial files/output survive; unrelated host EACCES is not a universal
    barrier for a positively verified sandbox lifecycle.
    Verify: process-death fault injection at every durable boundary and existing
    admission/ownership/delegation regression suites.

Dependencies: A–D. Do not start a production application campaign as a substitute
for these deterministic and real-backend acceptance tests.

Implementation sequence within E:

- [ ] Thread the operator approval through CLI/extension host factories and bind
      admission to the pinned manifest and host-owned run directory.
- [ ] Create opted-in worktrees with trusted Git, materialize each private project,
      and expose only the confined file tools plus sandbox Bash/output tools.
- [ ] Await child-owned execution settlement on completion/cancellation, ingest
      validated deltas, and inspect completion using the captured Git identity.
- [ ] Add sandbox-specific original-host inspection and explicit cleanup
      confirmation; reject cross-backend cleanup records in timeline validation.
- [ ] Verify one-session repair, independent concurrent children, cancellation,
      host-death recovery, retained output, and zero command replay.

Restart design: inspect only recorded init/launcher identities. Require the
recorded boot and observer namespaces to match the current observer's origin;
the restarted observer itself has a new PID. Missing/reused/settled process
observations alone do not authorize resume. Explicit original-host cleanup
attestation remains necessary, and live or unreadable recorded processes block
confirmation. A start without usable READY remains unknown. Confirmation of a
selected sandbox execution must not trigger legacy marker scans for unrelated
entries; those entries retain their own run-level cleanup barriers. Preserve
unfinalized output without inventing complete capture or replaying commands.

## Final delivery

- [ ] All acceptance boxes in the spec are satisfied with recorded evidence.
- [ ] Cross-model review findings are reconciled; no security blocker remains.
- [x] `pnpm typecheck` and `pnpm build` pass.
- [x] `pnpm test` passes, including core import guards and real sandbox tests.
- [x] `pnpm lint` and `pnpm format:check` pass.
- [x] `pnpm audit --prod` passes; any other advisories are reported accurately.
- [x] User-facing docs and changelog describe actual supported configuration.
- [ ] Rebuilt linked CLI/extension includes the feature; fixture resources settle.
- [x] Changes are committed and the final report distinguishes verified guarantees
      from unsupported platforms, prerequisites, and remaining limitations.

## Foundation verification, 2026-09-12

- [x] Cross-model review of policy, fresh-host pinning, unavailable-backend
      guards, and static prerequisites; required findings repaired.
- [x] Full existing-suite coverage followed by affected packaging/static rechecks.
      The broad run passed 209 files / 2,257 tests. Three packaging suites failed
      during an in-progress source build; after stabilization, those suites plus
      the final prerequisite suite passed all 58 tests in four files. No other
      failures remained. This is not evidence for real Bubblewrap execution.
- [x] Rebuild and smoke-check linked output: legacy defaults resolve to file-only,
      configured sandbox dispatch remains unavailable, and `conduct` resolves
      to this checkout's `dist/bin/conduct.js`.
- [x] Production audit has no advisories. All-dependency audit still reports the
      existing two moderate Vitest/mocker and one low esbuild development
      advisories; no high/critical advisories and no dependency changes.

Implementation commits: `ffa7c91`, `fbe7947`, `6cab9c8`, `4974a09`, `c66c6e5`.
That foundation verification predates the static observer and bootstrap proof
below. Production runtime admission, sandbox output, ingestion, and delegated
command tools remain incomplete. The unchecked feature gates are authoritative.

## Bootstrap verification, 2026-09-12

- [x] Real static-observation, isolation, and bootstrap suites pass together:
      15 tests in three files through `pnpm test:sandbox`.
- [x] Exact release framing rejects EOF, short/bad frames, NUL, extra bytes,
      repeated frames, and persistence failure. Changed copied Bash bytes fail
      before spawn; a missing interpreter never reaches READY or release.
- [x] Startup and final observations bind PID/start/PID namespace, with final
      namespace PID 1 and isolated mount/user/network/IPC/UTS identities.
- [x] Bootstrap child FDs 3/4 are present and FD 5 is absent before release;
      the executed C probe observes no descriptors above intended stdio.
- [x] Host death before release leaves the sentinel absent. Host death after
      release settles the exact init and background descendant identities.
      Tests distinguish missing/reused/zombie processes from namespace-read errors.
- [x] Correlated exit status and drained output settle together; test cleanup
      signals only exact owned identities. These fixtures do not implement
      production restart reconciliation or authorize launcher-only cleanup.
- [x] Full ordinary suite: 216 files / 2,324 tests pass. Typecheck, build, and
      production dependency audit pass; the linked CLI resolves to this checkout.

Additional commits: `3628301`, `4b99567`, `ea331e1`, `6d61092`. The static observer accepts
only separately approved upstream builds; it does not claim its namespace
capability probe ran. The production probe/admission adapter remains unchecked.

## Test-host prerequisite resolved

The system package remains `bubblewrap 0.9.0-1ubuntu0.1`. The operator installed
the reviewed upstream 0.12.0 build separately with the explicit namespace
profile. The installed binary matches the approved digest and protected path
requirements. Real isolation, B4, and the production admission probe now pass;
downstream integration remains incomplete. See [preparation results](test-runtime-results.md) for the
evidence and its limits. Skipped tests do not satisfy any feature gate.

## Admission and production-probe verification, 2026-09-12

- [x] Focused policy/runtime/admission/probe/delegation coverage: 260 tests in
      18 files. Typecheck, build, and repository lint pass.
- [x] Real suites run together against the exact approved build: 20 tests in
      four files, including the actual host adapter's capture and verification.
- [x] Complete regular-file runtime approval prevents unapproved loader/preload
      additions. Capture rejects links and special files; snapshots retain
      independent inodes, are sealed, fsynced, and inventoried again.
- [x] Strict TypeBox metadata, canonical fingerprints, private append-once files,
      bounded descriptor reads, and checked storage ancestry protect admission.
      Accepted/start descriptors match. Duplicate and terminal-replay submissions
      return existing IDs without preparing new authority.
- [x] Snapshot verification survives source changes/removal and rejects changed,
      missing, writable, or malformed retained data before child setup.
- [x] The fixed native probe checks actual nested-userns denial, capabilities,
      descriptors, devices, sentinel/network denial, final namespace identity,
      and the exact mount set, including private `/dev/shm`.
- [x] Production-probe persistence failure and a held pre-ready timeout settle
      the verified init and cannot release later. Diagnostics remain inspectable;
      only verified init identities and the owned launcher can be signaled.
- [ ] Complete C–E and verify the full SDK child repair/restart/output workflow.

Operators approve every file in a prepared runtime, including the native probe
and its dependencies. Conductor neither compiles nor installs runtime inputs
during admission. Operator source and instructions ship under `resources/sandbox`;
compilation in real tests is fixture preparation only.


## Review reconciliation

- Luna clarified exact runtime mapping/digests, source projection, queue-before-
  dispatch pinning, fresh-host manifest use, and durable output ownership.
- Sol's authority findings narrowed runtime mounts to fixed top-level paths and
  environment names to a closed schema. The draft now requires safe file-tool
  adapters, repeated link checks, complete delta validation before host changes,
  explicit partial-application failure, trusted Git invocation, stronger binary
  identity checks, and honest denial-of-service/shared-kernel limits.
- Root's pinned-source check disproved using `--block-fd` as authorization: EOF
  releases it. Terra verified the finding and specified an exact trusted
  bootstrap READY/release protocol, final namespace observation, and required
  runtime proof. Early JSON user-namespace identity is not final identity.
- The unverified distribution package was not used. Real isolation fixtures now
  pass against the separately approved build; production execution and the
  complete feature acceptance remain unchecked.

## Readiness and output checkpoint verification, 2026-09-12

- [x] Full ordinary suite on the stabilized tree: 238 files / 2,610 tests pass.
- [x] Real suites on the approved installed Bubblewrap: six files / 26 tests pass.
      Production command pipes preserve nonzero status and stderr, drain output
      under backpressure, and settle the exact observed namespace init.
- [x] Readiness validation rejects changed correlations, authority, namespace
      identity, and unsafe binary evidence. Setup failures can terminate before
      READY; successful completion requires READY and retains it in the timeline.
- [x] Controller phase/cancellation/persistence races preserve at-most-one terminal
      and prevent release after failed readiness persistence or cancellation.
- [x] Output tests cover partial writes, shared cap accounting, retained-prefix
      reads after restart, large previews, incomplete UTF-8, metadata failure,
      unsafe files, changed bytes, and cross-child reference denial.
- [x] Independent lifecycle and output review findings are reconciled. Private
      attribution supplies persisted ownership; model-facing ownership parameters
      must still be derived from trusted child context during E integration.
- [x] Typecheck, build, repository lint, and production dependency audit pass.
- [x] Approve the command-status clarification.
- [ ] Complete production runner, terminal output references, model tools, and
      E restart verification.

The linked CLI remains a development checkpoint. Its configured sandbox guard
stays active. These checks do not claim the end-to-end child repair workflow or
production sandbox reconciliation has been implemented.

## Production runner verification, 2026-09-13

- [x] Full ordinary suite: 243 files / 2,649 tests pass.
- [x] All real Bubblewrap suites: eight files / 33 tests pass against the approved
      installed build. Nonzero status and stderr remain ordinary repair results;
      later commands observe the retained private changes.
- [x] Controller timeout settles TERM-resistant namespace descendants. Held setup
      cancellation cannot spawn/release later and reports uncertainty until settled.
- [x] Output-cap failure stops the owned command, drains streams, and retains a
      verified readable prefix. Stream-source failure marks capture incomplete.
- [x] Host death before release leaves user-command sentinels absent. Host death
      after release retains partial project/output bytes and immutable attribution;
      reopened logs retain READY without a fabricated terminal or final-output
      metadata. Exact recorded descendants/init/launcher settle in these fixtures.
- [x] Standalone command/output tools enforce child ownership, bounded schemas,
      gate serialization, and cancellation. Ambiguous terminal persistence seals
      the gate before queued file access; errors expose validated output references.
- [x] Independent review findings are reconciled. Cleanup uncertainty dominates
      output and status categories; legacy marker confirmations cannot clear
      sandbox executions. Node signaling uses fresh identity/origin checks and
      retains the documented non-pidfd fallback limitation.
- [x] Typecheck, build, lint, format check, and production audit pass.

This completes D's components. E still owns SDK exposure, cancellable final
ingestion, sandbox-specific operator recovery, and complete child-session tests.
