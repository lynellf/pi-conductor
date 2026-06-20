# Role Scope Revision — Implementation Plan

> **Status:** Plan (planner output). Implements `docs/role-scope-spec.md`.
> Hand to `implementer`; after the implementer is done, route to `reviewer`.

## Scope

Four edits, all in `.pi/`. No `src/`, `tests/`, or default-fixture changes.
Full target content is in `docs/role-scope-spec.md` §4 — apply it verbatim.

## Tasks (ordered)

### Task 1 — Replace `.pi/roles/orchestrator.md`

Set the file to exactly the content in spec §4.1. Key properties to verify
after writing:
- Header: "Dispatch and routing only."
- No `read`-as-available language; the closing line names only `handoff`,
  `end`, and `ask_user`.
- No spec/plan/implement classification, no "unclear/partial" judgment
  language.
- Mechanical review gate: `end` only after `reviewer` sign-off / `ask_user`
  stop.

### Task 2 — Edit `.pi/conductor.yaml` (orchestrator tools only)

Change the single line under the `is_orchestrator: true` block:

```yaml
    tools: [read, handoff, end]
```
→
```yaml
    tools: [handoff, end]
```

Do **not** touch the `planner`, `implementer`, or `reviewer` `tools:` lines.

### Task 3 — Replace `.pi/roles/planner.md`

Set the file to exactly the content in spec §4.3. Verify the new bullets are
present:
- "Classify the work once you understand it (spec / plan / implement /
  review)…"
- "If the orchestrator hands off only to get a routing recommendation…"

### Task 4 — Replace `.pi/roles/reviewer.md`

Set the file to exactly the content in spec §4.4. Verify:
- "You are the sole quality gate." framing.
- References the `code-review-and-quality` skill.
- Approve / Concerns verdict contract with `suggests_next`.
- "Do not silently fix issues yourself" rule.

## Verification (run after all four edits)

1. `cat .pi/roles/orchestrator.md` — matches spec §4.1 exactly.
2. `grep -n "tools:" .pi/conductor.yaml` — orchestrator shows
   `tools: [handoff, end]`; the other three role tool lists unchanged
   (`[read, edit, write, bash, handoff, end]` ×2 and
   `[read, grep, handoff, end]`).
3. `cat .pi/roles/planner.md` — matches spec §4.3 exactly.
4. `cat .pi/roles/reviewer.md` — matches spec §4.4 exactly.
5. `git status --short` — only `.pi/roles/orchestrator.md`,
   `.pi/roles/planner.md`, `.pi/roles/reviewer.md`, and
   `.pi/conductor.yaml` are modified by this change (plus the uncommitted
   docs from prior runs, which are not this change's concern). No `src/` or
   `tests/` files touched.
6. `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check` — all
   green (no source/test changes; role-config is not compiled or tested).
7. `pnpm test` includes `tests/grep-guard.test.ts` and
   `tests/host/defaults.test.ts` — both must still pass (default fixture
   untouched).

## Notes for the implementer

- The working tree already has uncommitted rewrites of `orchestrator.md` and
  `planner.md` from a prior run. This change **replaces** them with the spec
  §4 content — do not layer on top of the existing uncommitted text.
- Use full-file writes for the three `.md` files (the spec gives exact
  content) and a single-line `edit` for `conductor.yaml`.
- Do not delete the superseded docs
  (`role-prompt-audit.md`, `role-scope-refactor-plan.md`,
  `role-scope-trim-plan.md`) — out of scope; leave them.
- Do not touch `tests/fixtures/default-conductor/`.

## Hand-off

After verification is green, hand back to the orchestrator with
`suggests_next: reviewer`. The reviewer should check: the split is clean, no
investigation/classification language remains in `orchestrator.md`, the
planner absorbed the moved work, the reviewer prompt is a credible sole
quality gate, and the three flagged judgment calls in spec §7 are acceptable.
