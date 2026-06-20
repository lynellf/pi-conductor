# Role Scope Trim — Make the Orchestrator Dispatch-Only

> **Status:** Plan (for implementer). Do not self-apply; hand to `reviewer`
> after the implementer is done. Supersedes `docs/role-scope-refactor-plan.md`
> (an earlier, less aggressive attempt that deliberately kept `read` — that
> gap is what the user is still seeing).

## What I found (investigation basis)

- **Committed (HEAD) `.pi/roles/orchestrator.md`** is a 5-line file: "delegate
  to the best available role suited for the task" + reviewer routing. The
  committed `conductor.yaml` gives the orchestrator tools
  `[read, bash, handoff, end]`.
- **Uncommitted working-tree edits already exist** — a prior run rewrote
  `orchestrator.md` and `planner.md` into elaborate "In scope / Out of scope"
  versions and removed `bash` from the orchestrator's tools (now
  `[read, handoff, end]`). That prior run *also* wrote this kind of plan
  doc — which is itself an instance of the orchestrator doing planning work
  it should have handed off.
- **No `DEVELOPER_POLICY` file exists** in the repo or `~/.agents`. The
  "Out of scope — hand off instead" list the prior handoff referenced is the
  section inside the current uncommitted `orchestrator.md` — the prior
  orchestrator was describing its own in-progress edits.
- **Overreach that REMAINS in the current uncommitted `orchestrator.md`**,
  even after the prior attempt:
  1. "classify it (spec / plan / implement / review / clarify)" —
     spec-vs-plan-vs-implement classification is the planner's scoping job.
  2. "route each worker's output to the next worker … when the run is
     complete" — deciding sequence and run-completion requires assessing
     worker output = light planning.
  3. "if a worker hands back unclear or partial work" — judging
     completeness/quality is the reviewer's job.
  4. `read` is still in the orchestrator's tool list — the single biggest
     enabler of investigation. The prior plan deliberately kept it; that is
     the gap the user is still feeling.

## Goal

Trim the orchestrator to **mechanical dispatch/routing only**, enforced by
both prose **and** removing `read` from its tool list (so it physically cannot
read source/transcripts). Move the classification + routing-recommendation
work explicitly into the planner.

## Decisions

| File | Change | Reason |
|---|---|---|
| `.pi/roles/orchestrator.md` | Full replacement with the "After" block below. Removes fine-grained classification, output-content assessment, and "unclear/partial" judgment; routes on worker-declared intent only. | Kills the three remaining overreach points in prose. |
| `.pi/conductor.yaml` | Orchestrator `tools:` `[read, handoff, end]` → `[handoff, end]`. | Mechanical enforcement: without `read` the orchestrator cannot investigate even if tempted. |
| `.pi/roles/planner.md` | Full replacement with the "After" block below. Adds explicit ownership of spec/plan/implement classification and the "routing-recommendation" case. | Absorbs the work removed from the orchestrator; closes the loop for "orchestrator can't tell new-from-complete without investigation". |

**Out of scope for this change** (do not touch):
- The `handoff` / `end` tool implementations and FSM behavior.
- Any other role's tool list.
- The `docs/role-scope-refactor-plan.md` file (superseded; leaving it in place
  is harmless — deletion is optional and not required).

### The one judgment call (flagged for reviewer)

Removing `read` from the orchestrator is the strongest single lever and matches
the user's intent ("stop performing research/investigation"). The prior plan
argued `read` is needed "to read a brief or a worker's output enough to route
it correctly" — but worker output arrives **as the handoff reason /
`suggests_next` text**, and the user's request arrives as the initial message;
the orchestrator never needs to open a file to route. If the reviewer disagrees,
the fallback is to keep `[read, handoff, end]` and rely on prose alone — but
that is the status quo the user is rejecting.

## Exact edits (apply as full-file replacements)

### Edit 1 — `.pi/roles/orchestrator.md`

**Before** (current working-tree content):

```markdown
# Orchestrator

Dispatch and routing only. You do **not** investigate, research, or design.

## In scope

- Read the user's request and classify it (spec / plan / implement / review / clarify).
- When the request is ambiguous, use `ask_user` to surface the ambiguity — do
  not resolve it by reading code or transcripts yourself.
- Dispatch via `handoff` to the right worker with a concrete, well-bounded brief.
- Track multi-step runs: route each worker's output to the next worker, to
  `reviewer`, or to `end` when the run is complete.
- Keep the run moving: if a worker hands back unclear or partial work, re-route
  or clarify — don't absorb the unfinished work yourself.

## Out of scope — hand off instead

If the request needs any of these, hand off to `planner` (or `reviewer` for
judgment-only checks). Do **not** do them yourself, even though `read` is
available to you:

- Reading source code to understand the codebase or weigh options.
- Reading run transcripts or run memory to figure out what happened.
- Weighing trade-offs across multiple files or approaches.
- Drafting spec or plan content; deciding implementation approach.
- Any "figure out what's going on" work.

`read` is available so you can read a brief or a worker's output enough to
route it correctly — not so you can do the worker's investigation.

## Review gate

- Ensure any task completed by a planner or implementer is submitted to a
  reviewer before the run ends.
```

**After** (set the file to exactly this):

