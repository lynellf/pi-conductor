# Spec: Active Model in Status/List Output

## What I found

- The repo has `docs/orchestrator-fsm-spec.md` available in the working tree, but the active-model change is not covered there; it is a small additive extension-level observability change on top of §11.8 user-facing visibility.
- Live status output is formatted by `src/extension/status.ts::formatConductStatus(stats)`, which currently renders: `conduct: <state> · <exitReason> · handoffs=<N> · $<cost>`.
- `/conduct:list` output is rendered in `src/extension/commands/list.ts` from `runStats(records, runId, def, "running")`; each line currently renders: `<runId> · <state> · <exitReason> · $<cost> [· <transition trace>]`.
- `runStats` in `src/host/stats.ts` already projects persisted lifecycle/checkpoint data into the shared `RunStats` surface used by both status and list output.
- The active model is already persisted on `session_started` lifecycle records (`SessionLifecycleEvent.model`), and the current live session is already snapshotted on `Checkpoint.active_role_session` after `session_started`. No persistence schema change is needed.
- A transient accepted-transition snapshot can have `checkpoint.current_role` advanced while `checkpoint.active_role_session.role` still points at the just-finished previous session until `session_ended` clears it. The display must avoid showing that previous session's model as the next role's active model.

## Assumptions

1. "Active model between handoffs" means: while a role session is actively running after `session_started` and before its terminal `session_ended`/`session_failed`, show that session's model in the status/footer and list summary.
2. Completed, failed, aborted, idle, or between-session runs should not show a stale model.
3. A role without a manifest `models:` entry has `SessionLifecycleEvent.model === null`; user-facing output should render that as `model=<default>` only when there is an active session.
4. This is an observability/UI projection change only. It must not change reducer behavior, lifecycle record schemas, persistence format, model fallback behavior, or pi session spawning.

## Objective

Expose the currently active role session's model in both live status and `/conduct:list` output, using the existing append-only lifecycle/checkpoint records. Success means a user can see which model is currently doing work during the quiet interval between handoff notifications without inspecting JSONL logs.

## Proposed public contract

Add a small, additive stats projection in `src/host/stats.ts`:

```ts
export interface ActiveSessionStats {
  readonly role: Role;
  readonly sessionFile: string;
  readonly model: string | null;
}

export interface RunStats {
  readonly runId: string;
  readonly manifestVersion: string;
  readonly state: Role | "done";
  readonly exitReason: RunExecutionStatus;
  readonly transitionHistory: readonly TransitionRecord[];
  readonly costRollup: RunRollup;
  readonly latestCheckpoint: Checkpoint | null;
  readonly recordsCount: number;

  /**
   * Present only while the latest checkpoint points at an active same-role
   * session with a matching `session_started` lifecycle record. `null` means
   * no active displayable session. Optional for source compatibility with
   * external RunStats object literals/test doubles.
   */
  readonly activeSession?: ActiveSessionStats | null;
}
```

Public export requirement:

- `ActiveSessionStats` must be exported from `src/host/stats.ts`.
- `src/host/run-handle.ts`, `src/host/index.ts`, and `src/index.ts` must re-export `ActiveSessionStats` alongside the existing `RunStats` surface.
- `activeSession` is optional for source compatibility with existing external `RunStats` test doubles/object literals, but `runStats(...)` and `RunHandle.runStats()` must always return it as either an object or `null`.

Derivation rules:

1. If there is no latest checkpoint, return `activeSession: null`.
2. If `latestCheckpoint.active_role_session === null`, return `activeSession: null`.
3. If `latestCheckpoint.active_role_session.role !== latestCheckpoint.current_role`, return `activeSession: null` to avoid the canonical post-handoff/pre-terminal transient showing a stale model.
4. Otherwise, find the matching `session_started` record for the same `run_id`, `role`, and `session_file` in the run records.
5. If found, return `{ role, sessionFile, model }` from that `session_started` record.
6. If no matching `session_started` is found, return `activeSession: null`; do not synthesize `unknown` or guess.

## User-facing output

- Live status line:
  - No active session: unchanged.
    - `conduct: orchestrator · running · handoffs=0 · $0.000`
  - Active declared model:
    - `conduct: worker · running · model=anthropic:claude-sonnet-4-5 · handoffs=1 · $0.012`
  - Active system/default model (`activeSession.model === null`):
    - `conduct: worker · running · model=<default> · handoffs=1 · $0.012`
- `/conduct:list` per-run line:
  - No active session: unchanged.
    - `<runId> · done · running · $0.000 · orchestrator → worker → done`
  - Active declared model:
    - `<runId> · worker · running · $0.000 · model=stub:primary · orchestrator → worker`
  - Active system/default model (`activeSession.model === null`):
    - `<runId> · worker · running · $0.000 · model=<default> · orchestrator → worker`

