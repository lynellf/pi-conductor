# Issue #106 implementation plan

Status: Prepared for spec acknowledgement; implementation has not started.
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
- [ ] Obtain overseer acknowledgement of the new specification.

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

## Final delivery

- [ ] All acceptance boxes in the spec are satisfied with recorded evidence.
- [ ] Cross-model review findings are reconciled; no security blocker remains.
- [ ] `pnpm typecheck` and `pnpm build` pass.
- [ ] `pnpm test` passes, including core import guards and real sandbox tests.
- [ ] `pnpm lint` and `pnpm format:check` pass.
- [ ] `pnpm audit --prod` passes; any other advisories are reported accurately.
- [ ] User-facing docs and changelog describe actual supported configuration.
- [ ] Rebuilt linked CLI/extension includes the feature; fixture resources settle.
- [ ] Changes are committed and the final report distinguishes verified guarantees
      from unsupported platforms, prerequisites, and remaining limitations.

## Current blocker to real execution verification

The installed package is `bubblewrap 0.9.0-1ubuntu0.1`, with no verified fix for
the required setup-traversal CVE. No replacement was installed and no namespace
settings were changed. An authorized patched test runtime is required for B4
and every real sandbox acceptance gate; unit tests alone cannot mark them done.


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
- No real sandbox guarantee was verified on this host. The vulnerable/unverified
  installed package was not used, and no acceptance box for implementation or
  runtime verification is marked complete.
