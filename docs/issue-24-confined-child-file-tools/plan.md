# Plan — Issue #24: Confine child file tools

**Source:** GitHub issue [#24](https://github.com/lynellf/pi-conductor/issues/24)
and the delegation-lite spec §6, §8, and §10.

## Objective

Replace the SDK-provided child `read`, `grep`, `find`, `ls`, `edit`, and
`write` tools with conductor-owned wrappers that preserve their SDK behavior
but reject access outside the generated child worktree. The existing constrained
`run` tool remains unchanged.

## Design

- Construct the SDK file-tool definitions and override them by name through
  `customTools`; Pi resolves custom definitions after built-ins.
- Before each file-tool execution, reject absolute paths and `..` segments.
- For an existing target, resolve it through `realpath` and require it to remain
  below the worktree root. For a new write target, resolve its nearest existing
  ancestor first, preventing writes through an ancestor symlink.
- Keep the construction in `buildChildTools`, so both `ProductionHost` and
  `StubHost` use the same child-session factory.

## Tasks

### Task 1 — Add child file-tool confinement

- [x] Wrap all six child file tools with worktree-path validation.
- [x] Keep normal in-worktree operations and the constrained `run` tool intact.

### Task 2 — Prove the child-session boundary

- [x] Add tests that create a real child SDK session and invoke the registered
      tool definitions for absolute paths, traversal, symlink escapes, and
      normal in-worktree paths.
- [x] Verify the custom definitions replace the built-in names in the actual
      session passed to `createAgentSession`.

### Task 3 — Document and verify

- [x] Update README child-boundary language to describe file-tool confinement.
- [ ] Run focused, repository, and security verification gates.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A wrapper differs from an SDK file tool | Reuse the SDK definition and only preflight its path. |
| Symlink escape on a new path | Resolve the nearest existing ancestor with `realpath` before dispatch. |
| Host parity drifts | Keep the shared `buildChildTools` factory as the only child-tool construction path. |
