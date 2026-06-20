# Orchestrator role-prompt audit & revision proposal

**Status:** Proposal — awaiting user approval before any file edits.
**Author:** planner (investigation + spec)
**Scope:** `.pi/roles/orchestrator.md`, `.pi/conductor.yaml` (orchestrator `tools`).
**Out of scope:** `planner.md` / `implementer.md` / `reviewer.md` content (reviewed,
no changes required — see §5), and the `tests/fixtures/default-conductor/*` scaffold
bundle (a separate shipped template; touched only if the user wants the default
to mirror this tightening).

---

## 1. What I found (investigation note)

The repo's live orchestrator prompt is `.pi/roles/orchestrator.md`. Its stated
intent is already correct — "Dispatch and routing only. You do **not**
investigate, research, or design." The problem is **execution**: several
phrases and one tool grant *invite* the very deliberation the header forbids.
A model under pressure to produce a good result will lean on whatever affordances
the prompt and tool list hand it. The audit below names each invitation point.

Key facts confirmed:

- The orchestrator is the run entry point: the user's first message and the
  run-memory artifact arrive as user messages. It does **not** receive file
  contents unless it calls `read` itself.
- `.pi/conductor.yaml` grants the orchestrator `tools: [read, handoff, end]`.
- Worker handbacks arrive as the handoff result (with `reason` /
  `suggests_next` text) — enough to route on without opening files.
