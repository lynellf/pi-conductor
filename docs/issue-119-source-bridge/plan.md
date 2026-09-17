# Source-workspace-to-integration bridge and aggregate quota (#119)

Issue #119 closes two public-contract gaps left by #116/#118:

1. A real child patch captured from synthetic source head S must be independently
   approved and integrated onto canonical integration base B through public APIs
   without relabelling the original base, source ref/head/tree/inventory, exact
   patch bytes/digest, allowed paths, audience, or evidence lineage.
2. Aggregate source-workspace storage approval has an independent safe-integer
   bound large enough for ordinary multi-snapshot reservations (the issue's
   3.515625 GiB example must be accepted) while preserving conservative
   reservation math, retained failed/uncertain accounting, fail-closed admission,
   and recovery. Diagnostics must state required vs approved bytes.

This plan records the shared public contract resolved before child dispatch and
the integration mapping after both lanes return. The FSM spec §§9–12 and the
contracts from #115/#116/#118 remain authoritative.

## Public contract resolved before dispatch

### Source-workspace descriptor (extended)

`PreparedSourceWorkspace` is extended so the bridge can re-validate the B→S
identity and the source patch lineage without touching private host storage or
private source tree bytes. New fields are filled in `SourceWorkspaceStore.read`
and serialized in the persisted `SourceWorkspacePreparedRecord`:

```ts
interface PreparedSourceWorkspace {
  // existing fields
  readonly ref: string;                     // source-workspace/v1/<sha>/<sha>
  readonly sourcePath: string;              // host-internal path; bridge never reads
  readonly checkoutPath: string;            // host-internal Git view path; never read by bridge
  readonly baseCommit: string;              // canonical B
  readonly headCommit: string;              // synthetic S
  readonly treeId: string;
  readonly inventoryDigest: string;
  readonly fileCount: number;
  readonly byteLength: number;
  readonly policyDigest: string;
  readonly audience: readonly ControllerOutputPrincipal[];
  // new fields (issue #119)
  readonly repositoryRef: string;           // refs/heads/... from the grant
  readonly repositoryFingerprint: string;   // pinned at preparation time
  readonly repositoryCanonicalPath: string; // pinned at preparation time
  readonly allowedPaths: readonly string[]; // captured from grant.allowed_paths
  readonly sourcePatches: readonly SourceWorkspacePatchLineage[];
}

interface SourceWorkspacePatchLineage {
  readonly ref: string;                     // controller-output artifact ref
  readonly sha256: string;                  // exact child patch digest
  readonly byteLength: number;              // exact child patch byte length
  readonly acceptedBase: string;            // B for patch[0]; previous prefix head for later
  readonly allowedPaths: readonly string[];
}
```

The lineage is the durable record of which exact patch bytes/digest went into
the published synthetic head S. The bridge uses it only for B→S byte
construction; it never re-resolves the patch bytes (those are still resolved
from the controller-output store and verified independently).

### Extended `GitIntegrateRequest`

`gitIntegrateRequestSchema` (in `src/manifest/controller-effect.ts`) gains one
optional sibling that, when present, unlocks the B↔S split:

```ts
const sourceWorkspaceDescriptorSchema = Type.Object(
  {
    ref: sourceWorkspaceRefSchema,
    repository_ref: sourceRepositoryRefSchema,
    repository_fingerprint: digest,
    canonical_path: canonicalPath,
    base_commit: objectId,                  // = request.accepted_base = B
    head_commit: objectId,                  // = S
    tree_id: objectId,
    inventory_digest: digest,
    file_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    byte_length: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    policy_digest: digest,
    audience: Type.Array(controllerOutputPrincipalSchema, { minItems: 1, maxItems: 64 }),
    allowed_paths: Type.Array(sourcePathSchema, { minItems: 1, maxItems: 1024 }),
    source_patches: Type.Array(
      Type.Object(
        {
          ref: artifactRef,
          sha256: digest,
          byte_length: Type.Integer({ minimum: 1, maximum: 67_108_864 }),
          accepted_base: objectId,
          allowed_paths: Type.Array(sourcePathSchema, { minItems: 1, maxItems: 1024 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);

const gitIntegrateRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("git_integrate"),
    repository_id: id,
    accepted_base: objectId,
    integration_ref: ref,
    expected_ref_oid: nullableObjectGuid,
    patches: Type.Array(patch, { minItems: 1, maxItems: 64 }),
    selected_source_paths: Type.Array(relativePath, { minItems: 1, maxItems: 64 }),
    source_workspace_descriptor: Type.Optional(sourceWorkspaceDescriptorSchema),
  },
  { additionalProperties: false },
);
```

