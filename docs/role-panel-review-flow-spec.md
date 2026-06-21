# Spec: Assistant Role + Plan-Review Panel Ping-Pong

**Status:** Spec revised — ready for reviewer before implementation.
**Author:** planner (investigation + spec).
**Scope:** Live repo conductor role configuration and prompts: `.pi/conductor.yaml`, `.pi/roles/orchestrator.md`, `.pi/roles/planner.md`, `.pi/roles/reviewer.md`, plus new `.pi/roles/assistant.md`, `.pi/roles/plan-reviewer-a.md`, and `.pi/roles/plan-reviewer-b.md`.
**Out of scope:** Core FSM code, host/extension code, default-conductor fixture, SDK behavior, source/tests unrelated to role prompts.

## 1. What I found

- The FSM already supports arbitrary worker role names declared in the manifest. No reducer or host code is needed to add roles; the manifest drives `MachineDefinition.workers` and `max_visits`.
- The topology is still hub-and-spoke: workers cannot hand off to each other. Any "ping-pong" between plan panelists must be orchestrator-mediated: `orchestrator → plan-reviewer-a → orchestrator → plan-reviewer-b → orchestrator → planner ...`.
- The live manifest currently declares only `orchestrator`, `planner`, `implementer`, and `reviewer`; there is no `assistant` or plan-panel role available to the current runtime.
- The active run's declared role set is pinned at run start. Editing `.pi/conductor.yaml` will not make new roles legal targets in an already-started conductor run; a new run must start from the updated manifest.
- The live orchestrator prompt still says "`read` is available" even though the live manifest has removed `read` from the orchestrator tool list. This spec should fix that stale instruction while adding the new routing rules.
- `ask_user`, `handoff`, and `end` are force-injected by `buildToolsAllowlist`, but the live manifest currently lists `ask_user` explicitly for orchestrator/planner. The spec below preserves existing explicit `ask_user` entries and does not require a code change.
- Manifest `version` is currently `1`, which keeps `system_prompt: .pi/roles/foo.md` cwd-relative. Per the implemented Phase 7D rule in `docs/orchestrator-fsm-spec.md` §8.1, `version >= 2` changes relative prompt resolution to the resolved manifest file's directory. This spec now chooses the versioned path: bump the live manifest to `version: 2` and migrate prompt paths to `roles/*.md`.
- `.pi/conductor.yaml` has uncommitted model changes in the working tree. Any implementation must preserve the existing orchestrator/planner/implementer/reviewer model lists, and new assistant/panel roles must copy the current reviewer model list.

## 2. Objective

Add three live workflow roles and update orchestration instructions so plans/specs are reviewed by a two-person panel before implementation:

1. `assistant` — a non-mutating general-support worker for lightweight questions, summaries, user clarification, and non-implementation help that should not go through the full plan/implement path.
2. `plan-reviewer-a` — independent plan/spec panelist.
3. `plan-reviewer-b` — independent plan/spec panelist.

The orchestrator should route planner outputs through both panelists before implementation. If either panelist requests changes, the orchestrator routes back to `planner`; the revised artifact then goes through both panelists again. Implementation starts only after both panelists approve the current version.

## 3. Design principles

1. **No core changes.** Role support is manifest + prompt configuration only.
2. **Hub-and-spoke only.** Panelists never directly hand off to each other or to `planner`; they return to `orchestrator` with a verdict and `suggests_next`.
3. **Pre-implementation review is separate from post-implementation review.** The panel reviews specs/plans before code. The existing `reviewer` remains the post-implementation quality gate for code/artifact review.
4. **Verdicts are machine-readable enough for routing.** Panelists and reviewer lead their `reason` with `APPROVE`, `APPROVE-WITH-NITS`, or `REQUEST-CHANGES`.
5. **Route on handback text, not source inspection.** The orchestrator stays dispatch-only and routes on `last_message.text` / `suggests_next`.
6. **Keep tool permissions minimal.** New plan panelists do not get `edit`/`write`; `assistant` is non-mutating only (`read`, `grep`, `ask_user`, plus machine-event tools).

## 4. Proposed role semantics

### 4.1 `assistant`

Purpose: handle lightweight assistance that is not implementation and does not need a formal spec/plan.

Scope:

