# Phase 0 — Close already-resolved issue #11

**Source:** [`../plan.md`](../plan.md) §"Status of the two open issues
at plan time" — issue #11 is already implemented by commit `6f962f2`
(Phase 1, open-issues-round-2). This phase precedes Phase 1.

**Branch / PR:** none — no code change. One `gh issue close` action.

**Goal:** bring the open-issues list in line with reality. Issue #11
was implemented by commit `6f962f2` (`feat: fix issue #8 - TUI
disjointed output`, 2026-07-02); the same commit that fixed the
related #8 bug also removed the per-chunk `text_stream` emission that
#11 describes. The plan-time triage produces one comment that links
to the existing implementation, then closes the issue as `completed`.

## Task 0.1 — Close #11 with a pointer to the current behavior

**Description:** Post a comment on issue #11 citing the commit
(`6f962f2`) that removed the described behavior, pointing at the
current `message_end`-only emission site and the existing test that
pins the contract, then close as `not_planned`-style completion (the
work is done, not abandoned).

**Acceptance criteria:**

- [ ] `gh issue view 11 --repo lynellf/pi-conductor --json state`
      returns `"state": "CLOSED"`.
- [ ] `gh api repos/lynellf/pi-conductor/issues/11/comments` shows the
      posted comment as the most recent comment.
- [ ] The comment body cites:
  - the implementation commit (`6f962f2`)
  - the current emission site
    (`src/host/session-event-handler.ts:183` — `onDisplay?.({ role, kind: "text", text })` at `message_end`)
  - the test that pins the contract
    (`tests/host/display-forwarding.test.ts` — "Single-emit per turn"
    describe block, ~line 215)
  - the Phase 1 archived plan that documents the change
    (`docs/archive/open-issues-round-2/phase-1-issue-8-tui-disjointed.md`)
  - why Option B (discriminator field) was **not** chosen: the host
    no longer emits multiple events per message, so a `delta` vs
    `final` discriminator would be dead code.
- [ ] The comment does **not** claim new work was done; it
      acknowledges that this issue was resolved on `main` by the same
      commit that fixed #8 and is being closed now.

**Verification:**

- [ ] `gh issue view 11 --repo lynellf/pi-conductor --json state,stateReason`
      returns `state: CLOSED`, `stateReason: COMPLETED` (or equivalent
      admin-set reason).
- [ ] The post-#11 open-issues list shows only #12 remaining (addressed
      by Phase 1).

**Dependencies:** None.

**Files likely touched:** None — `gh` CLI only.

**Estimated scope:** XS (two commands).

## Checkpoint: end of Phase 0

- [ ] Issue #11 is `CLOSED` on `lynellf/pi-conductor`.
- [ ] Open-issue list now shows only #12.
- [ ] No `pnpm` commands run (no code change).

## Suggested `gh` invocations (for reference)

```bash
gh issue comment 11 --repo lynellf/pi-conductor --body '…'
gh issue close 11 --repo lynellf/pi-conductor --reason completed
```

The exact comment body is at the implementer's discretion; see
"Acceptance criteria" for the required citations.

## Suggested comment body (skeleton for the implementer)

> Closing as already implemented — the per-chunk `text_stream`
> emission path that this issue describes was removed in commit
> `6f962f2` (Phase 1, open-issues-round-2), the same commit that
> fixed the related #8 TUI disjointed output bug.
>
> Current behavior:
> - One `DisplayEvent` per assistant turn at `message_end` (full
>   text, no progressive chunks): see
>   `src/host/session-event-handler.ts` ~lines 160-184 (the
>   `message_start`/`message_update` cases `return` immediately; the
>   `message_end` case emits one `kind: "text"` event with the full
>   extracted text).
> - The `DisplayEventKind` type still includes `"text_stream"` for
>   backward compatibility, but the host never emits it
>   (`src/host/display-sink.ts` docstring notes this).
> - Pinned by `tests/host/display-forwarding.test.ts` — "Single-emit
>   per turn" describe block.
>
> Option B (a `kind: 'delta' \| 'final'` discriminator) was considered
> but is unnecessary: the host does not emit multiple events per
> message, so a `delta` vs `final` discriminator would be dead code.
>
> Detailed design: `docs/archive/open-issues-round-2/phase-1-issue-8-tui-disjointed.md`.
> Closing as completed; please reopen if live progressive text
> streaming is reintroduced in the future.

## Plan-sufficiency note

This phase is dispatchable in a single, short session (XS scope per
task). It does not need a reviewer pass before Phase 1 begins.