The descriptor is purely additive: legacy callers (no `source_workspace_descriptor`)
keep the current `patches[*].base_commit === accepted_base` rule unchanged.

### `assertEffectRequestInScope` rule extension

When `source_workspace_descriptor` is present, `assertEffectRequestInScope`
switches to the source-bridge rule set:

- `descriptor.base_commit === request.accepted_base` (B identity is exact).
- `descriptor.head_commit` is reachable from `accepted_base` in the canonical
  repository — verified by a single `git rev-parse --verify ^<B> <S>` query
  during bridge construction; the descriptor carries this lineage implicitly
  via the sealed source workspace manifest, which is re-read.
- Every `request.patches[i].base_commit === descriptor.head_commit` (S, the
  synthetic source head).
- Every `request.patches[i].evidence[j].subject_digest === request.patches[i].sha256`
  (existing rule, unchanged — proves the patch digest is the verified subject).
- `request.patches[i].evidence[j]` carries at least one entry matching every
  entry in `grant.required_patch_evidence` (existing rule, unchanged).
- The integration effect principal
  `{ kind: "effect", effect_id: authority.grant.id }` (now derived from the
  pinned grant, not hardcoded) is present in `descriptor.audience`.
- `request.integration_ref` is not within the source prefix namespace
  `refs/pi-conductor/source-prefix`.
- `descriptor.allowed_paths` intersects with `grant.allowed_source_paths` is
  non-empty (otherwise the bridge would synthesize no prefix).

When `source_workspace_descriptor` is absent, the existing rule set
(`patches[*].base_commit === accepted_base`) applies unchanged.

### Bridge function

A new exported function
`integrateGitEffectFromSourceWorkspace(options)` is added to
`src/host/controller/git-effect.ts` and re-exported through `src/host/index.ts`.

Inputs (all required; no optional widening; the bridge never inspects private
source storage):

```ts
interface SourceIntegrationOptions {
  readonly authority: PinnedEffectAuthority;          // grant.kind must be git_integrate
  readonly request: GitIntegrateRequest;              // MUST carry source_workspace_descriptor
  readonly workspaceRoot: string;
  readonly resolvePatch: (claim) => Promise<ResolvedGitPatch>;
  readonly resolveSourceWorkspace: (
    ref: string,
  ) => Promise<PreparedSourceWorkspace>;              // host-owned: source-workspace store read
  readonly publishSelectedSource: (source) => Promise<{ ref; sha256 }>;
  readonly persistPrepared: (prepared: GitEffectPrepared) => Promise<void>;
  readonly assertEffectOpen?: () => Promise<void>;
  readonly assertOpen: () => void;
  readonly signal?: AbortSignal;
}
```

Bridge flow (every step throws a typed `SourceIntegrationError` carrying a
stable code on rejection; success forwards to `integrateGitEffect`):

1. **Authority check**: `authority.grant.kind === "git_integrate"`,
   `authority.grant.repository.fingerprint` matches the descriptor's
   `repository_fingerprint`, and the `integration_ref` is in
   `authority.grant.allowed_integration_refs` (existing rule, re-asserted).
2. **B↔S identity check**: descriptor is present;
   `descriptor.base_commit === request.accepted_base`;
   `descriptor.head_commit` is a strict descendant of `accepted_base` in the
   canonical repository (via `git rev-parse --verify ^<B> <S>`; fail with
   `descriptor-not-reachable`).