The exact model string should not be truncated in v1. This is a deliberate over-budget footer choice: the existing status formatter targets a narrow footer line, but model identity is the point of this feature and ambiguity is worse than occasional footer crowding. If real TUI crowding becomes a problem, solve it later with an explicit UI design (for example a widget/detail view), not by silently truncating the v1 model string.

## Commands

Use pnpm only.

```bash
pnpm typecheck
pnpm build
pnpm test -- tests/host/stats.test.ts tests/extension/status.test.ts tests/extension/conduct-list.test.ts
pnpm test
pnpm lint
pnpm format:check
```

## Project structure / impacted files

- `src/host/stats.ts`
  - Add `ActiveSessionStats` type and `RunStats.activeSession` projection.
  - Add a small pure helper to derive active session/model from checkpoint + lifecycle records.
- `src/host/run-handle.ts`, `src/host/index.ts`, and `src/index.ts`
  - Re-export `ActiveSessionStats` from the existing public barrels.
- `src/extension/status.ts`
  - Append `model=<...>` only when `stats.activeSession` is present and non-null.
- `src/extension/commands/list.ts`
  - Append `model=<...>` only for active sessions, preserving existing inactive/completed formatting.
- `tests/host/stats.test.ts`
  - Cover active model derivation, default-model active sessions (`model: null`), no-active-session behavior, missing `session_started`, and stale transient suppression.
- `tests/extension/status.test.ts`
  - Cover status formatting with declared model, default model (`activeSession.model === null`), explicit `activeSession: null`, and omitted `activeSession` for backward-compatible fixtures.
- `tests/extension/conduct-list.test.ts`
  - Cover list formatting for active synthetic runs with matching `session_started` records for both declared models and default-model (`model: null`) sessions, plus unchanged no-active output.
- `README.md`
  - Briefly document that status/list can show `model=<provider:id>` or `model=<default>` while a role session is active.

## Code style

Keep the implementation boring and local. Example target style:

```ts
function formatActiveModel(model: string | null): string {
  return model === null ? "<default>" : model;
}
```

No new abstraction layer, no new dependency, no mutation of persisted records, and no pi imports outside allowed host/extension layers.

## Testing strategy

- Unit-test the pure `runStats` projection directly with synthetic `PersistedRecord[]`.
- Unit-test status string formatting with `RunStats` literals for:
  - declared active model,
  - default active model (`activeSession.model === null`),
  - explicit no active session (`activeSession: null`), and
  - omitted `activeSession` to prove source-compatible formatting of older fixtures.
- Integration-test `/conduct:list` through the existing extension harness by writing synthetic JSONL runs containing:
  - a `session_started` record with `model: "stub:primary"`, and a latest checkpoint with matching `active_role_session` and `current_role`, and
  - a separate/default-model case with `model: null` that renders `model=<default>`.
- Run `pnpm build` in addition to typecheck/tests because this changes exported public types and emitted declaration files.
- Run the full repo tests after targeted tests because `RunStats` is a public-ish surface used across host/extension tests.

## Boundaries

- Always:
  - Preserve the host-agnostic core invariant.
  - Use existing lifecycle/checkpoint records as the data source.
  - Keep `activeSession` additive/backward-compatible.
  - Omit the model when there is no active session or the checkpoint/session data is inconsistent.
  - Re-export the new `ActiveSessionStats` type through the same host/root barrels that expose `RunStats`.
- Ask first:
  - Changing persisted record shapes.
  - Adding active model to transition notifications or run-memory prompts.
  - Truncating, aliasing, or otherwise shortening model names.
- Never:
  - Store model on `Checkpoint.active_role_session` just for display.
  - Change reducer/lifecycle semantics.
  - Reach into pi SDK session internals from the extension shell.
  - Guess a model from manifest order when the lifecycle record is missing.

## Success criteria

- `runStats(...)` and `RunHandle.runStats()` always return `activeSession` as either `ActiveSessionStats` or `null`.
- `RunHandle.runStats().activeSession?.model` reflects the active role session's `session_started.model` while a same-role active session is snapshotted.
- `formatConductStatus` includes `model=<provider:id>` or `model=<default>` only during an active session.
- `/conduct:list` includes `model=<provider:id>` or `model=<default>` only for runs whose latest checkpoint indicates an active same-role session.
- Existing no-active/completed list and status formatting remains unchanged.
- Targeted and full verification commands, including `pnpm build`, pass.

## Open questions

None blocking. The main display choice is to show exact model strings without truncation; this is intentional for correctness and can be revisited if TUI footer crowding becomes a real problem.

## Change summary

Revised after plan-review feedback: made the public `RunStats.activeSession` / `ActiveSessionStats` shape and export path explicit, added `pnpm build` to verification, required explicit default-model/null rendering coverage, and documented the footer-width tradeoff as a deliberate over-budget choice.
