# Issue #119 — Parent task packet (resolved contract + dispatch cards)

This packet records the contract the orchestrator resolved before any
child dispatch and the task cards each child lane must execute. It is
the source of truth for what each child writes and what the parent
integrates. The shared design narrative remains
[`docs/issue-119-source-bridge/plan.md`](../plan.md) (already committed
at `afb89a1`).

## Stable IDs

- Issue: `#119` — "Source-workspace-to-integration bridge and aggregate quota"
- Plan doc: `docs/issue-119-source-bridge/plan.md`
- Provenance lane: `provenance-worker`
- Quota lane: `quota-worker`
- Branch: `feature/bubblewrap-execution-spec`
- Base commit: `afb89a1` (clean)

## Shared objective

Close two public-contract gaps left by #116/#118:

1. Real child patch captured at synthetic source head S inside a sealed
   source workspace must be independently approved and integrated onto
   canonical integration base B through public APIs **without rewriting**
   the original base, source ref/head/tree/inventory, exact patch
   bytes/digest, allowed paths, audience, or approval evidence. The
   bridge must verify S as a sealed parentless synthetic identity in the
   bounded Git view and reconstruct the canonical B→S prefix inside
   isolated canonical state, never by reaching S from B in the canonical
   repository (S is not an object there).
2. Aggregate source-workspace storage approval has an independent
   safe-integer bound large enough for ordinary multi-snapshot
   reservations (the issue's 3.515625 GiB example must be accepted) while
   preserving conservative reservation math, retained failed/uncertain
   accounting, fail-closed admission, and recovery. Diagnostics must
   state required vs approved bytes.

## Authoritative invariants (already locked in plan.md)

### A. Source-workspace descriptor (extended)

`PreparedSourceWorkspace` gains five new immutable fields:

```ts
readonly repositoryRef: string;            // intent.requested_ref (e.g. refs/heads/main)
readonly repositoryFingerprint: string;    // intent.repository_fingerprint
readonly allowedPaths: readonly string[];  // source grant's allowed paths, pinned at prep time
readonly patches: readonly SourceWorkspacePatchLineage[]; // immutable source patch chain
readonly patchesDigest: string;            // canonical digest of `patches` (no private bytes)
```

`SourceWorkspacePatchLineage` carries `{ ref, sha256, byteLength,
acceptedBase, allowedPaths }` per patch. `patchesDigest` is
`sha256Canonical(patches)` over the public lineage (no patch bytes, no
private source path). The bridge uses the lineage for identity
verification only; it never re-resolves patch bytes from this record
(those still come from the controller-output store and are independently
verified).

The bridge does **not** read `sourcePath`; it uses `checkoutPath` only
to run `git rev-parse HEAD` / `git rev-parse HEAD^{tree}` against the
bounded view to verify the sealed S identity. The host resolves
`authority.grant.repository.canonical_path` for canonical operations.

### B. `gitIntegrateRequestSchema` extension

Adds one optional sibling field
`source_workspace_descriptor?: SourceWorkspaceDescriptor` carrying the
opaque workspace ref + the full immutable source patch lineage. The
descriptor is purely additive; legacy callers (no
`source_workspace_descriptor`) keep the current
`patches[*].base_commit === accepted_base` rule unchanged. The schema
digest for the request remains the **existing**
`effectRequestSchemaDigest("git_integrate")`.

### C. `assertEffectRequestInScope` rule extension

When `source_workspace_descriptor` is present:

- `descriptor.base_commit === request.accepted_base`
- `request.patches.length === 1`
- `request.patches[0].base_commit === descriptor.head_commit`
- `request.patches[0].evidence[*].subject_digest === request.patches[0].sha256`
- The effect principal `{ kind: "effect", effect_id: authority.grant.id }`
  is present in `descriptor.audience`.
- `request.integration_ref` does not start with
  `refs/pi-conductor/source-prefix/`.
- `descriptor.allowed_paths` intersects
  `grant.allowed_source_paths` is non-empty.

When absent, the legacy rule set applies unchanged.

### D. Bridge function `integrateGitEffectFromSourceWorkspace`

Peer of `integrateGitEffect`, not a wrapper. Re-exported through
`src/host/index.ts`. Re-exported inputs (no optional widening; the
bridge never inspects private source bytes):

```ts
interface SourceIntegrationOptions {
  readonly authority: PinnedEffectAuthority;
  readonly request: GitIntegrateRequest;            // MUST carry source_workspace_descriptor
  readonly workspaceRoot: string;
  readonly resolvePatch: (claim) => Promise<ResolvedGitPatch>;
  readonly resolveSourceWorkspace: (ref: string) => Promise<PreparedSourceWorkspace>;
  readonly publishSelectedSource: (source) => Promise<{ ref; sha256 }>;
  readonly persistPrepared: (prepared: GitEffectPrepared & { sourceWorkspace?: ... }) => Promise<void>;
  readonly assertEffectOpen?: () => Promise<void>;
  readonly assertOpen: () => void;
  readonly signal?: AbortSignal;
}
```

Bridge flow throws typed `SourceIntegrationError` carrying stable
codes: `authority-mismatch`, `descriptor-base-mismatch`,
`descriptor-revoked`, `descriptor-sealed-tampered`,
`integration-ref-in-source-prefix`, `audience-denied`,
`bridge-reconstruction-mismatch`. Steps in plan.md §"Bridge function".

The bridge uses **staged tree** verification (`git write-tree` after
`git apply --index`) for pre-child reconstruction. `git rev-parse
HEAD^{tree}` is never used for pre-child verification because `HEAD`
still names B after `git apply --index`.

### E. `GitEffectPrepared` postcondition extension

The `gitPrepared` portion of `controllerEffectPreparedSchema` gains
optional `source_workspace` sibling carrying the bridge descriptor
reference (opaque ref + immutable source-patch chain digest). When the
bridge fills it, `assertPostcondition` re-verifies the B→S lineage at
reconciliation time. Legacy records (no `source_workspace`) keep the
existing postcondition assertions unchanged.

### F. `gitIntegrateResultSchema` extension

Adds one optional field `source_workspace_descriptor?` carrying the
opaque workspace ref + immutable source-patch chain digest. The
descriptor on the result does **not** carry private bytes or
`repository_canonical_path`.

### G. Reconciliation contract

`reconcileGitEffect` and the `ControllerEffectSettledRecord` outcome
stay read-only. Recovery never replays an uncertain canonical write.
`reconcileGitEffect` accepts the extended postcondition (it already
operates on the existing fields and ignores the optional
`source_workspace` sibling).

### H. Aggregate quota

`sourceWorkspaceAggregateBytes(grant): number` exported from
`src/manifest/controller-source.ts`. Returns
`perWorkspace * grant.max_workspaces` with safe-integer validation.

`validateSourceRepositoryGrant` rejects grants whose aggregate
reservation is not a safe integer with
`source repository grant aggregate reservation is unsafe`.

Capacity predicate in `production-sources.ts` retains conservative
reservation math. When admission fails, the error message becomes:

```
source workspace storage reservation exceeds approved limits: required <N> bytes, approved <M> bytes
```

Where `<N>` is the exact `(reserved + 1) * sourceWorkspaceReservationBytes(...)`
and `<M>` is `grant.max_total_bytes`. When the aggregate itself is not
a safe integer, the diagnostic prefixes the same line with
`source repository grant aggregate reservation is unsafe: `.

## Recovery boundaries

- The bridge is a recovery boundary: it never re-runs the canonical
  CAS-update. After `persistPrepared`, the source workspace, descriptor,
  and any resolved patch bytes stay untouched.
- Uncertain canonical writes are observed only, never replayed.
- The bridge does not retry a failed reconstruction: a
  `bridge-reconstruction-mismatch` means S is no longer reproducible
  from the bounded view; the operator must create a fresh source
  workspace. The bridge never silently re-derives S.

## Disjoint projection (already committed in plan.md)

The two lanes write disjoint paths and can run in parallel after their
shared contract is fixed.

Provenance-lane writes:
- `src/host/controller/source-workspace-contract.ts` (extend `PreparedSourceWorkspace`)
- `src/host/controller/source-workspace-store.ts` (extend `read` to return new fields)
- `src/host/controller/source-workspace-service.ts` (return extended descriptor in `open`)
- `src/host/controller/source-workspace-validation.ts` (verify new descriptor fields)
- `src/manifest/controller-effect.ts` (extend `gitIntegrateRequestSchema` + `gitIntegrateResultSchema`)
- `src/host/controller/effect-registry.ts` (extend `assertEffectRequestInScope`)
- `src/host/controller/git-effect.ts` (add `integrateGitEffectFromSourceWorkspace`)
- `src/persistence/source-workspace.ts` (extend `sourceWorkspaceContentSchema`)
- `src/persistence/controller-effect-records.ts` (extend `gitPrepared` postcondition)
- `src/persistence/controller-effect-timeline.ts` (extend `assertPostcondition`)
- `src/host/index.ts` (re-export bridge)
- `tests/host/controller-git-effect-source-bridge.test.ts` (new bridge tests)
- `tests/host/controller-git-effect.test.ts` (extend with bridge integration)
- `docs/issue-119-source-bridge/README.md` (new public docs)

Quota-lane writes:
- `src/manifest/controller-source.ts` (`sourceWorkspaceAggregateBytes`)
- `src/host/controller/production-sources.ts` (capacity predicate + diagnostic)
- `tests/manifest/controller-source.test.ts` (aggregate tests)
- `tests/host/controller-source-capacity.test.ts` (aggregate tests)
- `tests/host/controller-production-sources.test.ts` (aggregate tests)
- `docs/issue-118-source-workspaces/README.md` (aggregate + diagnostic note)

Parent-only writes:
- `CHANGELOG.md` (bridge + aggregate entries)
- `docs/issue-119-source-bridge/plan.md` (integration mapping)
- `src/host/controller/effect-broker-execution.ts` (dispatch into bridge when `source_workspace_descriptor` is present)
- `src/host/controller/effect-broker-contract.ts` (extend `EffectBrokerExecutors` with `integrateFromSourceWorkspace?`)
- `src/host/controller/effect-broker.ts` (resolve executor)

No write overlap between lanes.

## Parent-owned verification

After both lanes return:

1. Integrate both lanes' diffs; resolve any cross-file conflicts.
2. Wire the bridge into `effect-broker-execution.ts` so a `git_integrate`
   request with `source_workspace_descriptor` calls
   `integrateGitEffectFromSourceWorkspace` instead of `integrateGitEffect`.
3. Update CHANGELOG.md and plan.md integration mapping.
4. Run focused tests for each lane.
5. Run full `pnpm typecheck`, `pnpm build`, `pnpm test`,
   `pnpm lint`, `pnpm format:check`, `pnpm audit`, `git diff --check`.
6. Write a public no-model end-to-end test
   (`tests/host/controller-git-effect-source-bridge.public.test.ts`)
   that exercises B→S→child patch→approval→canonical B integration
   twice in succession with real patch bytes, real evidence, and verifies
   the original repository was never mutated between batches.
7. Run the new public test; record the exact command + result.
8. Run real Bubblewrap source-workspace tests if the approved runtime is
   available; otherwise record that the gate was skipped.
9. Commit separately: bridge + tests, quota + tests, parent wiring, docs.
10. Hand off with exact changed files, task card/result records,
    integration mapping, verification evidence, residual risks, and the
    next action.

## Public no-model two-successive-batch test contract

Required parent-owned test (parent-owned; provenance-lane writes the
test scaffold only if requested in its task card; otherwise parent
writes the whole test):

For each of two successive batches:

1. Set up a real local Git repository with a real `B` commit (a base
   file `src/value.txt` containing the original text) and create a
   child worktree off `B`.
2. Create a synthetic source workspace S at `B+child_patch_1` (first
   batch) or `B+child_patch_2` (second batch) via the existing
   `createSourceWorkspaceService` machinery. The `child_patch_*` are
   real patch bytes applied against the bounded view's synthetic root.
3. Create a real child patch `child_patch_*` against `S` that targets a
   disjoint path so the integrated prefix reconstruction is observable.
4. Build a `GitIntegrateRequest` with
   `source_workspace_descriptor` populated and a single patch whose
   `base_commit` is `S.head_commit`. Resolve the patch through a real
   `resolvePatch` that hashes the bytes and returns them.
5. Build a `PinnedEffectAuthority` from a real
   `measureGitEffectRepository()` measurement.
6. Call `integrateGitEffectFromSourceWorkspace` and assert the
   resulting `integratedHead` equals what
   `git_commit_tree` would produce against the reconstructed prefix.
7. After each batch, re-read the original repository and assert:
   - `HEAD` still names `B`
   - the working tree is unchanged (real `git status --porcelain` empty)
   - `src/value.txt` still contains the original text.
8. Between the two batches, re-open the same source workspace via
   `SourceWorkspaceStore.read` and verify the extended
   `PreparedSourceWorkspace` fields (`repositoryRef`,
   `repositoryFingerprint`, `allowedPaths`, `patches`, `patchesDigest`)
   match byte-for-byte.

The test must use real patch bytes, real evidence, real Git, and
real bounded-view verification; no mocks for these.

## Dispatch cards (children must satisfy exactly)

### provenance-worker

- **Stable ID**: `provenance-worker`
- **Objective**: Implement the source-patch-to-canonical-integration
  bridge and focused tests.
- **Profile**: Implementation worker; no model calls; real local Git.
- **Projection paths** (assigned writes):
  - `src/host/controller/source-workspace-contract.ts` — extend `PreparedSourceWorkspace` with `repositoryRef`, `repositoryFingerprint`, `allowedPaths`, `patches`, `patchesDigest`.
  - `src/host/controller/source-workspace-store.ts` — extend `read` to populate new fields from the stored manifest; recompute `patchesDigest` on publish.
  - `src/host/controller/source-workspace-service.ts` — extend `open` and `prepare` so the returned `PreparedSourceWorkspace` carries the new fields; the published manifest records them.
  - `src/host/controller/source-workspace-validation.ts` — `verifySourcePatch` and helpers verify the new descriptor fields.
  - `src/manifest/controller-effect.ts` — add `sourceWorkspaceDescriptorSchema` and the optional `source_workspace_descriptor` field on `gitIntegrateRequestSchema` and `gitIntegrateResultSchema`.
  - `src/host/controller/effect-registry.ts` — extend `assertEffectRequestInScope` with the source-bridge rule set when `source_workspace_descriptor` is present.
  - `src/host/controller/git-effect.ts` — add `integrateGitEffectFromSourceWorkspace(options)` as a peer of `integrateGitEffect`.
  - `src/persistence/source-workspace.ts` — extend `sourceWorkspaceContentSchema` (or new sibling schema) with `allowed_paths` + `patches_digest` so the persisted prepared record retains the lineage.
  - `src/persistence/controller-effect-records.ts` — extend the `gitPrepared` postcondition union with optional `source_workspace`.
  - `src/persistence/controller-effect-timeline.ts` — extend `assertPostcondition` to accept the optional `source_workspace` sibling.
  - `tests/host/controller-git-effect-source-bridge.test.ts` — new bridge tests (forged mappings, reconstruction mismatch, audience mismatch, integration-ref namespace, descriptor re-validation, bounded-view tampering).
- **Write ownership**: provenance-lane only.
- **Expected output**: Diff with the above files; new bridge function and tests; documentation stub for `docs/issue-119-source-bridge/README.md`.
- **Dependencies**: None; can run concurrently with quota-worker.
- **Parent verification**: After return, parent will run focused tests then full repo gates.

### quota-worker

- **Stable ID**: `quota-worker`
- **Objective**: Implement the independent aggregate quota bound, actionable diagnostics, and focused tests.
- **Profile**: Implementation worker; no model calls.
- **Projection paths** (assigned writes):
  - `src/manifest/controller-source.ts` — export `sourceWorkspaceAggregateBytes(grant)`; update `validateSourceRepositoryGrant` to fail closed when aggregate is not a safe integer.
  - `src/host/controller/production-sources.ts` — capacity predicate uses conservative reservation; emit the exact `required vs approved` diagnostic.
  - `tests/manifest/controller-source.test.ts` — aggregate tests (3.515625 GiB acceptance, 1 MiB boundary, `Number.MAX_SAFE_INTEGER + 1` rejection, exact diagnostic string).
  - `tests/host/controller-source-capacity.test.ts` — aggregate integration tests.
  - `tests/host/controller-production-sources.test.ts` — aggregate integration tests.
  - `docs/issue-118-source-workspaces/README.md` — note the safe-integer aggregate and the diagnostic rule.
- **Write ownership**: quota-lane only.
- **Expected output**: Diff with the above files; aggregate tests; updated README section.
- **Dependencies**: None; can run concurrently with provenance-worker.
- **Parent verification**: After return, parent will run focused tests then full repo gates.

## Closure preflight (must hold before dispatch)

- [x] Repository clean on `feature/bubblewrap-execution-spec` at `afb89a1`.
- [x] Plan committed; lanes disjoint; write ownership explicit.
- [x] Each child can finish without sibling output, repo exploration, or
      unresolved design choice.
- [x] Bridge contract, quota contract, and acceptance criteria are
      resolved in plan.md.
- [x] No implementation tests or repo gates have run yet; parent owns
      integration and full verification.
