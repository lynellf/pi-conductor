# Source-workspace-to-integration bridge and aggregate quota (#119)

Issue #119 closes two public-contract gaps left by #116/#118:

1. A real child patch captured at synthetic source head S inside a sealed
   source workspace must be independently approved and integrated onto
   canonical integration base B through public APIs **without rewriting**
   the original base, source ref/head/tree/inventory, exact patch
   bytes/digest, allowed paths, audience, or approval evidence. The bridge
   must verify S as a sealed parentless synthetic identity in the bounded
   Git view and reconstruct the canonical B→S prefix inside isolated
   canonical state, never by reaching S from B in the canonical repository
   (S is not an object there).
2. Aggregate source-workspace storage approval has an independent safe-integer
   bound large enough for ordinary multi-snapshot reservations (the issue's
   3.515625 GiB example must be accepted) while preserving conservative
   reservation math, retained failed/uncertain accounting, fail-closed
   admission, and recovery. Diagnostics must state required vs approved bytes.

This plan records the shared public contract resolved before child dispatch and
the integration mapping after both lanes return. The FSM spec §§9–12 and the
contracts from #115/#116/#118 remain authoritative.

## Public contract resolved before dispatch

### Source-workspace descriptor (extended)

`PreparedSourceWorkspace` is extended so the bridge can re-validate the B↔S
identity and the source patch lineage **without reading private host storage
or private source bytes**. The bridge is a generic host-owned function that
takes the opaque workspace ref plus the durable source intent and resolves
them via the host-owned source-workspace store; it never reads
`repository_canonical_path` from the descriptor (that path remains bound to
`authority.grant.repository.canonical_path` and is resolved only by the
host). New fields are filled in `SourceWorkspaceStore.read` and serialized
in the persisted `SourceWorkspacePreparedRecord.content`:

