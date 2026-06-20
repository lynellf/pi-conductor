# Role Scope Refactor — Move Investigation Work from Orchestrator to Planner

> **Status:** Plan (for implementer). Do not self-review; hand to reviewer after
> the implementer applies the edits.

## Goal

The orchestrator role definition currently asks it to determine "the best
available role suited for the task," which is investigation/scoping work. That
deliberation belongs to the planner. Slim the orchestrator to mechanical
routing + coordination, and expand the planner to explicitly own
investigation, context-gathering, and option enumeration before producing any
artifact.

## Decisions per block

### `.pi/roles/orchestrator.md`

| Block | Decision | Reason |
|---|---|---|
| "delegate to the best available role suited for the task" | **Simplify** — replace the "best suited" judgment with mechanical routing to the planner (for new work) and the reviewer (for completed work). | Determining "best suited" is scoping/deliberation → planner's job. The orchestrator should route, not evaluate. |
| "If unsure of what to do, prompt the user for clarification" | **Keep** (rephrased, nested under routing). | Ambiguity about whether to route at all is genuinely orchestrator-level. |
| "Ensure any task completed by a planner or implementer is submitted to a reviewer" | **Keep** (rephrased as routing). | Coordination of completed work → reviewer is genuinely orchestrator-level. |
| _(new)_ "Do not investigate, research, or scope tasks yourself" | **Add** — explicit boundary. | Makes the role split unambiguous so the orchestrator doesn't drift back into deliberation. |

### `.pi/roles/planner.md`

| Block | Decision | Reason |
|---|---|---|
| _(new)_ Investigation & scoping block | **Add** at the top. | This is the work moved from the orchestrator: read code/docs/specs, gather context, enumerate options, surface assumptions, hand back to orchestrator with a clarifying question if still ambiguous. |
| "Before generating a plan, generate a spec document" | **Keep** (add period for consistency). | Existing behavior, unchanged. |
| "After generating a spec document, hand it off for review" | **Keep** (add period). | Existing behavior, unchanged. |
| "When receiving a spec document, translate it into an actionable plan for implementation" | **Keep** (add period). | Existing behavior, unchanged. |
| "When receving a plan document, generate multi-step plan artifacts…" | **Keep**, fix typo `receving` → `receiving`, add period. | Existing behavior, unchanged; typo fix is incidental. |
| "Ensure generated plans and specs are consumable by models with small context windows" | **Keep** (add period). | Existing behavior, unchanged. |

### `.pi/conductor.yaml`

No changes. The orchestrator's tool list `[read, handoff, end]` is left as-is:
`read` is still useful for minimal context needed to route (e.g., checking
whether a handed-back artifact is a spec vs. a plan). The behavioral
instruction — not the tool list — is what enforces the boundary. If the
reviewer later judges that `read` tempts the orchestrator into investigation,
removing it is a follow-up, not part of this change.

---

## Exact edits

### Edit 1 — `.pi/roles/orchestrator.md` (full replacement)

**Before** (current full file content):

```markdown
- When receiving requests, always delegate to the best available role suited for
  the task.
  - If unsure of what to do, prompt the user for clarification.
- Ensure any task completed by a planner or implementer is submitted to a
  reviewer.
```

**After:**

```markdown
- Route incoming requests to the planner for investigation and scoping.
  - If the request is ambiguous, prompt the user for clarification before
    routing.
- Route completed work from the planner or implementer to the reviewer.
- Do not investigate, research, or scope tasks yourself — that is the planner's
  role.
```

### Edit 2 — `.pi/roles/planner.md` (full replacement)

**Before** (current full file content):

```markdown
- Before generating a plan, generate a spec document
- After generating a spec document, hand it off for review
- When receiving a spec document, translate it into an actionable plan for
  implementation
- When receving a plan document, generate multi-step plan artifacts and write
  them to docs/<plan-name>/phase-<num>-<sub-plan-name>.md
- Ensure generated plans and specs are consumable by models with small context
  windows (less than 300K tokens)
```

**After:**

```markdown
- Investigate and scope incoming requests before producing any artifact:
  - Read the relevant code, docs, and specs to gather context.
  - Enumerate options and surface assumptions; do not silently fill gaps.
  - If the request is still ambiguous after investigation, hand back to the
    orchestrator with a clarifying question.
- Before generating a plan, generate a spec document.
- After generating a spec document, hand it off for review.
- When receiving a spec document, translate it into an actionable plan for
  implementation.
- When receiving a plan document, generate multi-step plan artifacts and write
  them to docs/<plan-name>/phase-<num>-<sub-plan-name>.md.
- Ensure generated plans and specs are consumable by models with small context
  windows (less than 300K tokens).
```

---

## Verification (for implementer, after applying)

1. `cat .pi/roles/orchestrator.md` — confirm it matches Edit 1 "After" block
   exactly.
2. `cat .pi/roles/planner.md` — confirm it matches Edit 2 "After" block exactly
   and that the `receving` typo is gone.
3. No other files modified (`git status` should show only the two role files).
4. Hand off to the reviewer to check the split is clean and no investigation
   language remains in the orchestrator file.
