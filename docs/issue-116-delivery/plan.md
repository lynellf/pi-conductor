# Controller child outputs and authorized delivery (#116)

Status: implemented and verified locally on 2026-09-16. Issue #116 supplies the requested behavior
and acceptance criteria; this plan records implementation decisions under that
scope. The user requested Terra/Luna/Sol implementation and autonomous completion.
The FSM spec §§10–12 and controller contracts from #115 remain authoritative.

## Scope and boundaries

Implement two separable additions: host-published native child outputs, followed
by opt-in operator-authorized integration and delivery. Repository code still
owns task choice, review semantics, validation, CI gates, and publish policy.
The existing host alone owns admission, persistence, execution, and closure.
No new coordinator inference, scheduler, unrestricted agent shell, implicit
credentials, fabricated approval, live delivery, or paid model is required.

The output path exports actual selected bytes and an attributable base-bound
patch after authoritative native settlement. Outputs are immutable, bounded,
and tied to the accepted child/task, pinned definition, base, terminal identity,
and consumer authority. A completion status is not approval. Native siblings
continue while publication or delivery is pending.

The delivery route keeps repository executables sandboxed. A fixed approved
adapter produces a closed request; a narrow host effect broker enforces the
operator's repository/ref/network/credential grant. The broker records prepared
intent before applying Git or network changes. Credentials never enter the
planner, native-worker context, adapter runtime, ordinary artifacts, or diagnostic
messages. An uncertain remote outcome requires reconciliation before another
attempt; local journaling does not provide exactly-once network semantics.

## Concrete output contract

- New child artifacts use versioned identities distinct from adapter-action
  artifacts. Existing v1 adapter artifacts and old manifests remain readable.
- Pinned per-profile output policy selects exact relative report paths and
  patch authority. Planner actions may request permitted selections but cannot
  broaden consumer grants. Reject traversal, symlinks, hardlinks, unexpected
  outputs, changed bytes during capture, and unsupported worktree identities.
- Bound one report to 128 KiB, one patch to 512 KiB, and one child publication
  to 16 outputs / 1 MiB. Oversize is an explicit failure, never truncation.
- Authorize every byte read using its actual principal: controller, native
  profile, adapter, or effect. Private evidence can exclude the controller.
  Opaque references may be routed without granting byte access.
- Source selection, accepted base, terminal identity, content digest/size/media,
  and audience are immutable. Publication is durable before ready events.
- Raw terminal/result reads must not bypass private-output restrictions.
  Derived outputs cannot silently widen the audience of private inputs.
- Recovery uses immutable published bytes or an explicit unresolved failure;
  it never reruns a child to recreate evidence.

## Ordered implementation slices

### A. Native output boundary

- [x] A1: Implement immutable v2 child-output storage and principal authorization.
  - Files: new child-output store/contract helpers and focused store tests.
  - Accept: exact binding, immutable bytes, deterministic recovery, bounded reads.
  - Verify: corruption, wrong identity, unauthorized consumer, oversize, and
    publication-crash tests; typecheck.
- [x] A2: Pin bounded output declarations and durable collection records.
  - Files: output schema, controller configuration/approval, persistence records
    and timeline validation, in successive small slices.
  - Accept: no response-created grants; legacy formats retain their meaning.
  - Verify: closed-schema and chronology tables; grep guard.
- [x] A3: Collect the validated settled child delta and selected source files.
  - Files: native output collector, settlement hook, focused real Git fixtures.
  - Accept: capture follows cleanup and precedes the authoritative terminal;
    publication follows that terminal. Capture checks source identity and exact
    base/delta; no mutable worker path is exposed as an input.
  - Verify: byte mutation, path escape, unexpected files, and recovery failures.
- [x] A4: Wire per-child ready events and consumer-aware resolution.
  - Files: event projection, dispatcher/ref resolver, native artifact admission,
    adapter input/output publication, in successive verified slices.
  - Accept: B's bytes reach an authorized reviewer while A runs; controller and
    unrelated worker reads cannot disclose private evidence or launder it.
  - Verify: gated native scheduling and confidentiality integration tests.

### B. Authorized effects

- [x] B1: Define exact operator grants, broker requests, and effect journal.
  - Files: effect contract/registry, approval pinning, persistence validation.
  - Accept: implementation/schema/effect/scope digests are pinned; wrong or
    revoked authority rejects before effects; credentials remain host-only.
  - Verify: grant mismatch/revocation and malformed-history tests.
