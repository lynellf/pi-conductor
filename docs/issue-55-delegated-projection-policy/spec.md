# Issue #55 — Declarative projection policy for delegated subagents

**Status:** Draft — requires overseer acknowledgement before implementation.
**Authority:** GitHub #55; compatible with the archived FSM specification, #48, #51, and #52.

## Objective

Let a subagent profile, rather than a parent-model prompt alone, declare the narrow
repository view required for every delegated child using that profile. The host must
resolve each child to an auditable, bounded exact-file set before creating its
worktree. The parent remains the only role that can run commands, verify results,
commit, or reconcile a child branch.

This is host/manifest behavior only. It does not change the reducer, checkpoint,
FSM topology, or role-level single-active rule. Delegation remains bounded
concurrency inside the active parent.

## Proposed manifest contract

A subagent profile may opt into the following strict `workspace` block:

```yaml
subagents:
  - name: focused-implementer
    models: [{ model: anthropic:claude-sonnet-4-5, effort: high }]
    max_session_cost_usd: 2
    system_prompt: .pi/subagents/focused-implementer.md
    workspace:
      projection:
        required: false
        allowed_paths: [src, tests]
        default_paths: [src/parser, tests/parser]
```

`workspace` is deliberately limited to `projection`; child workspaces are already
always isolated Git worktrees. `backend`, `source`, `mounts`, `shell`, `image`, and
`network` are role-workspace concepts and are invalid in a subagent profile.

### Path grammar and expansion decision

Policy entries are safe, repository-relative **literal paths**. They contain no
absolute/root/home form, `.`/`..`, backslash, NUL, glob, or pattern syntax. They are
not glob patterns.

A policy entry denotes either:

1. an exact tracked file when it exactly equals a clean parent's materialized Git `H`
   path; or
2. a literal directory root, expanded by the **host** to materialized `H` paths having
   that entry plus `/` as a prefix.

The host never delegates a raw directory or glob to Git sparse-checkout. It sorts and
deduplicates the expanded result into exact file paths before child creation. A
runtime `delegate.tasks[].projection_paths` remains exact-file-only; a directory
there is rejected because it is not an `H` file.

### Policy validity

For `workspace.projection`:

- `required` is an explicit boolean.
- `allowed_paths` is a non-empty, duplicate-free list of at most 64 safe literals.
- `default_paths`, if present, is non-empty, duplicate-free, at most 64 safe literals,
  and every entry is lexically covered by an `allowed_paths` entry (same literal or
  beneath its literal directory root).
- `required: true` forbids `default_paths`: every task must supply a non-empty runtime
  exact-file projection.
- `required: false` requires non-empty `default_paths`: omission is still scoped, not
  a legacy broad-worktree fallback.
- A profile with no `workspace.projection` retains Issue #52 behavior unchanged.

The parser rejects ill-shaped or incompatible `workspace` profile blocks. Manifest
validation reports typed errors for empty, duplicate, unsafe, incompatible, and
default-outside-allowed settings.

## Effective authority and resolution

For every `delegate` batch, the existing clean-parent gate runs first. At one clean
parent `HEAD`, the host captures its materialized exact `H` file set `H`. It then
resolves each task independently:

- **No profile policy:** preserve #52 exactly. An explicit runtime exact-file subset
  must be in `H`; an omitted subset inherits sparse-parent `H`, or stays a legacy full
  child worktree for a non-sparse parent.
- **`required: true`:** omitted `projection_paths` fails closed before any worktree or
  child session exists. Supplied exact files must be a non-empty subset of both the
  profile's expanded `allowed_paths` and `H`.
- **`required: false`:** omitted `projection_paths` becomes the host-expanded
  `default_paths`. Supplied exact files may only *narrow* those defaults: they must be
  a non-empty subset of the expanded defaults and `H`; they cannot select another
  merely-allowed path.

For every policy-controlled child, the resulting effective set `E` must be non-empty,
sorted, deduplicated, and contain at most **64 exact files**. The existing TypeBox
runtime input cap is also 64. Default expansion that produces zero files (for example,
a parent did not materialize its configured root) or more than 64 files fails before
child creation; it never silently shrinks or broadens the projection. `allowed_paths`
are predicates and are not themselves materialized.

Therefore every policy-controlled child satisfies:

```text
E ⊆ profile allowed authority ∩ parent clean materialized H
```

and, where defaults exist, explicit runtime selection additionally satisfies
`E ⊆ expanded defaults`. A policy cannot disclose a parent-potential path that is not
currently materialized. The existing clean-worktree/base-commit checks remain in
force through capture, validation, sparse setup, and child verification.

## Child tools, reconciliation, and observability

Children remain file-only: `read`, `grep`, `find`, `ls`, `edit`, `write`, and
`report_result`. They do not receive shell, `delegate`, `request_files`, `handoff`, or
`end`, and cannot expand their projection. This is path confinement, not an OS,
credential, or network sandbox.

