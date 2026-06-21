# Implementation Plan: Assistant Role + Plan-Review Panel Ping-Pong

## What I found

- The approved spec is `docs/role-panel-review-flow-spec.md`. It scopes this change to the live conductor manifest and role prompts only.
- The current live manifest is `.pi/conductor.yaml` with `version: 1` and four roles: `orchestrator`, `planner`, `implementer`, `reviewer`.
- Prompt loading already supports the required v2 behavior: for `version >= 2`, relative `system_prompt` paths resolve against the manifest directory, so `.pi/conductor.yaml` should reference prompts as `roles/*.md`.
- The current orchestrator prompt still contains stale text saying `read` is available; the manifest currently gives the orchestrator only `[handoff, end, ask_user]`.
- The current role set is pinned for active runs. These new roles will only be legal targets in a fresh run started after `.pi/conductor.yaml` is updated.

## Overview

Implement the approved prompt/manifest-only role expansion: add a non-mutating `assistant` role and two plan-review panelists, migrate the live manifest to v2 prompt paths, and update routing prompts so planner-produced specs/plans pass through `plan-reviewer-a` and `plan-reviewer-b` before implementation.

## Architecture decisions

- **No source-code changes.** The FSM already supports arbitrary manifest-declared worker names; keep `src/**`, tests, and default-conductor fixtures untouched unless verification reveals an actual break.
- **Manifest v2 only for the live config.** Bump `.pi/conductor.yaml` to `version: 2` and change all role prompt paths to `roles/*.md`.
- **Hub-mediated panel loop.** Panelists return to `orchestrator`; they do not hand off directly to planner, each other, or implementer.
- **Current-run limitation.** Do not try to use `assistant` / `plan-reviewer-*` in the current run. The implementation can be reviewed by the existing `reviewer`; new roles are exercised only after a fresh conductor run.

## Task list

### Task 1: Update the live role registry in `.pi/conductor.yaml`

**Description:** Migrate the live manifest to v2 prompt resolution and add `assistant`, `plan-reviewer-a`, and `plan-reviewer-b` as finite workers.

**Acceptance criteria:**

- [ ] `version: 2` is set.
- [ ] All existing `system_prompt` values are changed from `.pi/roles/*.md` to `roles/*.md`.
- [ ] New roles are added with `max_visits: 10`, reviewer model list copied exactly, and spec-approved tools:
  - `assistant`: `[read, grep, ask_user, handoff, end]`
  - `plan-reviewer-a`: `[read, grep, handoff, end]`
  - `plan-reviewer-b`: `[read, grep, handoff, end]`
- [ ] Existing model lists for `orchestrator`, `planner`, `implementer`, and `reviewer` are preserved.
- [ ] The manifest header/comment no longer falsely claims the file mirrors the original §8 fixture verbatim, if that text would be stale after the edit.

**Verification:**

- [ ] Manual inspect: `.pi/conductor.yaml` has exactly one `is_orchestrator: true` role and six workers.
- [ ] Manual inspect: all relative prompt paths are `roles/*.md`.

**Dependencies:** None.

**Files likely touched:**

- `.pi/conductor.yaml`

**Estimated scope:** Small.

### Task 2: Replace orchestrator routing instructions

**Description:** Tighten the orchestrator prompt to match its actual tools and encode the assistant + panel routing flow.

**Acceptance criteria:**

- [ ] Prompt states the orchestrator is dispatch/routing only and does not call `read`.
- [ ] Lightweight non-mutating support/questions route to `assistant`.
- [ ] New work routes to `planner` first.
- [ ] Planner outputs route to `plan-reviewer-a`; approval routes to `plan-reviewer-b`; both panelists approving routes to `implementer`.
- [ ] Any panelist `REQUEST-CHANGES` routes back to `planner`; revised planner output restarts at `plan-reviewer-a`.
- [ ] Implementer output still routes to existing `reviewer`; orchestrator ends only after reviewer approval.

**Verification:**