3. **Source re-validation**: `resolveSourceWorkspace(descriptor.ref)` returns
   a `PreparedSourceWorkspace` whose `ref`, `baseCommit`, `headCommit`,
   `treeId`, `inventoryDigest`, `policyDigest`, `repositoryRef`,
   `repositoryFingerprint`, `allowedPaths`, `audience`, and `sourcePatches`
   all match the descriptor byte-for-byte (no private paths are read; only
   the returned descriptor's structured fields are compared). Fail with
   `descriptor-revoked` if any field differs.
4. **Namespace check**: `request.integration_ref` does not start with
   `refs/pi-conductor/source-prefix/`. Fail with `integration-ref-in-source-prefix`.
5. **Audience check**: the effect principal
   `{ kind: "effect", effect_id: authority.grant.id }` is present in
   `descriptor.audience` (now generic — no hardcoded `effect_id`).
   Fail with `audience-denied`.
6. **Patch resolution + invariants**: every `request.patches[i]` is resolved
   via `resolvePatch`. The bridge re-verifies, after resolution, that
   `sha256(bytes) === claim.sha256`, `bytes.length === claim.byte_length`,
   `claim.base_commit === descriptor.head_commit`, `claim.evidence[*].subject_digest === claim.sha256`,
   `patch.allowedPaths` ⊆ `descriptor.allowed_paths`, and at least one
   `claim.evidence[*]` matches every `grant.required_patch_evidence` entry.
   Each original child patch's `sha256` and `byte_length` are appended to
   the durable `source_patch_lineage` (see prepared-record extension below)
   so recovery can re-verify without re-reading patch bytes.
7. **Prefix construction**: prefix patch bytes are produced by
   `git diff --binary <accepted_base> <descriptor.head_commit>` against the
   canonical repository. The prefix's `git diff --name-only` result is the
   prefix `allowedPaths`. The prefix `sha256 = sha256(prefixBytes)`,
   `byteLength = prefixBytes.length`, `base_commit = accepted_base = B`.
8. **Combined-patch claim construction**: a new `GitIntegrateRequest` (the
   "B-based integrated patch") is built:
   - One patch claim whose `base_commit = accepted_base = B`,
     `sha256 = sha256(prefixBytes || childBytes)`,
     `byteLength = prefixBytes.length + childBytes.length`,
     `allowedPaths = unique(prefixPaths ∪ child.allowedPaths)`,
     `evidence = child.claim.evidence` with each entry's
     `subject_digest` replaced by the new combined digest (the existing rule
     `subject_digest === patch.sha256` must hold).
   - The same `source_workspace_descriptor` from the input request.
   - All other fields copied from the input request (so
     `repository_id`, `accepted_base`, `integration_ref`,
     `expected_ref_oid`, `selected_source_paths` are unchanged).
   - The original child patch's exact `sha256`, `byte_length`, and
     `base_commit` are appended to the descriptor's `source_patches` (or a
     dedicated `source_patch_lineage` slot on the descriptor — the
     provenance-worker picks the cleanest encoding).
9. **Forward to `integrateGitEffect`**: the bridge calls `integrateGitEffect`
   with the new B-based request. No field rewriting on the original input
   request. `assertEffectRequestInScope` passes because every patch now has
   `base_commit === accepted_base = B`. The implementation applies prefix +
   child sequentially via the existing `git apply --index --3way --binary`
   loop; the integrated head becomes a new B-based commit with a new digest.
10. **Prepared postcondition extension**: the
    `ControllerEffectPreparedRecord["postcondition"]` for `git_integrate`
    gains a `source_workspace_descriptor` sibling (TypeBox optional). When
    the bridge fills it, the timeline can re-verify the B→S lineage at
    reconciliation time without re-reading source-workspace bytes.
11. **Result extension**: `gitIntegrateResultSchema` gains one optional field
    `source_workspace_descriptor?: SourceWorkspaceDescriptorRef` carrying the
    opaque workspace ref + source patch digest chain. This proves the result
    traces back to the source lineage without exposing private bytes.
12. **Reconciliation contract**: `reconcileGitEffect` (and the
    `ControllerEffectSettledRecord` outcome) stay read-only. Recovery never
    replays an uncertain canonical write; when the canonical ref does not
    match `prepared.integratedHead` or `prepared.expectedPrior`, the timeline
    records `uncertain` with `ref_diverged` or `repository_unavailable`,
    matching the existing #116/B4 contract.

### Recovery boundaries

- The bridge is also a recovery boundary: it never re-runs the canonical
  CAS-update. After `persistPrepared`, the source workspace, descriptor, and
  any resolved patch bytes stay untouched. If `assertEffectOpen`, `assertOpen`,
  or `persistPrepared` fails, the bridge aborts and returns the typed error
  to the caller; reconciliation uses `reconcileGitEffect` against the
  prepared intent's stored `integratedHead` and the integration ref's
  observed state.
- Uncertain canonical writes are observed only, never replayed: if the
  prepared postcondition is recorded but the CAS-update is uncertain, the
  next activation observes the integration ref and either confirms
  `integratedHead`, reports `not_applied` (still at `expectedPrior`), or
  reports `uncertain` with a stable diagnostic code.