- `planner.md` already owns investigation explicitly ("Investigate, then
  specify, then plan. You own the 'figure out what's actually going on'
  step — the orchestrator does not."). No change needed there.
- No test pins the repo's `.pi/conductor.yaml` tool list. Inline test fixtures
  (`tests/host/scaffold.test.ts` etc.) use `[read, handoff, end]` as a
  convention but assert shape/derivation, not the literal orchestrator tool
  set. Removing `read` from the repo manifest breaks no existing test.
- The shipped default bundle
  (`tests/fixtures/default-conductor/.pi/roles/orchestrator.md`) is a separate,
  intentionally-minimal template ("Orchestrator (default v1)") and does not
  carry the anti-deliberation framing at all. It is out of scope unless the
  user wants the default tightened too.

---

## 2. Audit — where the orchestrator prompt invites deliberation

Each item: the **line**, **why it invites deliberation**, **severity**.

### A. Tool grant: `read` is in the orchestrator's tool list (`.pi/conductor.yaml`)
- **Why:** LLMs use available tools. The prose constrains *how* `read` is used
  ("read a brief or a worker's output enough to route it correctly"), but the
  tool's mere presence is the strongest invitation. Once the model can read,
  it will read to classify, to judge output, to write a "better" brief.
- **Severity:** High. This is the single biggest mechanical lever.

### B. "Read the user's request and classify it (spec / plan / implement / review / clarify)"
- **Why:** Classification is a judgment. To decide "is this a spec task or a
  plan task," the model is tempted to read the codebase for context — exactly
  the investigation the header forbids. The five-way taxonomy also has no home
  for an open-ended research question, forcing the orchestrator to improvise.
- **Severity:** High.

### C. "route each worker's output to the next worker, to `reviewer`, or to `end`" + "if a worker hands back unclear or partial work, re-route or clarify"
- **Why:** Deciding work is "unclear or partial" is a **review judgment**. It
  invites the orchestrator to open and assess the worker's output — duplicating
  the reviewer's job and reading source to judge quality. Routing on the
  worker's *own stated* outcome (`reason` / `suggests_next`) needs no such
  judgment.
- **Severity:** High.

### D. "Dispatch via `handoff` to the right worker with a concrete, well-bounded brief"
- **Why:** "Concrete, well-bounded" invites the orchestrator to research in
  order to bound the brief well. A model that wants to dispatch a *good* brief
  will read first. The prompt never says "forward the user's words."
- **Severity:** Medium-High.

### E. "`read` is available so you can read a brief or a worker's output enough to route it correctly"
- **Why:** This sentence *legitimizes* reading. It draws a fuzzy line ("enough
  to route") that a model will routinely cross. It also concedes the tool is
  needed for routing, which is false — handoff text carries routing signal.
- **Severity:** Medium (compounds with A).

### F. Review gate: "Ensure any task completed by a planner or implementer is submitted to a reviewer before the run ends"
- **Why:** Knowing a task is "completed" is itself a judgment that invites
  reading the output to confirm. As written, the gate depends on the
  orchestrator's assessment of completion.
- **Severity:** Medium.

---

## 3. Proposed revision — `.pi/roles/orchestrator.md` (before/after)

Design principle: **route on signals, not on assessment.** The orchestrator
classifies from the user's text and the worker's handback text only; it never
opens files to decide, and it never judges output quality (that is the
reviewer's job). When classification is uncertain, it defaults to `planner`,
which investigates and re-classifies.

### BEFORE (current, in full)

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

### AFTER (proposed, in full)

```markdown
# Orchestrator

Dispatch and route. You do **not** investigate, research, design, or judge the
quality of a worker's output — those are worker jobs.

## What you do

1. **Triage from text alone.** Decide the next role from the user's message
   (on the first turn) or the worker's handback text (`reason` /
   `suggests_next`) on later turns. Do not open files to decide.
   - User wants a new feature/spec/plan, or the request is unclear → `planner`.
   - User wants a concrete change implemented → `implementer`.
   - A worker handed back and you need a quality judgment → `reviewer`.
   - The request is ambiguous in a way only the user can resolve → `ask_user`.
   - **When you cannot tell, default to `planner`.** The planner investigates
     and will hand back a spec/plan or a clarification; it never blocks on you.
2. **Forward, don't compose.** The brief you pass to a worker is the user's
   request (lightly restated) plus any prior worker's `suggests_next`. Do not
   research to write a "better" brief — that is investigation, which is the
   planner's job.
3. **Route on the worker's stated outcome, not your own assessment.** A worker
   says it is done → send to `reviewer`. A worker says it is blocked or needs
   input → re-dispatch to `planner` or `ask_user`. You do not independently
   judge whether work is "good enough"; the reviewer does.
4. **End only after review.** Emit `end` only once a reviewer has signed off
   (or the run is provably unable to proceed and the user has been asked).

## What you do not do

- Do not call `read`. You do not have it. Routing is done from the handback
  text and the user's message.
- Do not investigate, read source/transcripts, weigh trade-offs, or draft
  spec/plan content. Hand off to `planner`.
- Do not judge worker output quality. Hand off to `reviewer`.
- Do not absorb unfinished work. Re-dispatch it.

## Review gate (mechanical)

- After any `planner` or `implementer` handback, the next dispatch is to
  `reviewer` (never straight to `end`).
- `end` is legal only after a `reviewer` handback, or after `ask_user` returns
  a "stop" / the run is unable to proceed.
```

### Change rationale, item by item

| Audit item | Fix in the AFTER prompt |
|---|---|
| A (tool grant) | "Do not call `read`. You do not have it." (paired with the manifest change in §4) |
| B (classification invites reading) | "Triage from text alone" + explicit default-to-planner when uncertain |
| C (routing on output quality) | "Route on the worker's stated outcome, not your own assessment" + "you do not independently judge whether work is good enough; the reviewer does" |
| D ("concrete, well-bounded brief") | "Forward, don't compose" — brief = user's words + prior `suggests_next` |
| E (legitimizing `read`) | The legitimizing sentence is deleted; replaced by an explicit prohibition |
| F (review gate needs completion judgment) | Gate is now mechanical: reviewer always follows planner/implementer; `end` only after reviewer |

---

## 4. Proposed revision — `.pi/conductor.yaml` (orchestrator tools)

### BEFORE
```yaml
  - name: orchestrator
    is_orchestrator: true
    models: [opencode-go:minimax-m3]
    max_run_cost_usd: 25.0
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
```

### AFTER
```yaml
  - name: orchestrator
    is_orchestrator: true
    models: [opencode-go:minimax-m3]
    max_run_cost_usd: 25.0
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
```

> The orchestrator gets `ask_user` implicitly via the pi session layer (it is
> not a declared tool in this manifest schema); if `ask_user` must be declared
> to be available, add it: `tools: [handoff, end, ask_user]`. Confirm against
> the SDK's tool-registration surface before shipping (see Open question Q1).

Removing `read` is the mechanical enforcement of the prompt's "Do not call
`read`." Prose alone is not enough — the tool grant is the real lever.

---

## 5. Other roles — reviewed, no change required

- **`planner.md`:** Already owns investigation, spec, and plan. Explicitly
  says "You own the 'figure out what's actually going on' step — the
  orchestrator does not." No change.
- **`implementer.md`:** Minimal but correct ("Implement plans as specified;
  implementation is not complete until required tests are green"). Out of
  scope for this audit; could be expanded later but not needed to fix the
  orchestrator-deliberation problem.
- **`reviewer.md`:** Minimal ("Refer to related skills for reviewing submitted
  plans, or code"). Out of scope. The orchestrator tightening *increases* the
  load on the reviewer (it is now the sole quality gate); a follow-up could
  strengthen `reviewer.md`, but that is a separate proposal.

---

## 6. Test impact

- **No test pins the repo's `.pi/conductor.yaml` tool list.** Removing `read`
  from the orchestrator breaks no existing test.
- Inline test fixtures (`tests/host/scaffold.test.ts`, `production-host*.test.ts`,
  etc.) use `tools: [read, handoff, end]` for orchestrator roles in their own
  inline manifests. These are **not** assertions on the repo manifest — they
  are test scaffolding. They will continue to pass unchanged. The implementer
  *may* optionally update them to `[handoff, end]` for consistency, but it is
  not required and is out of scope for this change.
- `tests/host/defaults.test.ts` asserts the shipped default bundle's
  orchestrator prompt matches `/# Orchestrator/`. The repo's
  `.pi/roles/orchestrator.md` (the live prompt) is **not** the default bundle;
  the default bundle lives at
  `tests/fixtures/default-conductor/.pi/roles/orchestrator.md` and is
  untouched by this proposal.
- `grep-guard.test.ts` enforces no-pi-imports in core layers — unaffected.

---

## 7. Open questions for the user

- **Q1 — `ask_user` declaration.** Does the manifest schema require `ask_user`
  in the `tools` list for the orchestrator to use it, or is it always
  available to the orchestrator role? If it must be declared, the AFTER
  manifest should be `tools: [handoff, end, ask_user]`. (The planner can
  verify against `docs/sdk-surface.md` / the SDK on request.)
- **Q2 — Default bundle.** Should the shipped default template
  (`tests/fixtures/default-conductor/.pi/roles/orchestrator.md`) also be
  tightened, or kept as the intentionally-minimal scaffold? Recommend: leave
  the default as-is for now (it is a generic template, not the anti-deliberation
  posture), and tighten only the repo's live `.pi/roles/`.
- **Q3 — Reviewer strengthening.** The tightening makes the reviewer the sole
  quality gate. Do you want a follow-up proposal to strengthen `reviewer.md`
  in the same pass, or keep this change focused on the orchestrator only?

---

## 8. Implementation plan (for the implementer, after approval)

1. Edit `.pi/roles/orchestrator.md` → replace with the AFTER content in §3.
2. Edit `.pi/conductor.yaml` → change orchestrator `tools` per §4 (resolve Q1
   first).
3. Run `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check`.
4. No doc/spec changes required beyond this audit doc; tick nothing in the
   phase plan checklists (this is a role-prompt change, not a phase task).