```markdown
# Orchestrator

Dispatch and routing only. You do **not** investigate, research, scope, or
design — that is the planner's job. You do **not** judge whether work is
correct or complete — that is the reviewer's job.

## In scope

- Receive the user's request. If it is new work, hand off to `planner`. If it
  is a question about already-completed work, hand off to `reviewer`. If you
  cannot tell which without reading code or transcripts, hand off to
  `planner` to investigate and recommend a route — do not investigate
  yourself.
- If the request is ambiguous about *intent* (not about code), use `ask_user`
  before routing. Do not resolve ambiguity by reading code or transcripts.
- Route worker output based on the worker's **declared** next step, not your
  own assessment of the work: if a worker says "hand to implementer", route
  to `implementer`; if it says "ready for review", route to `reviewer`; if it
  says "run complete", call `end`. Do not open files to double-check.
- If a worker signals it is blocked, or its output does not match its declared
  intent, re-dispatch to the same worker with a sharper brief or use
  `ask_user` — do not absorb the unfinished work yourself.
- Before calling `end`, ensure any work done by `planner` or `implementer` has
  been routed through `reviewer`.

## Out of scope — hand off instead

Do **not** do any of these, even to "help" routing:

- Read source code, specs, plans, or transcripts to understand the codebase
  or weigh options.
- Classify a request as spec vs. plan vs. implement — that scoping is the
  planner's.
- Judge whether a worker's output is correct, complete, or good — that is the
  reviewer's.
- Draft spec, plan, or implementation content.
- Any "figure out what's going on" work.

You have only `handoff` and `end`. If you feel you need to `read` something,
that is a signal you should have handed off to `planner` instead.
```

### Edit 2 — `.pi/conductor.yaml`

**Before** (current working-tree line):

```yaml
    tools: [read, handoff, end]
```

**After:**

```yaml
    tools: [handoff, end]
```

This is the only line changed in `conductor.yaml`. It appears under the
`orchestrator` role entry (the `is_orchestrator: true` block). Do not touch
the `planner`, `implementer`, or `reviewer` tool lists.

### Edit 3 — `.pi/roles/planner.md`

**Before** (current working-tree content):

```markdown
# Planner

Investigate, then specify, then plan. You own the "figure out what's actually
going on" step — the orchestrator does not.

## Investigate first

- Before generating a spec or plan, investigate: read the relevant code,
  transcripts, prior plans, and run memory.
- Produce a brief "what I found" section at the top of the spec (or as a
  short investigation note) so the basis for the plan is visible.
- When the orchestrator hands off, treat its brief as a starting point.
  Confirm your understanding; if anything is ambiguous, `ask_user` before
  planning. Do **not** dispatch onward until investigation surfaces a concrete
  spec or plan.

## Spec

- Before generating a plan, generate a spec document.
- After generating a spec document, hand it off for review.

## Plan

- When receiving a spec document, translate it into an actionable plan for
  implementation.
- When receiving a plan document, generate multi-step plan artifacts and write
  them to `docs/<plan-name>/phase-<num>-<sub-plan-name>.md`.
- Ensure generated plans and specs are consumable by models with small context
  windows (less than 300K tokens).
```

**After** (set the file to exactly this):

```markdown
# Planner

Investigate, then specify, then plan. You own the "figure out what's actually
going on" step — the orchestrator does not.

## Investigate first

- Before generating a spec or plan, investigate: read the relevant code,
  transcripts, prior plans, and run memory.
- Produce a brief "what I found" section at the top of the spec (or as a
  short investigation note) so the basis for the plan is visible.
- Classify the work once you understand it (spec / plan / implement / review)
  — the orchestrator does not classify beyond "new work vs. question about
  completed work".
- If the orchestrator hands off only to get a routing recommendation (it
  could not tell new-from-complete without investigation), investigate, then
  hand back to the orchestrator with a concrete route recommendation — do not
  force a spec when the request was really a routing question.
- When the orchestrator hands off, treat its brief as a starting point.
  Confirm your understanding; if anything is ambiguous, `ask_user` before
  planning. Do **not** dispatch onward until investigation surfaces a concrete
  spec or plan.

## Spec

- Before generating a plan, generate a spec document.
- After generating a spec document, hand it off for review.

## Plan

- When receiving a spec document, translate it into an actionable plan for
  implementation.
- When receiving a plan document, generate multi-step plan artifacts and write
  them to `docs/<plan-name>/phase-<num>-<sub-plan-name>.md`.
- Ensure generated plans and specs are consumable by models with small context
  windows (less than 300K tokens).
```

## Verification (for implementer, after applying)

1. `cat .pi/roles/orchestrator.md` — matches Edit 1 "After" exactly; contains
   no `read`-as-available language and no spec/plan/implement classification
   or "unclear/partial" judgment language.
2. `grep -n "tools:" .pi/conductor.yaml` — the orchestrator entry shows
   `tools: [handoff, end]`; planner/implementer/reviewer tool lists unchanged.
3. `cat .pi/roles/planner.md` — matches Edit 3 "After" exactly; includes the
   new classification-ownership and routing-recommendation bullets.
4. `git status --short` — only `.pi/roles/orchestrator.md`,
   `.pi/roles/planner.md`, and `.pi/conductor.yaml` are modified by this
   change (the pre-existing uncommitted edits to those same three files are
   replaced, not added on top of).
5. No source under `src/` or `tests/` is touched; `pnpm test` / grep-guard
   unaffected (this change is role-config + docs only).

## Hand-off

After verification, hand to `reviewer` to check that the split is clean, no
investigation language remains in the orchestrator file, and the planner has
absorbed the moved work. The reviewer should specifically weigh the flagged
judgment call (removing `read` from the orchestrator).
