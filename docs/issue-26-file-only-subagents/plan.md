# Plan — Issue #26: File-only subagents

**Source:** GitHub issue [#26](https://github.com/lynellf/pi-conductor/issues/26)
and the delegation-lite spec §5–§6.

## Objective

Remove all process execution from child sessions. Children may only inspect and
modify their generated worktree through confined file tools; the calling parent
owns verification, commits, and integration.

## Decisions

- Remove the child `run` tool and its implementation; do not replace it with a
  restricted process sandbox.
- A child-reported `completed` result remains `completed` only when its verified
  worktree is dirty relative to `base_commit`; otherwise it becomes `no_changes`.
- A child worktree's branch remains uncommitted and preserved for the parent or
  operator. No automatic commit, merge, cherry-pick, or cleanup is added.

## Tasks

### Task 1 — File-only child session

- [x] Remove `run` from the child tool factory, SDK allowlist, and child prompts.
- [x] Prove an actual child SDK session contains only confined file tools, with
      no `run` or `bash`; production adds only the terminating `report_result` tool.

### Task 2 — Uncommitted result adjudication

- [x] Change worktree verification so dirty, unchanged-HEAD worktrees are
      `completed` and clean worktrees are `no_changes`.
- [x] Normalize a completed/no-change mismatch consistently and retain existing
      failure and cancellation behavior.

### Task 3 — Documentation and verification

- [x] Update the delegation spec and README ownership boundary.
- [x] Run focused and repository verification gates.

## Verification

- `pnpm test -- tests/host/delegation.test.ts` — 800 tests passed (Vitest runs
  the repository suite).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`, and
  `pnpm test` — passed.
- `pnpm audit --prod` — completed but reports seven inherited `undici`
  advisories (three high) through `@earendil-works/pi-coding-agent`; this change
  adds no dependency and does not remediate that separate release blocker.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Children still execute code indirectly | Expose no process-execution tool in the actual SDK session. |
| A false completed report masks no work | Host derives the terminal status from verified Git worktree state. |
| Parent workflow becomes unclear | Document the parent-owned test, commit, and integration sequence. |
