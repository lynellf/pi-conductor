# Role-prompt revision spec — orchestrator dispatch-only + reviewer as sole gate

**Status:** Spec — ready for review, then implementation.
**Author:** planner (investigation + spec).
**Scope:** `.pi/roles/orchestrator.md`, `.pi/roles/reviewer.md`,
`.pi/conductor.yaml`, and the shipped default bundle template
`tests/fixtures/default-conductor/.pi/roles/orchestrator.md`.
**Out of scope:** `planner.md` (already owns investigation — no change),
`implementer.md` (no change), `worker.md` in the default bundle (no change),
the default bundle's `conductor.yaml` role list (no reviewer added to the
default — see §4).

---

## 1. What I found (investigation note)

- A prior planner run produced `docs/role-prompt-audit.md`, a thorough audit
  of how the orchestrator prompt invites deliberation. This spec adopts its
  proposed "AFTER" orchestrator prompt and extends it to two more surfaces the
  user asked to tighten: the shipped default bundle and the reviewer.
- **Working-tree state is partially implemented but inconsistent.**
  `.pi/conductor.yaml` already dropped `read`/`bash` from the orchestrator
  (`tools: [handoff, end]`), and `planner.md` already owns investigation. But
  `.pi/roles/orchestrator.md` still says "`read` is available so you can read
  a brief…" — **false now that `read` was removed** — and still carries the
  other invitation points the audit flags (classification invites reading,
  "judge if work is unclear/partial", "concrete well-bounded brief" invites
  research, review gate depends on a completion judgment).