- [ ] `grep -n "read is available\|read\` is available" .pi/roles/orchestrator.md` returns no stale availability claim.
- [ ] Manual inspect confirms the routing table includes `assistant`, `plan-reviewer-a`, `plan-reviewer-b`, `planner`, `implementer`, and `reviewer`.

**Dependencies:** Task 1.

**Files likely touched:**

- `.pi/roles/orchestrator.md`

**Estimated scope:** Small.

### Task 3: Add planner handback conventions for panel review

**Description:** Update planner instructions so specs/plans are ready for panel review and revisions explicitly answer panel concerns.

**Acceptance criteria:**

- [ ] Planner reports `PLAN-READY` for initial completed spec/plan artifacts.
- [ ] Planner reports `PLAN-REVISED` when responding to panel concerns.
- [ ] Planner explicitly lists how each panel concern was addressed or why it was not accepted.
- [ ] Planner uses `suggests_next: "plan-reviewer-a"` when an artifact is ready for panel review.

**Verification:**

- [ ] Manual inspect confirms the reporting rule exists and does not weaken existing investigate/spec/plan responsibilities.

**Dependencies:** Task 2.

**Files likely touched:**

- `.pi/roles/planner.md`

**Estimated scope:** Small.

### Task 4: Add the assistant prompt

**Description:** Create a new non-mutating support-role prompt for lightweight repo/process assistance.

**Acceptance criteria:**

- [ ] Prompt describes `assistant` as non-mutating support only.
- [ ] Prompt permits `read`/`grep` for answers and summaries.
- [ ] Prompt permits `ask_user` only for focused clarification when routed by orchestrator.
- [ ] Prompt forbids shell commands, editing/writing, formal planning, implementation, and approval gates.
- [ ] Prompt returns to `orchestrator` with a concise `reason` and optional `suggests_next`.

**Verification:**

- [ ] Manual inspect confirms no mutation-oriented language or tools are recommended.

**Dependencies:** Task 1.

**Files likely touched:**

- `.pi/roles/assistant.md`

**Estimated scope:** Small.

### Task 5: Add panelist prompts and clarify reviewer scope

**Description:** Create two near-identical independent plan-review prompts and clarify that the existing reviewer remains the post-implementation gate.

**Acceptance criteria:**

- [ ] `.pi/roles/plan-reviewer-a.md` and `.pi/roles/plan-reviewer-b.md` exist.
- [ ] Both panel prompts require independent review of current spec/plan fit, scope, assumptions, actionability, verification, and repo constraints.
- [ ] Both panel prompts forbid editing files and direct worker-to-worker routing.
- [ ] Both panel prompts require verdict-leading `reason`: `APPROVE`, `APPROVE-WITH-NITS`, or `REQUEST-CHANGES`.
- [ ] `REQUEST-CHANGES` uses `suggests_next: "planner"`.
- [ ] Panelist B is instructed not to rubber-stamp Panelist A.
- [ ] `.pi/roles/reviewer.md` is clarified as the post-implementation code/artifact review gate while preserving verdict keywords.

**Verification:**

- [ ] Manual inspect confirms both panel files have the same review checklist and verdict contract.
- [ ] Manual inspect confirms reviewer still leads with verdict keywords.

**Dependencies:** Tasks 2 and 3.

**Files likely touched:**

- `.pi/roles/plan-reviewer-a.md`
- `.pi/roles/plan-reviewer-b.md`
- `.pi/roles/reviewer.md`

**Estimated scope:** Medium.

### Task 6: Run full verification and update plan checkboxes

**Description:** Validate the config/prompt change with repo gates and explicit manifest checks, then tick only the completed checkboxes in this plan.

**Acceptance criteria:**

- [ ] Full quality gates pass.
- [ ] Manifest parses and validates with no hard errors.
- [ ] All seven referenced prompt files exist.
- [ ] This plan's completed implementation and verification boxes are ticked accurately.

**Verification:**

- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm lint`
- [ ] `pnpm format:check`
- [ ] After `pnpm build`, run a manual manifest check such as:

```sh
node --input-type=module <<'NODE'
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseManifest } from './dist/manifest/parse.js';
import { validateManifest } from './dist/manifest/validate.js';