- Answer repo/process questions using `read`/`grep`.
- Summarize docs, prior plans, or current instructions.
- Ask focused user-clarification questions when the orchestrator has routed an ambiguity that does not yet require formal planner work.
- Do **not** edit files, run shell commands, implement code, approve work, or produce formal specs/plans.

Exact tools:

```yaml
tools: [read, grep, ask_user, handoff, end]
```

`end` is listed for manifest warning hygiene but the prompt must say workers do not end runs. `ask_user` is allowed only for clarification, not for approving or bypassing the planner/reviewer flow.

### 4.2 `plan-reviewer-a` and `plan-reviewer-b`

Purpose: independent panel review of planner-produced specs/plans before implementation.

Scope:

- Review the current spec/plan against the user request, repo constraints, and investigation basis.
- Identify ambiguity, over-scope, missing acceptance criteria, missing verification, or implementation-order risk.
- Do not edit the plan; return a verdict to the orchestrator.
- Use `suggests_next: "planner"` on `REQUEST-CHANGES`; use `suggests_next: "plan-reviewer-b"` or `"implementer"` only as advice to the orchestrator.

Exact tools:

```yaml
tools: [read, grep, handoff, end]
```

## 5. Ping-pong routing flow

The orchestrator prompt should encode this mechanical sequence:

1. User asks for new work → route to `planner`.
2. Planner returns a spec/plan → route to `plan-reviewer-a`.
3. `plan-reviewer-a` returns:
   - `REQUEST-CHANGES` → route to `planner` with the concerns.
   - `APPROVE` / `APPROVE-WITH-NITS` → route to `plan-reviewer-b`.
4. `plan-reviewer-b` returns:
   - `REQUEST-CHANGES` → route to `planner` with the concerns.
   - `APPROVE` / `APPROVE-WITH-NITS` → route to `implementer`.
5. After `planner` revises, restart the panel sequence at `plan-reviewer-a`.
6. After `implementer` completes, route to the existing `reviewer` for code/artifact review.
7. Only after existing `reviewer` approves may the orchestrator `end`.

Because the FSM does not branch on verdict text, this is prompt-level discipline, not reducer logic.

## 6. Proposed file updates

### 6.1 `.pi/conductor.yaml`

Add three worker entries and use the versioned manifest path convention. Preserve the existing model lists for `orchestrator`, `planner`, `implementer`, and `reviewer`; copy the current `reviewer` model list to `assistant`, `plan-reviewer-a`, and `plan-reviewer-b`; set all new workers to `max_visits: 10`.

Required manifest strategy:

- Change `version: 1` → `version: 2`.
- Because `version >= 2` resolves relative `system_prompt` paths against the resolved manifest file's directory (`manifestDir`; `docs/orchestrator-fsm-spec.md` §8.1), change every existing prompt path from `system_prompt: .pi/roles/*.md` to `system_prompt: roles/*.md`.
- Add new prompt paths as `system_prompt: roles/assistant.md`, `roles/plan-reviewer-a.md`, and `roles/plan-reviewer-b.md`.
- Do not use the v1 `.pi/roles/*.md` path convention in this change.

Required new role entries, using the current reviewer model list:

```yaml
  - name: assistant
    max_visits: 10
    models: [openai-codex:gpt-5.4-mini, opencode-go:minimax-m3]
    system_prompt: roles/assistant.md
    tools: [read, grep, ask_user, handoff, end]

  - name: plan-reviewer-a
    max_visits: 10
    models: [openai-codex:gpt-5.4-mini, opencode-go:minimax-m3]
    system_prompt: roles/plan-reviewer-a.md
    tools: [read, grep, handoff, end]

  - name: plan-reviewer-b
    max_visits: 10
    models: [openai-codex:gpt-5.4-mini, opencode-go:minimax-m3]
    system_prompt: roles/plan-reviewer-b.md
    tools: [read, grep, handoff, end]
```

### 6.2 `.pi/roles/orchestrator.md`

Replace stale `read` language and add the panel flow. Required content changes:

- State that orchestrator has only routing tools plus `ask_user`; it must not call `read`.
- Add route: lightweight question/support → `assistant`.
- Add route: new work → `planner`.
- Add route: planner output → `plan-reviewer-a`, then `plan-reviewer-b`, then `implementer` only if both approve.
- Add route: panel `REQUEST-CHANGES` → `planner`.
- Preserve final code review gate: implementer output → `reviewer`; end only after reviewer approval.