- [x] B2: Integrate reviewed patch artifacts in isolated owned Git state.
  - Files: Git effect implementation and local-repository tests.
  - Accept: ordered overlapping patches produce an exact integrated head or
    explicit conflict; combined validation is bound to that head.
  - Verify: wrong base/repository, overlap/conflict, source mutation, and crash.
- [x] B3: Add narrowly scoped promotion and authenticated remote delivery.
  - Files: broker transport, credential reader, result/reconciliation helpers.
  - Accept: only the registered repository/ref/reviewed head is publishable;
    missing evidence denies; remote outcomes distinguish success, non-application,
    and uncertainty without blind replay or implicit approval.
  - Verify: controlled fake service, credential canaries, pre/post-request crash,
    exact remote object identity, and postcondition checks.
- [x] B4: Connect effect lanes, closure, and recovery to controller operation.
  - Files: executable adapter completion, dispatcher, production assembly,
    recovery/reconciliation, in successive small slices.
  - Accept: conflicting ownership serializes; slow CI/delivery leaves native
    intake and successor dispatch live; abort/revocation stop new effects.
  - Verify: gated delivery plus successor children, late callbacks, ambiguous
    persistence, and restarted effects without duplicate native admission.

### C. Delivery evidence

- [x] Add a complete example, approval migration guide, supported-case limits,
  and measured output/integration/delivery latency.
- [x] Run independent adversarial reviews; address correctness/security findings.
- [x] Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
  `pnpm format:check`, and dependency audit. Record actual evidence.
- [x] Rebuild and confirm the linked `conduct` resolves to this checkout.

## Verification posture

Use real local Git repositories, synthetic/gated native children, and a controlled
fake delivery endpoint. Tests prove boundaries with actual bytes and durable
records rather than transcript scraping or child-reported hashes. Prefer new
small modules; no SDK imports in the pure core. Shared contract files have one
writer at a time. Each completed slice is checked before the next dependent slice; the integrated
implementation and operator documentation are recorded as separate local commits.

Terra implements storage/native-output slices; Sol implements effect boundaries.
Root owns integration and verification coordination. Independent reviews focus
on authority, confidentiality, source identity, and crash ordering. No live
external service writes are part of verification.

A1/A3 verified with 26 focused store/capture tests, scoped strict TypeScript,
Biome, and independent adversarial review. Input bytes are copied before awaits;
reads use anchored bounded descriptors; publication checks its activation fence
immediately before rename. Combined-path review and follow-up adversarial review are complete; findings
were repaired and regression-tested. Final whole-repository gates follow below.


## Final verification

- `pnpm test`: 3,203 tests passed across 318 files (307.85 seconds).
- `pnpm typecheck`, `pnpm build`, `pnpm lint`, and `pnpm format:check`: passed.
- `pnpm audit --prod`: zero advisories; no dependencies were added.
- Real Bubblewrap controller workflow and preflight: 3 tests passed against
  the final built CLI. The local `conduct` symlink resolves to this checkout's
  `dist/bin/conduct.js`; the rebuilt privileged implementation inventory measures
  all three supported effects successfully.
- The delivery smoke uses actual immutable outputs, independently reviewed
  overlapping patches, exact-head source validation, and a controlled authenticated
  endpoint. A successor is admitted and completes before delivery is released.
  Measured local fixture latency: output 961.157 ms, integration 685.196 ms,
  delivery 295.551 ms. These measurements are not production latency guarantees.
- Production integration tests exercise real Git promotion, result publication,
  and recovery through a newly constructed effects factory without another mutation
  or settlement. Cross-activation output recovery retains original sealed bytes
  after the former worker path changes.
- Independent Terra/Sol reviews covered output identity and audience confinement,
  grant and implementation pinning, Git/HTTP authority, evidence provenance,
  persistence ambiguity, and recovery. Findings were repaired and tested, including
  record-ref routing, legacy terminal compatibility, and transitive example audiences.

The example YAML is a request-graph template; its repository-specific chooser
executables must be supplied and approved by the operator. The runnable acceptance
policy is the no-model delivery smoke. External publication and paid campaigns
were not performed. See [operator guide](operator-guide.md) for configuration,
endpoint requirements, and supported-case limits.