const manifestPath = '.pi/conductor.yaml';
const manifestDir = dirname(manifestPath);
const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
const report = validateManifest(manifest);
const orchestrators = manifest.roles.filter((role) => role.is_orchestrator === true);
const workers = manifest.roles.filter((role) => role.is_orchestrator !== true).map((role) => role.name).sort();
const expectedWorkers = ['assistant', 'implementer', 'plan-reviewer-a', 'plan-reviewer-b', 'planner', 'reviewer'];

if (manifest.version !== 2) throw new Error(`expected version 2, got ${manifest.version}`);
if (orchestrators.length !== 1) throw new Error(`expected 1 orchestrator, got ${orchestrators.length}`);
if (JSON.stringify(workers) !== JSON.stringify(expectedWorkers)) throw new Error(`workers mismatch: ${workers.join(',')}`);
if (report.errors.length > 0) throw new Error(`manifest validation errors: ${JSON.stringify(report.errors)}`);

for (const role of manifest.roles) {
  if (role.system_prompt === undefined) throw new Error(`${role.name} missing system_prompt`);
  if (!role.system_prompt.startsWith('roles/')) throw new Error(`${role.name} uses non-v2 prompt path ${role.system_prompt}`);
  if (!existsSync(resolve(manifestDir, role.system_prompt))) throw new Error(`${role.name} prompt missing: ${role.system_prompt}`);
}

console.log('manifest ok');
NODE
```

**Dependencies:** Tasks 1-5.

**Files likely touched:**

- `docs/role-panel-review-flow-plan.md`

**Estimated scope:** Small.

## Checkpoints

### Checkpoint A: Registry + prompt files exist

After Tasks 1, 4, and 5:

- [ ] `.pi/conductor.yaml` declares all seven roles.
- [ ] Every declared `system_prompt` file exists.
- [ ] New roles use only the tools approved in the spec.

### Checkpoint B: Routing contract is coherent

After Tasks 2, 3, and 5:

- [ ] Orchestrator, planner, and panelist prompts agree on verdict/status strings and `suggests_next` values.
- [ ] Panel `REQUEST-CHANGES` returns to planner.
- [ ] Implementation is gated on both panel approvals.
- [ ] Post-implementation review remains assigned to existing `reviewer`.

### Checkpoint C: Complete

After Task 6:

- [ ] Full verification gates are green.
- [ ] Manual manifest check is green.
- [ ] No files outside the scoped prompt/manifest/plan set were changed.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Active run cannot route to new roles | Medium | State explicitly that a fresh run is required after implementation. Use existing `reviewer` for this change's review. |
| v2 path migration breaks prompt loading | High | Convert every path to `roles/*.md` and run the manual manifest/prompt existence check. |
| Orchestrator over-interprets panel output | Medium | Require verdict-leading panel `reason` and route on `last_message`, not source inspection. |
| Panelists rubber-stamp each other | Medium | Panelist B prompt requires independent review while considering A's surfaced notes. |
| Scope creep into source/tests/default fixture | Low | Keep implementation to `.pi/conductor.yaml`, `.pi/roles/*.md`, and this plan unless verification proves otherwise. |

## Staged ping-pong behavior after implementation

For the first fresh run after this change, the orchestrator should use this sequence before implementation:

1. `orchestrator → planner` for spec/plan creation or revision.
2. `planner → orchestrator` with `PLAN-READY` or `PLAN-REVISED`, `suggests_next: "plan-reviewer-a"`.
3. `orchestrator → plan-reviewer-a`.
4. If A requests changes, `orchestrator → planner`; otherwise `orchestrator → plan-reviewer-b`.
5. If B requests changes, `orchestrator → planner`; otherwise `orchestrator → implementer`.
6. Any planner revision restarts at `plan-reviewer-a`.
7. Implementation output still goes to the existing `reviewer` before the orchestrator may end.

## Open questions

None. The approved spec resolved assistant permissions, role names, manifest versioning, prompt path behavior, and model-list policy.