### Aggregate quota

`max_total_bytes` becomes a separate aggregate bound. The exact schema (already
present) is documented as a `Number.MAX_SAFE_INTEGER`-bounded positive integer
independent from per-workspace reservation. The new helper:

```ts
function sourceWorkspaceAggregateBytes(grant: SourceRepositoryGrant): number {
  const perWorkspace = sourceWorkspaceReservationBytes(
    grant.max_source_bytes,
    grant.max_source_files,
  );
  const total = perWorkspace * grant.max_workspaces;
  if (!Number.isSafeInteger(total))
    throw new RangeError(
      "source repository grant aggregate reservation is unsafe",
    );
  return total;
}
```

The capacity predicate in `production-sources.ts` retains the conservative
reservation math (`sourceWorkspaceReservationBytes` per workspace, multiplied by
the retained-uncertain and in-flight intent count). When admission fails, the
error message becomes
`source workspace storage reservation exceeds approved limits: required <N> bytes, approved <M> bytes`
where `<N>` is the exact `(reserved + 1) * sourceWorkspaceReservationBytes(...)`
and `<M>` is `grant.max_total_bytes`.

`validateSourceRepositoryGrant` is updated so that:

- A grant whose `max_total_bytes` is greater than `Number.MAX_SAFE_INTEGER`
  fails closed at schema time (the TypeBox maximum already enforces this).
- A grant whose aggregate reservation is not a safe integer fails closed at
  validate time with `source repository grant aggregate reservation is unsafe`.
- The boundary case at exactly the operator-pinned aggregate succeeds.
- The 3.515625 GiB example (`max_source_bytes: 3_515_625 * 1024 * 1024 / 16 ≈ ...`)
  resolves to a `Number.isSafeInteger` aggregate and is accepted; the exact
  byte math is asserted in tests.

Diagnostics produced by `production-sources.ts` mention both required and
approved bytes. Tests cover the 3.515625 GiB acceptance, a 1 MiB boundary, an
unsafe integer over `MAX_SAFE_INTEGER`, and the exact `required vs approved`
diagnostic string.

## Acceptance contract

Lane 1 (provenance-worker) must satisfy:

- [ ] `PreparedSourceWorkspace` is extended with `repositoryRef`,
      `repositoryFingerprint`, `repositoryCanonicalPath`, `allowedPaths`,
      and `sourcePatches`. The sealed manifest captures them; `read` returns
      them; `intentMatchesGrant` re-verifies them on every open.
