# Role Scope Revision — Orchestrator Dispatch-Only, Planner Owns Investigation, Reviewer Is the Sole Quality Gate

> **Status:** Spec (planner output). Supersedes `docs/role-prompt-audit.md`,
> `docs/role-scope-refactor-plan.md`, and `docs/role-scope-trim-plan.md`
> (earlier attempts that were never applied). Hand to reviewer for spec
> review before the implementer applies edits.

## 1. What I found (investigation note)

- **Working tree vs HEAD.** HEAD's `.pi/roles/orchestrator.md` is a 5-line
  "delegate to the best available role" file and `conductor.yaml` gives the
  orchestrator `tools: [read, bash, handoff, end]`. The working tree has an
  uncommitted rewrite (the elaborate "In scope / Out of scope" version with
  `tools: [read, handoff, end]`) plus three uncommitted plan/audit docs. None
  of the prior plans have been applied — the orchestrator still deliberates,
  which is what the user is still seeing.
- **`ask_user` is force-injected.** `buildToolsAllowlist`
  (`src/host/production-host-resolve.ts`) appends `handoff`, `end`, and
  `ask_user` to every role's declared tool list regardless of the manifest.
  So `ask_user` does **not** need to be declared for the orchestrator to use
  it. This resolves open question Q1 from the prior audit: the orchestrator
  manifest entry should be `tools: [handoff, end]` and `ask_user` remains
  available.
- **`handoff`/`end` are also force-injected**, but `manifest/validate.ts`
  emits a `missing-required-tool` **warning** (not error) if a role's
  declared `tools:` omits them. So `tools: [handoff, end]` is the cleanest
  expression that (a) declares no investigation tools, (b) avoids the
  warning, and (c) makes intent explicit. `tools: []` would also work but
  reads as "forgot to configure."
- **No test pins the repo `.pi/conductor.yaml` tool list.** Inline test
  fixtures (`tests/host/scaffold.test.ts`, `production-host*.test.ts`,
  `tests/extension/tui-bridge.test.ts`, `tests/manifest/{parse,validate}.test.ts`)
  use `[read, handoff, end]` / `[read, bash, handoff, end]` as scaffolding,
  not as assertions on the repo manifest. Removing `read` from the
  orchestrator breaks no test. The grep-guard test enforces no-pi-imports in
  core layers — unaffected by role-config changes.