The child receives an isolated sparse worktree configured from `E`. The trusted
parent may retain its existing shell capability, but must reconcile output using the
existing clean gate and explicit verification/integration workflow. The host never
merges, applies, discards, resets, or deletes child branches/worktrees.

Existing records are sufficient and remain additive-compatible:

- accepted policy-controlled children persist the effective `E` in
  `subagent_started.projection_paths`, never raw policy roots;
- rejected omitted/default/over-broad requests append
  `delegation_validation_rejected` with typed error codes and create neither a
  worktree nor a child lifecycle record;
- legacy records preserve their existing optional-field behavior.

## Boundaries

**Always:** validate manifest and runtime inputs before sparse setup; require both
profile policy and clean-parent `H` authority; retain child branches/worktrees;
record accepted effective paths and rejected attempts.

**Ask first:** adding a new child tool, permitting child process execution, changing
the 64-file bound, or introducing a second workspace/projection system.

**Never:** alter reducer/checkpoint/FSM topology; grant a child broader authority than
its current parent; auto-merge/apply/discard child work; claim worktree confinement is
an OS or credential sandbox.

## Testing and success criteria

Table-driven tests prove all of the following:

1. Manifest parsing/validation rejects unsafe, empty, duplicate, default-outside-allow,
and incompatible profile workspace policies.
2. A default literal directory root expands host-side only to its current exact parent
`H` files and records that exact set.
3. A runtime task can narrow defaults but cannot select a policy-allowed path outside
them; it also cannot select a path absent from `H`.
4. A `required: true` profile rejects omission before worktree/session creation.
5. An over-64 default expansion, empty expansion, or broad runtime request fails
before child creation and leaves the parent projection/worktree inventory unchanged.
6. The actual child session is file-only and can neither read outside `E` nor expand
it; a shell-capable parent can receive and explicitly reconcile its retained child
worktree without relaxing the clean-parent gate.
7. A profile-less manifest retains existing #52 delegation behavior unchanged.

## Commands

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm audit
```

No dependency, reducer, checkpoint, or workspace-system change is planned.

## Implementation plan (after acknowledgement only)

### Baseline clean-worktree batch — no primary feature edits

| Owner | Disjoint paths | Deliverable and verification |
| --- | --- | --- |
| `manifest-policy-implementer` | `src/manifest/types.ts`, `src/manifest/parse.ts`, `src/manifest/validate.ts`, `tests/manifest/issue-55.test.ts` | Strict profile policy types/parsing/static checks and table tests. Run targeted manifest tests, typecheck, lint. |
| `delegation-policy-implementer` | `src/host/delegation/projection-policy.ts` (new), `src/host/delegation/delegate-tool.ts`, `src/host/delegation/validate-batch.ts`, `src/host/delegation/worktree.ts`, `src/host/delegation/index.ts` | Pure effective-projection resolution and runtime admission/sparse wiring. Do not touch manifest, persistence, tests, or docs. Run focused delegation tests once integrated; report interface assumptions. |
| `delegation-policy-test-writer` | `tests/host/issue-55-delegation-policy.test.ts` (new) | Non-overlapping behavior tests for default, narrowed, omitted, over-broad, exact-set audit, file-only child, trusted-parent reconciliation, and legacy behavior. May depend on planned public interfaces; do not edit production code or manifest tests. |
| `projection-policy-auditor` | none (read-only) | Authority/security audit of the proposed contract and returned patches: especially directory expansion, `H` capture races, sparse-worktree setup, cap enforcement, and legacy compatibility. |

The parent creates all worktrees from the same clean acknowledged baseline, inspects
every returned diff, and selectively integrates only reviewed changes. It never
auto-merges, discards, or overwrites a child branch.

### Parent integration and finalization

1. Reconcile the three reviewed artifacts against this contract; make only necessary
   integration edits in the primary checkout.
2. Add/update README delegation documentation and this plan's completion status.
3. Run the full command set above; record any pre-existing audit advisory separately.
4. Conduct an adversarial authority review, inspect the final diff, commit atomically,
and report changed files, commands/results, and residual risks.

## Risks

| Risk | Mitigation |
| --- | --- |
| A directory root behaves like a Git glob | Only safe literals are accepted; host expands against captured `H` and sends exact anchored file paths to sparse-checkout. |
| Defaults silently exceed parent authority | Default resolution is against current clean `H`; zero/over-64 output is a typed pre-spawn rejection. |
| Runtime input bypasses defaults | Policy path selection resolves before worktree creation and requires a subset of both default and `H` authority. |
| Legacy delegation changes unexpectedly | Policy is opt-in; an explicit profile-less regression test preserves #52 semantics. |
| Worktree is mistaken for a sandbox | Prompt/docs retain the file-tool path-confinement caveat and child shell remains absent. |

## Acknowledgement requested

Approval confirms the `subagents[].workspace.projection` syntax and, in particular:
policy literals may be exact files or host-expanded literal directory roots; the
materialized child set is exact files capped at 64; and defaults/runtime selections
are always intersected with the clean parent's current materialized `H` authority.