```ts
interface PreparedSourceWorkspace {
  // existing fields
  readonly ref: string;                     // source-workspace/v1/<sha>/<sha>
  readonly sourcePath: string;              // host-internal path; bridge never reads
  readonly checkoutPath: string;            // bounded Git view; bridge uses only
                                           //   HEAD / HEAD^{tree} for S verification
  readonly baseCommit: string;              // canonical B (= intent.resolved_base)
  readonly headCommit: string;              // sealed synthetic S in the bounded view
  readonly treeId: string;                  // S tree (canonical B + applied prefix)
  readonly inventoryDigest: string;
  readonly fileCount: number;
  readonly byteLength: number;
  readonly policyDigest: string;
  readonly audience: readonly ControllerOutputPrincipal[];
  // new fields (issue #119)
  readonly repositoryRef: string;           // intent.requested_ref (e.g. refs/heads/main)
  readonly repositoryFingerprint: string;   // intent.repository_fingerprint
  readonly allowedPaths: readonly string[]; // source grant's allowed paths, pinned at prep time
  readonly patches: readonly SourceWorkspacePatchLineage[]; // immutable source patch chain
  readonly patchesDigest: string;           // canonical digest of `patches` (no private bytes)
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
the sealed synthetic head S. The bridge uses it for **identity verification
only**; it never re-resolves the patch bytes from this record (those still
come from the controller-output store and are independently verified).

The bridge does not read `sourcePath`; it uses `checkoutPath` only to run
`git rev-parse HEAD` / `git rev-parse HEAD^{tree}` against the bounded view
to verify the sealed S identity. The host resolves
`authority.grant.repository.canonical_path` for canonical operations.

### Extended `GitIntegrateRequest`

`gitIntegrateRequestSchema` (in `src/manifest/controller-effect.ts`) gains one
optional sibling that, when present, unlocks the source-bridge mode:

```ts
const sourceWorkspaceDescriptorSchema = Type.Object(
  {
    ref: sourceWorkspaceRefSchema,
    repository_ref: sourceRepositoryRefSchema,
    repository_fingerprint: digest,
    base_commit: objectId,                  // = request.accepted_base = B
    head_commit: objectId,                  // = sealed S in the bounded view
    tree_id: objectId,
    inventory_digest: digest,
    file_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    byte_length: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    allowed_paths: Type.Array(sourcePathSchema, { minItems: 1, maxItems: 1024 }),
    patches_digest: digest,                 // canonical digest of `patches`
    patches: Type.Array(
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
    audience: Type.Array(controllerOutputPrincipalSchema, { minItems: 1, maxItems: 64 }),
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

The descriptor is purely additive: legacy callers (no
`source_workspace_descriptor`) keep the current `patches[*].base_commit ===
accepted_base` rule unchanged. The descriptor carries the **opaque**
workspace ref plus enough pinned identity fields to re-validate S without
reading private bytes; it never carries `repository_canonical_path`.

### `assertEffectRequestInScope` rule extension

When `source_workspace_descriptor` is present, `assertEffectRequestInScope`
switches to the source-bridge rule set:

- `descriptor.base_commit === request.accepted_base` (B identity is exact;
  this is the **only** canonical anchor).
- `request.patches.length === 1` (one child patch); the bridge applies that
  one patch against the reconstructed prefix; multiple-child batching is
  rejected so the bridge does not silently fan out.
- `request.patches[0].base_commit === descriptor.head_commit` (S, the sealed
  synthetic source head in the bounded view; `descriptor.head_commit` is
  treated as an opaque identity, **not** verified via a `git rev-parse
  --verify ^<B> <S>` query against the canonical repository — S does not
  exist in the canonical object database).
- `request.patches[0].evidence[*].subject_digest === request.patches[0].sha256`
  (existing rule, unchanged — proves the patch digest is the verified
  subject).
- `request.patches[0].evidence[*]` carries at least one entry matching every
  entry in `grant.required_patch_evidence` (existing rule, unchanged).
- The integration effect principal
  `{ kind: "effect", effect_id: authority.grant.id }` is present in
  `descriptor.audience`.
- `request.integration_ref` is not within the source prefix namespace
  `refs/pi-conductor/source-prefix`.
- `descriptor.allowed_paths` intersects with `grant.allowed_source_paths`
  is non-empty (otherwise the bridge would synthesize no prefix).
- The schema digest for the request remains the **existing**
  `effectRequestSchemaDigest("git_integrate")` (the descriptor is an
  optional sibling; legacy callers see the same digest).

When `source_workspace_descriptor` is absent, the existing rule set
(`patches[*].base_commit === accepted_base`) applies unchanged.

### Bridge function

A new exported function
`integrateGitEffectFromSourceWorkspace(options)` is added to
`src/host/controller/git-effect.ts` (or a co-located contract module
reachable through `git-effect.ts` exports). It is a **peer** of
`integrateGitEffect`, not a wrapper. It re-exported through `src/host/index.ts`.

Inputs (all required; no optional widening; the bridge never inspects
private source bytes):

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
  readonly persistPrepared: (prepared: GitEffectPrepared & {
    readonly sourceWorkspace?: SourceWorkspacePostcondition;
  }) => Promise<void>;
  readonly assertEffectOpen?: () => Promise<void>;
  readonly assertOpen: () => void;
  readonly signal?: AbortSignal;
}
```

Bridge flow (every step throws a typed `SourceIntegrationError` carrying a
stable code on rejection; success returns a `GitIntegrationOutcome`
whose result carries the bridge descriptor):

1. **Authority check**: `authority.grant.kind === "git_integrate"`,
   `authority.grant.repository.fingerprint` matches the descriptor's
   `repository_fingerprint`, and the `integration_ref` is in
   `authority.grant.allowed_integration_refs` (existing rule, re-asserted).
   Fail with `authority-mismatch`.
2. **Descriptor presence + base identity**:
   `descriptor.base_commit === request.accepted_base`. Fail with
   `descriptor-base-mismatch`. This is the **only** canonical anchor; the
   bridge does not query `git rev-parse --verify ^<B> <S>` against the
   canonical repository because S does not exist there.
3. **Source re-validation**: `resolveSourceWorkspace(descriptor.ref)`
   returns a `PreparedSourceWorkspace` whose `ref`, `baseCommit`,
   `headCommit`, `treeId`, `inventoryDigest`, `fileCount`, `byteLength`,
   `policyDigest`, `repositoryRef`, `repositoryFingerprint`, `allowedPaths`,
   `audience`, `patches`, and `patchesDigest` all match the descriptor
   byte-for-byte (no private paths are read; only the returned descriptor's
   structured fields are compared). Fail with `descriptor-revoked` if any
   field differs.
4. **Bounded-view S verification**: in the materialized bounded view
   (`prepared.checkoutPath`), run
   `git rev-parse HEAD` and `git rev-parse HEAD^{tree}`. Both must equal
   `descriptor.headCommit` and `descriptor.treeId` respectively; any
   mismatch fails with `descriptor-sealed-tampered`. This proves S is a
   sealed parentless synthetic identity whose exact bytes survive.
5. **Namespace check**: `request.integration_ref` does not start with
   `refs/pi-conductor/source-prefix/`. Fail with `integration-ref-in-source-prefix`.
6. **Audience check**: the effect principal
   `{ kind: "effect", effect_id: authority.grant.id }` is present in
   `descriptor.audience` (now generic — no hardcoded `effect_id`).
   Fail with `audience-denied`.
7. **Patch resolution + invariants**: `request.patches[0]` is resolved
   via `resolvePatch`. The bridge re-verifies, after resolution, that
   `sha256(bytes) === claim.sha256`, `bytes.length === claim.byte_length`,
   `claim.base_commit === descriptor.head_commit`,
   `claim.evidence[*].subject_digest === claim.sha256`,
   `patch.allowedPaths ⊆ descriptor.allowedPaths`, and at least one
   `claim.evidence[*]` matches every `grant.required_patch_evidence`
   entry. **No field of the original child patch is rewritten.** The
   original `sha256`, `byteLength`, `base_commit`, `evidence`, and
   `allowedPaths` stay immutable; they are not concatenated, combined, or
   re-digested.
8. **Isolated canonical state initialization**: an isolated canonical
   repository is initialized from `accepted_base = B` with the bounded view
   mounted as an alternate object directory
   (`GIT_ALTERNATE_OBJECT_DIRECTORIES=<prepared.checkoutPath>/.git/objects`).
   This lets the canonical state resolve S's commit and tree objects
   without ever importing them into the canonical repository or relaxing
   `GIT_NO_REPLACE_OBJECTS=1`.
9. **Prefix reconstruction**: the bridge produces prefix bytes by
   `git diff --binary --src-prefix=a/ --dst-prefix=b/ <B> <S>` against the
   isolated canonical state (S is resolved from the alternate objects).
   The bridge does **not** publish a separate prefix patch artifact and
   does **not** synthesise a combined digest; it applies the prefix in
   isolation. The prefix `allowedPaths` is the result of
   `git diff --name-only <B> <S>` and is asserted to be a subset of
   `descriptor.allowedPaths`.
10. **Pre-child state verification**: after applying the prefix via
    `git apply --index --3way --binary`, `HEAD` still names the canonical
    base B (the integration commit that parents the new head is produced
    in step 12), so `git rev-parse HEAD^{tree}` would return B's tree and
    cannot equal `descriptor.treeId` when there is any prefix. The bridge
    therefore writes the staged tree with `git write-tree` (the
    `--index` from `git apply` populated the index, not the working
    tree's HEAD) and verifies that the resulting staged tree OID equals
    `descriptor.treeId`. The inventory of `descriptor.allowedPaths` is
    then computed from that exact staged/index tree (not HEAD) and is
    asserted to match `descriptor.inventoryDigest` byte-for-byte, byte
    count, and file count. If the reconstruction does not equal S, the
    bridge aborts with `bridge-reconstruction-mismatch`; it never
    accepts a child patch unless the sealed source workspace's S
    identity has been exactly reproduced. `rejectUnsafeIndex` runs first
    so the reconstructed state cannot carry symlinks or unauthorized
    entries.
11. **Child patch application**: the resolved child patch bytes are applied
    via `git apply --index --3way --binary` against the isolated state at
    the verified S tree. The bridge verifies the resulting tree's
    selected paths do not violate `descriptor.allowedPaths` (existing rule
    ported from `integrateGitEffect`).
12. **Integration commit + result**: the bridge runs `git write-tree` and
    `git commit-tree tree -p <B> -m "pi-conductor source-bridge integration"`,
    producing a new integrated head whose parent is the canonical B and
    whose tree equals the prefix + child reconstruction. The bridge then
    collects `selected_source_paths` into a `SelectedSourceArtifact`,
    publishes it via `publishSelectedSource`, verifies the integration_ref
    is not checked out, reads the prior OID, and CAS-updates the canonical
    repository via `updateRefCas` (mirroring `integrateGitEffect` exactly).
13. **Prepared postcondition extension**: the
    `ControllerEffectPreparedRecord["postcondition"]` for `git_integrate`
    gains an optional `source_workspace` sibling (TypeBox optional). When
    the bridge fills it, the timeline can re-verify the B→S lineage at
    reconciliation time without re-reading source-workspace bytes:

    ```ts
    {
      kind: "git_integrate",
      helper_operation_id: id,
      repository_fingerprint: digest,
      source_head: oid,                       // = B
      target_ref: ref,
      expected_prior: nullableOid,
      applied_head: oid,
      source_artifact: { ref, sha256 } | null,
      source_workspace: Type.Optional(Type.Object({
        ref: sourceWorkspaceRefSchema,
        head_commit: oid,                     // S
        tree_id: oid,
        inventory_digest: digest,
        file_count: safeInteger,
        byte_length: safeInteger,
        repository_ref: sourceRepositoryRefSchema,
        repository_fingerprint: digest,
        allowed_paths: Type.Array(sourcePathSchema, { minItems: 1, maxItems: 1024 }),
        patches: Type.Array(sourceWorkspacePatchSchema, { maxItems: 64 }),
        audience: Type.Array(controllerOutputPrincipalSchema, { minItems: 1, maxItems: 64 }),
      }, { additionalProperties: false })),
    }
    ```

    The `assertPostcondition` extension accepts the optional
    `source_workspace` field and verifies that, when present, its
    `head_commit` equals the descriptor's S and its `tree_id` /
    `inventory_digest` / `file_count` / `byte_length` match the
    reconstructed pre-child state. Legacy records (no
    `source_workspace`) keep the existing postcondition assertions
    unchanged.
14. **Result extension**: `gitIntegrateResultSchema` gains one optional
    field `source_workspace_descriptor?: SourceWorkspaceDescriptorRef`
    carrying the opaque workspace ref + immutable source-patch chain
    digest. This proves the result traces back to the source lineage
    without exposing private bytes or `repository_canonical_path`:

    ```ts
    {
      schema_version: 1,
      kind: "git_integrate",
      repository_id: id,
      accepted_base: objectId,
      integrated_head: objectId,
      integration_ref: ref,
      prior_ref_oid: nullableObjectId,
      source_artifact_ref: artifactRef,
      source_artifact_sha256: sha256,
      source_workspace_descriptor: Type.Optional(Type.Object({
        ref: sourceWorkspaceRefSchema,
        head_commit: objectId,
        tree_id: objectId,
        inventory_digest: digest,
        file_count: safeInteger,
        byte_length: safeInteger,
        patches_digest: digest,
        patches: Type.Array(sourceWorkspacePatchSchema, { maxItems: 64 }),
      }, { additionalProperties: false })),
    }
    ```

15. **Reconciliation contract**: `reconcileGitEffect` (and the
    `ControllerEffectSettledRecord` outcome) stay read-only. Recovery
    never replays an uncertain canonical write; when the canonical ref
    does not match `prepared.integratedHead` or `prepared.expectedPrior`,
    the timeline records `uncertain` with `ref_diverged` or
    `repository_unavailable`, matching the existing #116/B4 contract.
    `reconcileGitEffect` accepts the extended postcondition (it already
    operates on the existing fields and ignores the optional
    `source_workspace` sibling).

### Recovery boundaries

- The bridge is also a recovery boundary: it never re-runs the canonical
  CAS-update. After `persistPrepared`, the source workspace, descriptor,
  and any resolved patch bytes stay untouched. If `assertEffectOpen`,
  `assertOpen`, or `persistPrepared` fails, the bridge aborts and returns
  the typed error to the caller; reconciliation uses `reconcileGitEffect`
  against the prepared intent's stored `integratedHead` and the
  integration ref's observed state.
- Uncertain canonical writes are observed only, never replayed: if the
  prepared postcondition is recorded but the CAS-update is uncertain, the
  next activation observes the integration ref and either confirms
  `integratedHead`, reports `not_applied` (still at `expectedPrior`), or
  reports `uncertain` with a stable diagnostic code.
- The bridge does not retry a failed reconstruction: a
  `bridge-reconstruction-mismatch` means S is no longer reproducible from
  the bounded view; the operator must create a fresh source workspace.
  The bridge never silently re-derives S.

### Aggregate quota

`max_total_bytes` becomes an independent safe-integer aggregate bound. The
exact schema (already present) is documented as a
`Number.MAX_SAFE_INTEGER`-bounded positive integer independent from
per-workspace reservation. The new helper:

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
reservation math (`sourceWorkspaceReservationBytes` per workspace,
multiplied by the retained-uncertain and in-flight intent count). When
admission fails, the error message becomes

```
source workspace storage reservation exceeds approved limits: required <N> bytes, approved <M> bytes
```

where `<N>` is the exact
`(reserved + 1) * sourceWorkspaceReservationBytes(...)` and `<M>` is
`grant.max_total_bytes`. When the aggregate itself is not a safe integer,
the diagnostic prefixes the same line with
`source repository grant aggregate reservation is unsafe: `.

`validateSourceRepositoryGrant` is updated so that:

- A grant whose `max_total_bytes` is greater than `Number.MAX_SAFE_INTEGER`
  fails closed at schema time (the TypeBox maximum already enforces this).
- A grant whose aggregate reservation is not a safe integer fails closed
  at validate time with
  `source repository grant aggregate reservation is unsafe`.
- The boundary case at exactly the operator-pinned aggregate succeeds.
- The 3.515625 GiB example
  (`max_source_bytes: 3_515_625 * 1024 * 1024 / 16 ≈ 230_686_720`,
  `max_source_files: 1024`, `max_workspaces: 16`,
  `max_total_bytes: 3_515_625 * 1024 * 1024`) resolves to a
  `Number.isSafeInteger` aggregate and is accepted; the exact byte math
  is asserted in tests.

Diagnostics produced by `production-sources.ts` mention both required and
approved bytes. Tests cover the 3.515625 GiB acceptance, a 1 MiB boundary,
an unsafe integer over `MAX_SAFE_INTEGER`, and the exact `required vs
approved` diagnostic string.

## Acceptance contract

Lane 1 (provenance-worker) must satisfy:

- [ ] `PreparedSourceWorkspace` is extended with `repositoryRef`,
      `repositoryFingerprint`, `allowedPaths`, `patches`, and
      `patchesDigest`. The sealed manifest captures them; `read` returns
      them; `intentMatchesGrant` re-verifies them on every open.
- [ ] `gitIntegrateRequestSchema` gains optional
      `source_workspace_descriptor`. `assertEffectRequestInScope`
      accepts the source-bridge mode without weakening the legacy mode.
      The schema digest for the request is unchanged
      (the descriptor is an optional sibling).
- [ ] `integrateGitEffectFromSourceWorkspace` lives in
      `src/host/controller/git-effect.ts` (or a co-located contract module
      reachable through `git-effect.ts` exports). It performs its own
      isolated canonical integration without rewriting trusted fields and
      without reading private source storage. It re-validates the B↔S
      identity via the sealed bounded view (no canonical-rev-parse
      query), the resolved child patch bytes/digest/length/paths, the
      effect principal audience, and reconstructs the prefix in isolated
      canonical state before applying the child patch.
- [ ] Step 10 verifies the staged/index tree (via `git write-tree` after
      `git apply --index`) equals `descriptor.treeId` and that the
      inventory of `descriptor.allowedPaths` from the same staged/index
      tree matches `descriptor.inventoryDigest`; `git rev-parse
      HEAD^{tree}` is never used for pre-child verification because
      `HEAD` still names B after `git apply --index`.
- [ ] The bridge does **not** concatenate prefix + child bytes, does
      **not** synthesise a combined digest, and does **not** rewrite the
      original child patch's `evidence[*].subject_digest`. The original
      patch's `sha256`, `byte_length`, `base_commit`, `evidence`, and
      `allowedPaths` are preserved byte-for-byte.
- [ ] The bridge does **not** expose `repository_canonical_path` on the
      public descriptor; only `repositoryRef` and
      `repositoryFingerprint` are bound, and host-owned resolution uses
      `authority.grant.repository.canonical_path` for canonical
      operations.
- [ ] `ControllerEffectPreparedRecord["postcondition"]` and
      `gitIntegrateResultSchema` carry the optional source-workspace
      descriptor reference when the bridge was used. The timeline's
      `assertPostcondition` accepts the extended postcondition.
- [ ] `reconcileGitEffect` stays read-only; uncertainty codes are
      unchanged.
- [ ] A focused test covers forged mappings (changed base, head, paths,
      audience, effect principal identity, evidence lineage,
      integration-ref namespace, descriptor re-validation, bounded-view
      S tampering, reconstruction mismatch).
- [ ] A public no-model end-to-end test exercises B→S→child
      patch→approval→canonical B integration twice in succession with real
      patch bytes, real evidence, and verifies the original repository
      was never mutated between batches (parent-owned; provenance-worker
      writes the test scaffold and the parent wires the no-model
      execution).
- [ ] Documentation in `docs/issue-119-source-bridge/README.md` explains
      the bridge contract, the B↔S identity split (sealed parentless S in
      bounded view), the byte/digest handling rule (no concatenation, no
      digest rewriting), the recovery contract, the
      `repository_canonical_path` non-exposure rule, and the new
      `PreparedSourceWorkspace` fields.

Lane 2 (quota-worker) must satisfy:

- [ ] `sourceWorkspaceAggregateBytes(grant)` is exported from
      `src/manifest/controller-source.ts`.
- [ ] `validateSourceRepositoryGrant` rejects grants whose aggregate
      reservation is not a safe integer with
      `source repository grant aggregate reservation is unsafe`.
- [ ] `production-sources.ts` capacity check uses the conservative
      per-workspace reservation × retained-uncertain/in-flight count and
      emits
      `source workspace storage reservation exceeds approved limits: required <N> bytes, approved <M> bytes`
      when the predicate fails.
- [ ] Focused tests cover the 3.515625 GiB acceptance, the exact-byte
      boundary, an unsafe integer rejection at
      `Number.MAX_SAFE_INTEGER + 1` (or any input that produces an unsafe
      product), and the exact diagnostic message format.
- [ ] Documentation in `docs/issue-118-source-workspaces/README.md` is
      updated to mention the safe-integer aggregate and the diagnostic
      rule.

## Parent-owned after delegation

- Update `CHANGELOG.md` with the bridge + aggregate entries.
- Update `src/host/index.ts` exports so the bridge is reachable from the
  public barrel.
- Wire the bridge into the production-effect dispatcher (parent-only; the
  provenance worker does not edit `production-effects.ts`).
- Resolve any cross-file conflicts (the two lanes are disjoint by
  projection).
- Update `docs/issue-119-source-bridge/plan.md` integration mapping once
  both lanes return.
- Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
  `pnpm format:check`, `pnpm audit`, `git diff --check`.
- Commit separately: bridge + tests, quota + tests, docs, plan mapping.
- Run `tests/host/bubblewrap-source-workspaces.real.ts` and
  `tests/host/bubblewrap-source-workers.real.ts` if the approved
  Bubblewrap runtime is available; otherwise record that the gate was
  skipped.

## Disjoint projection (confirmed)

Provenance-worker projection (assigned writes):

```
AGENTS.md                                                  (readonly context)
docs/archive/orchestrator-fsm-spec.md                      (readonly context)
docs/issue-116-delivery/                                   (readonly context)
docs/issue-118-source-workspaces/                          (readonly context)
docs/issue-119-source-bridge/                              (write — plan.md + README.md)
src/manifest/controller-effect.ts                          (write — extend gitIntegrateRequestSchema + gitIntegrateResultSchema)
src/manifest/controller-protocol.ts                        (readonly context)
src/manifest/controller-source.ts                          (readonly context — schemas used by bridge)
src/host/controller/git-effect.ts                          (write — add integrateGitEffectFromSourceWorkspace)
src/host/controller/git-effect-contract.ts                 (readonly — types used by bridge)
src/host/controller/git-effect-operations.ts               (readonly — helpers used by bridge)
src/host/controller/source-workspace-contract.ts           (write — extend PreparedSourceWorkspace)
src/host/controller/source-workspace-service.ts            (write — return extended descriptor)
src/host/controller/source-workspace-store.ts              (write — extend read to return new fields)
src/host/controller/source-workspace-validation.ts         (write — verify new descriptor fields)
src/host/controller/source-workspace-git.ts                (readonly — runSourceGit used by bridge)
src/host/controller/source-workspace-materialize.ts        (readonly — used by bridge for pre-state)
src/host/controller/effect-registry.ts                     (write — extend assertEffectRequestInScope)
src/host/controller/effect-broker-contract.ts              (readonly)
src/host/controller/effect-broker-execution.ts             (readonly)
src/host/controller/effect-broker-support.ts               (readonly)
src/host/controller/effect-broker.ts                       (readonly)
src/host/controller/effect-artifacts.ts                    (readonly)
src/host/controller/effect-implementation-inventory.ts     (readonly)
src/host/controller/effect-registry-validation.ts          (readonly)
src/host/controller/child-output-capture.ts                (readonly)
src/host/controller/child-output-publication.ts            (readonly)
src/host/controller/production-effects.ts                  (readonly)
# Delegation worktree + execution-controller (read-only; the surface that
# tests/host/source-workspace.test.ts uses via createIndependentSourceWorktree
# and ToolExecutionError. The bridge never reads from these.)
src/host/delegation/child-result.ts                        (readonly — ChildWorktreeInspection type used by worktree.ts)
src/host/delegation/ids.ts                                 (readonly — ChildId type used by worktree.ts)
src/host/delegation/projection.ts                          (readonly — isSafeExactProjectionPath used by worktree.ts)
src/host/delegation/worktree.ts                            (readonly — createIndependentSourceWorktree used by source-workspace.test.ts)
src/host/execution/execution-attempt-tracker.ts            (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-controller-support.ts    (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-controller.ts            (readonly — ToolExecutionError used by source-workspace.test.ts)
src/host/execution/tool-execution-contract.ts              (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-lifecycle-admission.ts   (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-lifecycle.ts             (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-resume.ts                (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-terminal.ts              (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-timing.ts                (readonly — direct local import of tool-execution-controller.ts)
src/host/index.ts                                          (write — re-export bridge)
src/persistence/source-workspace.ts                        (write — extend sourceWorkspaceContentSchema with allowed_paths + patches_digest)
src/persistence/source-workspace-timeline.ts               (readonly)
src/persistence/controller-effect-records.ts               (write — extend gitPrepared postcondition)
src/persistence/controller-effect-timeline.ts              (write — extend assertPostcondition)
src/persistence/controller-records.ts                      (readonly)
src/persistence/controller-timeline.ts                     (readonly)
src/persistence/child-output-artifact.ts                   (readonly)
src/persistence/child-output-records.ts                    (readonly)
src/persistence/child-output-timeline.ts                   (readonly)
src/persistence/sandbox-command.ts                         (readonly — SandboxExecutionTerminal used by tool-execution-controller.ts)
src/persistence/sandbox-execution.ts                       (readonly — SandboxExecutionOwner used by tool-execution-controller.ts)
src/persistence/tool-execution.ts                          (readonly — ToolExecutionRecord used by tool-execution-controller.ts)
src/persistence/trajectory-records.ts                      (readonly — sha256Canonical)
tests/host/controller-git-effect.test.ts                   (write — extend with bridge integration)
tests/host/controller-git-effect-source-bridge.test.ts     (write — new bridge test)
tests/host/controller-effect-broker.test.ts                (readonly)
tests/host/controller-effect-artifacts.test.ts             (readonly)
tests/host/controller-effect-registry.test.ts              (readonly)
tests/host/controller-effect-implementation-inventory.test.ts (readonly)
tests/host/controller-child-output-capture.test.ts         (readonly)
tests/host/controller-child-output-publication.test.ts     (readonly)
tests/host/controller-delivery-example.test.ts              (readonly)
tests/host/controller-production-effects.test.ts            (readonly)
tests/host/source-workspace.test.ts                        (readonly)
tests/host/source-workspace-git.test.ts                    (readonly)
```

Quota-worker projection (assigned writes):

```
AGENTS.md                                                  (readonly context)
docs/archive/orchestrator-fsm-spec.md                      (readonly context)
docs/issue-118-source-workspaces/README.md                 (write — aggregate + diagnostic)
docs/issue-119-source-bridge/plan.md                       (readonly — bridge contract that quota also references)
src/manifest/controller-source.ts                          (write — sourceWorkspaceAggregateBytes)
src/host/controller/production-sources.ts                  (write — capacity predicate + diagnostic)
# Execution-controller surface (read-only; the surface that
# tests/host/controller-source-capacity.test.ts and
# tests/host/controller-production-sources.test.ts use via
# ToolExecutionScope / ToolExecutionController. Quota never writes here.)
src/host/execution/execution-attempt-tracker.ts            (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-controller-support.ts    (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-controller.ts            (readonly — ToolExecutionScope / ToolExecutionController used by focused tests)
src/host/execution/tool-execution-contract.ts              (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-lifecycle-admission.ts   (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-lifecycle.ts             (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-resume.ts                (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-terminal.ts              (readonly — direct local import of tool-execution-controller.ts)
src/host/execution/tool-execution-timing.ts                (readonly — direct local import of tool-execution-controller.ts)
src/persistence/sandbox-command.ts                         (readonly — SandboxExecutionTerminal used by tool-execution-controller.ts)
src/persistence/sandbox-execution.ts                       (readonly — SandboxExecutionOwner used by tool-execution-controller.ts)
src/persistence/tool-execution.ts                          (readonly — ToolExecutionRecord used by tool-execution-controller.ts)
tests/manifest/controller-source.test.ts                   (write — aggregate tests)
tests/host/controller-source-capacity.test.ts              (write — aggregate tests)
tests/host/controller-production-sources.test.ts           (write — aggregate tests)
```

Provenance writes are limited to bridge / descriptor / postcondition /
result schema / public barrel / timeline / registry files; quota writes
are limited to the source-grant manifest, production-sources capacity, the
quota documentation, and their focused tests. Both lanes share read-only
access to `AGENTS.md` and `orchestrator-fsm-spec.md`; the provenance
worker additionally shares read-only access to
`controller-source.ts` (for `sourceWorkspaceRefSchema` /
`sourceRepositoryRefSchema`) and the integration `provider`
`controller-timeline.ts` / `controller-records.ts` / `child-output-*` /
`trajectory-records.ts`. Both lanes additionally share read-only access
to the `delegation` (worktree + child-result + ids + projection),
`execution` (tool-execution-controller + contract + support + lifecycle +
lifecycle-admission + terminal + timing + resume + attempt-tracker), and
`sandbox-` / `tool-execution` persistence modules because the
provenance-focused `source-workspace.test.ts` and the quota-focused
`controller-source-capacity.test.ts` and `controller-production-sources.test.ts`
construct `createIndependentSourceWorktree`, `ToolExecutionError`,
`ToolExecutionScope`, and `ToolExecutionController` against them. None
of these are write targets for either lane. No write overlap.