- **`ask_user` is force-injected by the host.**
  `src/host/production-host-resolve.ts` → `buildToolsAllowlist` appends
  `handoff`, `end`, **and `ask_user`** to every role's tool list regardless of
  the manifest declaration. So `tools: [handoff, end]` still gives the
  orchestrator `ask_user`. **No manifest entry for `ask_user` is needed.**
  (This resolves the audit's open question Q1.)
- **No test pins the repo's live `.pi/conductor.yaml` tool list.**
  `tests/host/scaffold.test.ts` writes its own `VALID_MANIFEST` to a temp dir;
  the default-bundle tests use the fixture, not the repo manifest. Adding
  `bash` to the reviewer and keeping the orchestrator at `[handoff, end]`
  break no existing test.
- **Default-bundle test pin:** `tests/host/defaults.test.ts` asserts the
  default orchestrator prompt matches `/# Orchestrator/` and the worker
  matches `/# Worker/`. The default-bundle rewrite keeps a `# Orchestrator`
  heading. The default's loop/remediation tests are stub-provider-driven, not
  prompt-driven, so rewriting the prompt is safe.

## 2. Design principle

**Route on signals, not on assessment.** The orchestrator classifies from the
user's text and the worker's handback text (`reason` / `suggests_next`) only;
it never opens files to decide, and never judges output quality — that is the
reviewer's job. The reviewer is the sole quality gate and runs the repo's
executable verification gates itself. When classification is uncertain, the
orchestrator defaults to `planner` (or re-dispatches the `worker` in the
single-worker default bundle).

---

## 3. Revision A — `.pi/roles/orchestrator.md` (live repo prompt)

Replace the entire file with the content below. (This is the audit's AFTER
prompt, verbatim, with `ask_user` confirmed available.)

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

## 4. Revision B — `tests/fixtures/default-conductor/.pi/roles/orchestrator.md` (shipped template)

The default bundle is an intentionally-minimal scaffold: **one orchestrator +
one `worker`, no `reviewer` role**. We do **not** add a reviewer to the
default (that would change the scaffold's philosophy and is out of scope). We
tighten the prompt to the same anti-deliberation posture, adapted to the
single-worker shape: route on the worker's stated outcome, end on
completion/cap/budget signals, never read files to decide. The default's
`conductor.yaml` already grants the orchestrator `tools: [handoff, end]`, so
"Do not call `read`. You do not have it." is accurate there too.

Replace the entire file with:

```markdown
# Orchestrator (default v1)

You dispatch a single worker and route the run to completion. You do **not**
investigate, research, design, or judge the quality of the worker's output by
reading files — you route on what the worker tells you.

## What you do

1. **Triage from text alone.** The goal arrives as your first user message;
   run-memory (visit history, per-role cost, remaining budget — spec §8.4)
   arrives on later turns. Decide the next step from that text, not from
   opening files.
   - Goal not yet attempted → dispatch the `worker` with the goal.
   - Worker handed back and says it is done → emit `end`.
   - Worker says it is blocked or needs input you cannot resolve from the
     text → `ask_user`.
   - **When you cannot tell, re-dispatch the `worker`** with the goal and the
     worker's last `suggests_next`; do not investigate yourself.
2. **Forward, don't compose.** The task you pass to the `worker` is the goal
   (lightly restated) plus any prior `suggests_next`. Do not research to write
   a "better" brief.
3. **End on signals, not on assessment.** Emit `end` when the worker states
   the goal is met, when the worker cannot make further progress, when the
   `max_visits` cap is reached (the reducer rejects further handoffs and
   surfaces the legal-target list — if `end` is the only legal target, emit
   `end`), or when remaining budget is insufficient for another visit.

## What you do not do

- Do not call `read`. You do not have it.
- Do not investigate, read source/transcripts, weigh trade-offs, or design
  the work. Dispatch the `worker`; it does the work.
- Do not judge whether the worker's output is "good enough" by opening files.
  Route on the worker's stated outcome.

## Tools

- `handoff` — dispatch to the `worker`. Pass a `reason` and the task payload.
  `target_role` must be `worker`.
- `end` — finish the run. Optional `reason` for the audit trail.
```

> The default has no `reviewer` role, so the "review gate" concept from the
> live repo prompt does not apply here; the orchestrator ends on the worker's
> stated completion or on cap/budget exhaustion. This is the honest
> adaptation, not a weakening — the default is a generic single-worker
> scaffold, not the anti-deliberation + review-gate posture.

## 5. Revision C — `.pi/roles/reviewer.md` (strengthen to sole quality gate)

The orchestrator tightening makes the reviewer the sole quality gate. The
reviewer gets `bash` added to its tools (Revision D) so it can run the
executable verification gates itself — the repo's real quality bar. It is
constrained by prompt to verification-only: it judges, it never implements.

Replace the entire file with:

```markdown
# Reviewer

You are the sole quality gate. You judge work; you do **not** implement,
specify, or plan. When the orchestrator hands you a `planner` or
`implementer` handback, you decide whether the work is ready to ship.

## What you do

1. **Read the work and its acceptance criteria.** Use `read` and `grep` to
   inspect the changed files, the relevant spec/plan acceptance criteria, and
   any plan checkboxes the worker claimed to tick. Confirm the work actually
   matches what was claimed — do not rubber-stamp prose.
2. **Run the verification gates.** Use `bash` to run the repo's gates in
   order: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`.
   The work is not ready until all four are clean. This is the real quality
   bar — do not approve on prose alone. (`pnpm test` includes the
   `grep-guard` test that enforces the no-pi-imports invariant.)
3. **Check the invariants.** For code changes, confirm the non-negotiable
   invariants in `AGENTS.md` hold (host-agnostic core, reducer purity,
   `def` is the pinned snapshot, every state change goes through `reduce`,
   etc.).
4. **Decide and hand back.**
   - **Approve** → hand back to the orchestrator with `reason: approved` and a
     one-line summary of what you verified (which gates ran clean). The
     orchestrator may then `end`.
   - **Reject** → hand back to the orchestrator with `reason: rejected`, the
     specific deficiencies, and which role should fix them (`implementer` for
     code/test failures, `planner` for spec/plan gaps). Do not fix them
     yourself.

## What you do not do

- Do not edit source files. `edit` and `write` are not in your tool list, and
  even though `bash` could write, you must not — you judge, you do not
  implement. A reviewer that edits has become an implementer.
- Do not draft specs or plans. Reject back to `planner` if the plan itself is
  the problem.
- Do not absorb unfinished work. Reject it back to the right worker.

## Skills

- Load the `code-review-and-quality` skill and follow its review axes.
```

### Residual risk (accepted)

`bash` can write files, so the "do not edit" constraint is prompt-level, not
tool-level. This is the inverse of the orchestrator's `read`-removal
principle, and is accepted here because the reviewer's legitimate job —
running `pnpm typecheck/test/lint/format:check` — genuinely requires `bash`,
and there is no read-only `bash` tool in this system. Mitigation: the prompt
explicitly forbids writes and frames editing as a role-boundary violation.

## 6. Revision D — `.pi/conductor.yaml` (reviewer tools)

The orchestrator entry is already `tools: [handoff, end]` in the working tree
— **no change needed there**. Add `bash` to the reviewer's tools so it can
run the verification gates.

### BEFORE
```yaml
  - name: reviewer
    max_visits: 10
    models: [opencode-go:glm-5.2]
    system_prompt: .pi/roles/reviewer.md
    tools: [read, grep, handoff, end]
```

### AFTER
```yaml
  - name: reviewer
    max_visits: 10
    models: [opencode-go:glm-5.2]
    system_prompt: .pi/roles/reviewer.md
    tools: [read, grep, bash, handoff, end]
```

> `ask_user` is force-injected by `buildToolsAllowlist` for every role, so it
> is not listed for the reviewer either.

## 7. Files touched (summary)

| File | Change |
|---|---|
| `.pi/roles/orchestrator.md` | Full replace → Revision A |
| `tests/fixtures/default-conductor/.pi/roles/orchestrator.md` | Full replace → Revision B |
| `.pi/roles/reviewer.md` | Full replace → Revision C |
| `.pi/conductor.yaml` | reviewer `tools`: add `bash` (Revision D); orchestrator already `[handoff, end]` |
| `.pi/roles/planner.md` | **No change** (already owns investigation) |
| `.pi/roles/implementer.md` | **No change** |

## 8. Test impact

- No test pins the repo `.pi/conductor.yaml` tool list → reviewer `bash`
  addition and orchestrator `[handoff, end]` are safe.
- `tests/host/defaults.test.ts` asserts the default orchestrator prompt
  matches `/# Orchestrator/` → Revision B keeps that heading. The default's
  loop/remediation tests are stub-driven, not prompt-driven → safe.
- `grep-guard.test.ts` (no-pi-imports in core) → unaffected.
- Verification after implementation: `pnpm typecheck && pnpm test && pnpm lint
  && pnpm format:check` must be clean.

## 9. Open items

None blocking. The two user decisions that shaped this spec (scope = all
three surfaces; reviewer gets `bash`) were resolved via `ask_user` before this
spec was written.