- [ ] `gitIntegrateRequestSchema` gains optional `source_workspace_descriptor`.
      `assertEffectRequestInScope` accepts the source-bridge mode without
      weakening the legacy mode. The new request schema digest is bumped
      inside the same `schema_version: 1` (the existing schema_version is
      a manifest-level lock; TypeBox-serialised schema digests are recomputed
      for `effectRequestSchemaDigest` and the host's built-in measurement).
- [ ] `integrateGitEffectFromSourceWorkspace` lives in
      `src/host/controller/git-effect.ts` (or a co-located contract module
      reachable through `git-effect.ts` exports). It validates the B↔S
      identity, the namespace, the effect principal audience, the resolved
      patch bytes/digest/length/paths, and constructs a combined B-based
      patch claim carrying the durable source patch lineage.
- [ ] The bridge delegates to `integrateGitEffect` for actual Git integration
      and selected-source publication. No re-implementation of the Git state
      machine; no rewriting of trusted fields; no reading of private source
      storage.
- [ ] `ControllerEffectPreparedRecord["postcondition"]` and
      `gitIntegrateResultSchema` carry the optional source-workspace
      descriptor reference when the bridge was used. The timeline's
      `assertPostcondition` accepts the extended postcondition.
- [ ] `reconcileGitEffect` stays read-only; uncertainty codes are unchanged.
- [ ] A focused test covers forged mappings (changed base, head, paths,
      audience, effect principal identity, evidence lineage, integration-ref
      namespace, descriptor re-validation).
- [ ] A public no-model end-to-end test exercises B→S→child patch→approval→
      canonical B integration twice in succession with real patch bytes,
      real evidence, and verifies the original repository was never mutated
      between batches (parent-owned; provenance-worker writes the test
      scaffold and the parent wires the no-model execution).
- [ ] Documentation in `docs/issue-119-source-bridge/README.md` explains the
      bridge contract, the B↔S identity split, the byte/digest handling
      rule, the recovery contract, and the new `PreparedSourceWorkspace`
      fields.

Lane 2 (quota-worker) must satisfy:

- [ ] `sourceWorkspaceAggregateBytes(grant)` is exported from
      `src/manifest/controller-source.ts`.
- [ ] `validateSourceRepositoryGrant` rejects grants whose aggregate
      reservation is not a safe integer with `source repository grant aggregate
      reservation is unsafe`.
- [ ] `production-sources.ts` capacity check uses the conservative
      per-workspace reservation × retained-uncertain/in-flight count and
      emits
      `source workspace storage reservation exceeds approved limits: required <N> bytes, approved <M> bytes`
      when the predicate fails.
- [ ] Focused tests cover the 3.515625 GiB acceptance, the exact-byte
      boundary, an unsafe integer rejection at `Number.MAX_SAFE_INTEGER + 1`
      (or any input that produces an unsafe product), and the exact
      diagnostic message format.
- [ ] Documentation in `docs/issue-118-source-workspaces/README.md` is
      updated to mention the safe-integer aggregate and the diagnostic rule.

## Parent-owned after delegation

- Update `CHANGELOG.md` with the bridge + aggregate entries.
- Update `src/host/index.ts` exports so the bridge is reachable from the
  public barrel.
- Wire the bridge into the production-source dispatcher (parent-only; the
  provenance worker does not edit `production-sources.ts`).
- Resolve any cross-file conflicts (the two lanes are disjoint by projection).
- Update `docs/issue-119-source-bridge/plan.md` integration mapping once both
  lanes return.
- Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
  `pnpm format:check`, `pnpm audit`, `git diff --check`.
- Commit separately: bridge + tests, quota + tests, docs, plan mapping.
- Run `tests/host/bubblewrap-source-workspaces.real.ts` and
  `tests/host/bubblewrap-source-workers.real.ts` if the approved Bubblewrap
  runtime is available; otherwise record that the gate was skipped.

## Disjoint projection (confirmed)

Provenance-worker projection (assigned writes):

```
AGENTS.md
docs/archive/orchestrator-fsm-spec.md
docs/issue-116-delivery/
docs/issue-118-source-workspaces/
docs/issue-119-source-bridge/
src/manifest/controller-effect.ts
src/manifest/controller-protocol.ts
src/persistence/child-output-artifact.ts
src/persistence/child-output-timeline.ts
src/persistence/controller-effect-records.ts
src/persistence/controller-effect-timeline.ts
src/persistence/source-workspace.ts
src/host/controller/child-output-capture.ts
src/host/controller/child-output-publication.ts
src/host/controller/effect-artifacts.ts
src/host/controller/effect-broker-contract.ts
src/host/controller/effect-broker-execution.ts
src/host/controller/effect-broker-support.ts
src/host/controller/effect-broker.ts
src/host/controller/effect-implementation-inventory.ts
src/host/controller/effect-registry-validation.ts
src/host/controller/effect-registry.ts
src/host/controller/git-effect-contract.ts
src/host/controller/git-effect-operations.ts
src/host/controller/git-effect.ts
src/host/controller/production-effects.ts
src/host/controller/source-workspace-contract.ts
src/host/controller/source-workspace-service.ts
src/host/controller/source-workspace-store.ts
src/host/controller/source-workspace-validation.ts
src/host/index.ts
tests/host/controller-child-output-capture.test.ts
tests/host/controller-child-output-publication.test.ts
tests/host/controller-delivery-example.test.ts
tests/host/controller-effect-artifacts.test.ts
tests/host/controller-effect-broker.test.ts
tests/host/controller-effect-registry.test.ts
tests/host/controller-git-effect.test.ts
tests/host/controller-production-effects.test.ts
tests/host/source-workspace.test.ts
```

Quota-worker projection (assigned writes):

```
AGENTS.md
docs/archive/orchestrator-fsm-spec.md
docs/issue-118-source-workspaces/README.md
src/manifest/controller-source.ts
src/host/controller/production-sources.ts
tests/manifest/controller-source.test.ts
tests/host/controller-source-capacity.test.ts
tests/host/controller-production-sources.test.ts
```

Provenance writes are limited to bridge / descriptor / timeline / registry /
result / prepared-record / sealed-store / public-barrel files. Quota writes
are limited to the source-grant manifest, production-sources capacity, and
their focused tests. No overlap.