- **`planner.md` already owns investigation** ("You own the 'figure out
  what's actually going on' step — the orchestrator does not"). It needs to
  also explicitly own request classification (spec/plan/implement/review)
  and the "routing-recommendation" case, since the trimmed orchestrator no
  longer classifies beyond "new work vs. question about completed work."
- **`reviewer.md` is currently a one-liner** ("Refer to related skills for
  reviewing submitted plans, or code"). Once the orchestrator stops judging
  output quality, the reviewer becomes the **sole** quality gate. It must be
  strengthened to state what it reviews, how it returns verdicts, and that
  `end` is gated on its sign-off. It keeps `tools: [read, grep, handoff, end]`
  (it must be able to read code/specs/plans to judge them).
- **Default-conductor fixture is out of scope** (user-confirmed). The shipped
  template at `tests/fixtures/default-conductor/.pi/roles/orchestrator.md`
  is a generic minimal scaffold, intentionally separate from the repo's live
  anti-deliberation posture. `tests/host/defaults.test.ts` asserts that
  fixture's prompt matches `/# Orchestrator/` — untouched by this change.

## 2. Goal

Trim the orchestrator to **mechanical dispatch and routing only**, enforced
by both prose **and** removing `read` from its tool list (so it physically
cannot investigate). Move request classification and routing-recommendation
work explicitly into the planner. Strengthen the reviewer so it is the sole,
unambiguous quality gate. The orchestrator routes on **declared worker
intent**, never on its own assessment of output quality.

## 3. Design principles

1. **Route on signals, not assessment.** The orchestrator decides the next
   role from the user's message (first turn) or the worker's handback text
   (`reason` / `suggests_next`) on later turns. It never opens files to
   decide, and never judges output quality.
2. **Default to `planner` when uncertain.** The planner investigates and
   either produces a spec/plan or hands back a routing recommendation. It
   never blocks the orchestrator.
3. **Mechanical review gate.** After any `planner` or `implementer` handback,
   the next dispatch is to `reviewer` (never straight to `end`). `end` is
   legal only after a `reviewer` sign-off, or after `ask_user` resolves to a
   stop / the run is provably unable to proceed.
4. **Forward, don't compose.** The orchestrator's brief to a worker is the
   user's request (lightly restated) plus any prior worker's `suggests_next`
   — never research it writes itself.
5. **Tool list = enforcement.** Prose alone is insufficient; the orchestrator
   must not have `read`. The reviewer **must** keep `read` + `grep` so it can
   judge artifacts against the codebase.

## 4. Final file contents

### 4.1 `.pi/roles/orchestrator.md` (full replacement)

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

You have only `handoff` and `end` (plus `ask_user`, which is always
available). If you feel you need to `read` something, that is a signal you
should have handed off to `planner` instead.
```

### 4.2 `.pi/conductor.yaml` — orchestrator `tools` only

Change the single line under the `is_orchestrator: true` block:

```yaml
    tools: [read, handoff, end]
```
→
```yaml
    tools: [handoff, end]
```

Do **not** touch the `planner`, `implementer`, or `reviewer` tool lists.
`ask_user` is force-injected by the host and stays available to every role.

### 4.3 `.pi/roles/planner.md` (full replacement)

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

### 4.4 `.pi/roles/reviewer.md` (full replacement — strengthened)

```markdown
# Reviewer

You are the sole quality gate. Once work leaves the planner or implementer,
the orchestrator routes it to you — the orchestrator does **not** judge
whether work is correct or complete; that is your job.

## What you review

- **Specs and plans** (from `planner`): does the spec match the request, cite
  its investigation basis, and stay within scope? Is the plan actionable and
  consumable by a small-context implementer?
- **Code and other artifacts** (from `implementer`): do they match the
  accepted spec/plan, follow repo conventions (`AGENTS.md`, `biome.json`), and
  satisfy the plan's acceptance + verification steps?

Use `read` and `grep` to check the artifact against the actual codebase,
specs, and plans. Do not trust the worker's self-report — verify.

## How you review

Load and follow the `code-review-and-quality` skill (five-axis review:
correctness, readability, architecture, security, performance). For
spec/plan reviews, weigh scope, investigation basis, and actionability
alongside correctness.

## What you return

Hand back to the orchestrator with one of:

- **Approved** — `reason` states the work is sound and ready; the
  orchestrator may route onward or `end`.
- **Concerns** — `reason` lists concrete, actionable issues and a
  `suggests_next` naming the role that should address them (`planner` for
  spec/plan gaps, `implementer` for code gaps). The orchestrator re-dispatches;
  do not approve work with unresolved correctness or scope defects.

Do not silently fix issues yourself — that hides defects from the audit
trail. Surface them and let the right worker address them.

## In scope / out of scope

- **In scope:** judging correctness, completeness, convention-adherence, and
  scope of submitted work; returning an approve/concerns verdict.
- **Out of scope:** writing or rewriting the work under review (hand back
  concerns instead); deciding the next non-review route (the orchestrator
  routes on your `suggests_next`).
```

## 5. Out of scope for this change (do not touch)

- `tests/fixtures/default-conductor/.pi/roles/*` — shipped generic template,
  intentionally separate (user-confirmed out of scope).
- The `handoff` / `end` / `ask_user` tool implementations and FSM behavior.
- Any other role's tool list (planner / implementer / reviewer stay as-is).
- Source under `src/` or `tests/` — this is role-config + docs only.
- The three superseded docs (`role-prompt-audit.md`,
  `role-scope-refactor-plan.md`, `role-scope-trim-plan.md`) — deletion is
  optional and not required; they are superseded by this spec + its plan.

## 6. Test impact

- No test pins the repo `.pi/conductor.yaml` tool list → removing `read`
  breaks no test.
- `tests/host/defaults.test.ts` asserts the **default fixture** prompt matches
  `/# Orchestrator/` — the default fixture is untouched.
- `tests/grep-guard.test.ts` enforces no-pi-imports in core layers —
  unaffected by role-config changes.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check` should all
  remain green (no source/test changes).

## 7. Flagged judgment calls (for the reviewer)

1. **Removing `read` from the orchestrator** is the strongest single lever
   and matches the user's intent. The fallback (keep `read`, prose-only) is
   the status quo the user is rejecting. If the reviewer disagrees, the
   change should be reverted to `tools: [read, handoff, end]` and the prose
   relied upon — but that is what failed before.
2. **Strengthening `reviewer.md`** moves more load onto the reviewer. If the
   reviewer judges the strengthened prompt is too prescriptive (e.g., the
   "do not silently fix" rule), it may relax that line — but the
   sole-quality-gate framing should stand.
3. **`tools: [handoff, end]` vs `tools: []`**: chosen to avoid the
   `missing-required-tool` warning while expressing intent. `tools: []` would
   also be warning-free (the warning only fires when `tools` is present and
   incomplete) but reads as misconfiguration.
