# Source-workspace-to-integration bridge (issue #119)

This document is the public-contract companion to
[`docs/issue-119-source-bridge/plan.md`](./plan.md). It explains the
source-bridge used by `integrateGitEffectFromSourceWorkspace`: what it
guarantees, what it never inspects, and how the durable postcondition
lets reconciliation re-verify the sealed B↔S identity without
re-reading private source bytes.

## The B↔S identity split

The canonical integration base (`B`) is the immutable commit named on
the request (`request.accepted_base`). The sealed source workspace
holds a separate synthetic head (`S`) that exists only inside the
bounded private Git view; `S` is **not** an object in the canonical
repository. The bridge never queries the canonical repository to
"find" `S` from `B`; instead, it re-validates `S` against the
sealed descriptor inside the bounded view itself.

| Identifier | Lives in | Meaning |
|---|---|---|
| `B` | Canonical repository | `request.accepted_base`; the only canonical anchor. |
| `S` | Bounded view (`prepared.checkoutPath`) | Synthetic sealed head the source worker observed. |
| `descriptor.base_commit` | Request payload | Must equal `B`. |
| `descriptor.head_commit` | Request payload | Must equal `S` and must be re-verified in the bounded view. |
| `descriptor.tree_id` | Request payload | Must equal the staged/index tree after prefix reconstruction. |

## What the bridge does

1. Verify authority (`authority-mismatch`).
2. Verify `descriptor.base_commit === request.accepted_base`
   (`descriptor-base-mismatch`).
3. Resolve the sealed workspace via `resolveSourceWorkspace` and
   re-verify the descriptor fields byte-for-byte
   (`descriptor-revoked`).
4. Re-run `git rev-parse HEAD` and `git rev-parse HEAD^{tree}`
   inside the bounded view to confirm `S` is still sealed
   (`descriptor-sealed-tampered`).
5. Reject `integration_ref` inside `refs/pi-conductor/source-prefix/`
   (`integration-ref-in-source-prefix`).
6. Reject descriptors that do not include the effect principal
   `{ kind: "effect", effect_id: authority.grant.id }`
   (`audience-denied`).
7. Resolve the single child patch and re-verify
   `sha256(bytes) === claim.sha256`,
   `bytes.length === claim.byte_length`,
   `claim.base_commit === descriptor.head_commit`, and the
   evidence `subject_digest === claim.sha256`. The original patch's
   bytes, digest, length, base, and evidence are **never rewritten**.
8. Initialize isolated canonical state from `B` with the bounded
   view mounted as a read-only alternate object directory.
9. Reconstruct the B→S prefix via
   `git diff --binary <B> <S>` and apply it via
   `git apply --index --3way --binary`. The bridge never publishes a
   separate prefix patch artifact and never combines prefix bytes with
   child bytes into a new patch.
10. Write the staged tree via `git write-tree` and verify it equals
    `descriptor.tree_id`. Recompute the regular-file inventory directly
    from that index and verify its digest, file count, and byte length
    against the descriptor. `git rev-parse HEAD^{tree}` is **not** used
    because `HEAD` still names `B` after `git apply --index`.
    A mismatch raises `bridge-reconstruction-mismatch` and the
    operator must create a fresh source workspace — the bridge never
    silently re-derives `S`.
11. Apply the child patch against the verified staged tree.
12. Commit the integration (`B` → `B+prefix+child`), import the
    objects into the canonical repository, and CAS-update
    `request.integration_ref`.
13. Persist a `GitEffectPrepared` postcondition that carries the
    bridge descriptor reference so `assertPostcondition` can
    re-verify the B↔S lineage at reconciliation time without
    re-reading source-workspace bytes.

## What the bridge does NOT do

- It does **not** concatenate prefix bytes with child bytes.
- It does **not** synthesize a combined digest.
- It does **not** rewrite the original patch's `evidence[*].subject_digest`.
- It does **not** expose `repository_canonical_path` on the public
  descriptor; only `repositoryRef` and `repositoryFingerprint` are
  bound, and host-owned canonical operations resolve
  `authority.grant.repository.canonical_path` internally.
- It does **not** query the canonical repository to "verify S as a
  descendant of B"; `S` is not an object there.

## `PreparedSourceWorkspace` extension

The host-owned source workspace read API now exposes the bridge
identity in addition to the existing opaque fields:

| Field | Source | Purpose |
|---|---|---|
| `repositoryRef` | `intent.requested_ref` | Pinned at prep time. |
| `repositoryFingerprint` | `intent.repository_fingerprint` | Re-validated on every `read`. |
| `allowedPaths` | Source grant's `allowedPaths` | Bridge checks intersection with `grant.allowed_source_paths`. |
| `patches` | `intent.patches` (immutable lineage) | Bridge re-verifies byte-for-byte. |
| `patchesDigest` | `sha256Canonical({...patches})` | No patch bytes, no private paths. |

The bridge never reads `prepared.sourcePath`; it uses
`prepared.checkoutPath` only to run `git rev-parse HEAD` /
`git rev-parse HEAD^{tree}`.

## Recovery contract

- The bridge is a recovery boundary. After `persistPrepared`, the
  source workspace, descriptor, and any resolved patch bytes stay
  untouched.
- Uncertain canonical writes are observed by `reconcileGitEffect`
  only; the bridge never replays an uncertain canonical write.
- A `bridge-reconstruction-mismatch` is a hard stop: the operator
  must create a fresh source workspace. The bridge never silently
  re-derives `S`.

## Schema digest stability

The `git_integrate` request schema digest remains the **existing**
`effectRequestSchemaDigest("git_integrate")`. The new
`source_workspace_descriptor` sibling is purely additive; existing
operator authorities continue to bind without re-pinning.