### 6.3 `.pi/roles/planner.md`

Add a short "panel review" reporting rule:

- When producing or revising a spec/plan, include a concise summary of what changed and hand back with `reason` leading with `PLAN-READY` or `PLAN-REVISED`.
- If responding to panel concerns, explicitly list how each concern was addressed or why it was rejected.
- Use `suggests_next: "plan-reviewer-a"` when the artifact is ready for panel review.

### 6.4 `.pi/roles/assistant.md` (new)

Create a prompt that says:

- You are a non-mutating support role.
- Use `read`/`grep` to answer questions or summarize context.
- Use `ask_user` only for focused clarification when the orchestrator explicitly routed an ambiguity; do not use it to approve work or bypass planner/reviewer gates.
- Do not run shell commands, edit, write, plan formal work, implement, or approve.
- Return to orchestrator with `reason` summarizing the answer/status and `suggests_next` if a follow-up role is needed.

### 6.5 `.pi/roles/plan-reviewer-a.md` and `.pi/roles/plan-reviewer-b.md` (new)

Create near-identical prompts with independent-review framing:

- Load relevant context and review the current spec/plan.
- Check request fit, scope control, assumptions/open questions, task actionability, verification gates, and repo constraints.
- Do not edit files.
- Return verdict in `reason` with one of:
  - `APPROVE: ...`
  - `APPROVE-WITH-NITS: ...`
  - `REQUEST-CHANGES: ...`
- Use `suggests_next: "planner"` for blocking concerns.
- Panelist B should not simply rubber-stamp panelist A; it should review independently while considering A's notes if surfaced by the orchestrator.

### 6.6 `.pi/roles/reviewer.md`

Clarify that `reviewer` is the post-implementation gate, not the pre-implementation plan panel:

- It reviews code/artifacts after implementation.
- It may also review meta-changes to prompts/config when specifically routed there.
- It preserves existing verdict keyword behavior.

## 7. Testing and verification strategy

This is a docs/config change. Expected verification after implementation:

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm lint`
4. `pnpm format:check`
5. Manual config check: parse/inspect `.pi/conductor.yaml` and confirm it declares `version: 2`, exactly one orchestrator, and six workers: `planner`, `implementer`, `reviewer`, `assistant`, `plan-reviewer-a`, `plan-reviewer-b`.
6. Manual prompt-path check: every relative `system_prompt` is `roles/*.md` (manifest-base-relative from `.pi/conductor.yaml`'s directory), and all seven referenced prompt files exist with the required routing/verdict language.

No source-code test should be required unless implementation reveals that live `.pi/conductor.yaml` is parsed by a fixture test.

## 8. Runtime constraints and resolved assumptions

### Constraints

- New role names are not legal in the current active conductor run. Start a fresh run after the manifest update.
- Workers cannot hand off to each other. The ping-pong is orchestrator-mediated only.
- The reducer will not enforce the two-panel approval sequence; prompts and reviewer discipline enforce it.
- With `version: 2`, relative prompt paths resolve against the manifest directory, so the live repo manifest at `.pi/conductor.yaml` must use `roles/*.md` paths.
- Existing uncommitted model-list edits in `.pi/conductor.yaml` must be preserved.

### Resolved assumptions for implementation

1. `assistant` is non-mutating only: exact tools are `[read, grep, ask_user, handoff, end]`; no `bash`, `edit`, or `write`.
2. Role names are fixed as `assistant`, `plan-reviewer-a`, and `plan-reviewer-b`.
3. The live manifest is bumped to `version: 2`; v1 prompt paths are not used for this change.
4. The default-conductor fixture remains generic and untouched unless a later task explicitly scopes it in.
5. New assistant/panel roles copy the current `reviewer` model list; no intentional model diversity is introduced in this spec.

## 9. Success criteria

- The live manifest declares `assistant`, `plan-reviewer-a`, and `plan-reviewer-b` with finite `max_visits`.
- The live manifest declares `version: 2`, and every relative `system_prompt` uses the v2 manifest-base convention (`roles/*.md` from `.pi/conductor.yaml`'s directory).
- The orchestrator prompt no longer claims `read` is available.
- The orchestrator prompt encodes the panel ping-pong sequence before implementation.
- Planner and panelist prompts agree on verdict/status handback conventions.
- Existing reviewer remains the final post-implementation quality gate.
- Verification commands remain green.
