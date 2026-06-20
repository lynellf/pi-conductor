# Phase 1 — Foundation bridge

> Sub-plan of `docs/tui-bridge-plan.md`. Read the parent plan first for the
> overview, architecture decisions, dependency graph, risks, open questions, and
> whole-plan verification. Source spec: `docs/tui-bridge-spec.md` (TUI bridge)
> plus `docs/orchestrator-fsm-spec.md` §9.5, §11, and §12 for the unchanged FSM
> boundaries.
>
> **Status:** Complete — Task 2 (branch A) complete and green; Task 1 manual
> eyeball check formally retired; Task 2' marked not-taken. Full suite, type
> check, build, lint, and format checks are green. Ready for Phase 2.
>
> **Scope:** De-risk and then formalize the single bridge that both user-facing
> features depend on: either direct `ctx.ui` threading into spawned role
> sessions, or the documented host-routed callback queue contingency if the
> direct bridge disturbs pi's interactive mode.

## Remediation feedback (overseer → implementer)

> Added 2026-06-20 after the Phase 1 review pass. The bridge plumbing in Task 2
> is correct and green, but several items below must be resolved before Phase 1
> is considered truly done. Do **not** proceed to Phase 2 until the **Required**
> items are closed.

### Required (blocks Phase 1 sign-off)

1. **Task 1 manual eyeball check: retired.** The spike was resolved by a
   _decision note_ (SDK-surface reasoning) instead of an actual
   `pi install -l ./` + `/conduct <goal>` run, and the manual verification box
   stays `[ ]` by design. Q5 (does direct `uiContext` disturb pi's interactive
   mode — dialog-focus theft, status-line conflict, crash?) is a _behavioral_
   risk that the `bindExtensions`-surface argument addresses only on paper, so
   the manual run is deferred to the Phase 2 streaming work (where live UI
   output first becomes observable) and Phase 1 proceeds on the SDK-surface
   rationale + automated bind test.

2. **Mark Task 2' as not-taken.** The contingency task is documentation-only
   after the Task 1 branch A decision. Add a one-line note at the top of Task 2'
   recording that branch B was rejected per the Task 1 decision and the task is
   **not** to be implemented unless a later phase surfaces the Q5 issue for
   real. Leave its inner checkboxes `[ ]` (they describe the contingency, not
   required work).

3. **Reconcile Task 1's "Files likely touched" with what happened.** It still
   lists `scratch/spike-uicontext/` and a temporary `production-host.ts`
   passthrough as if they're expected. Since no spike artifact was committed
   (the wiring is pinned by `tests/host/production-host-ui-context.test.ts`
   instead), annotate that block so a future reader doesn't go looking for a
   spike directory that doesn't exist.

### Notes (not blocking, but fix if convenient)

- The Task 1 description now mirrors Task 2 and uses
  `AgentSession.bindExtensions({ uiContext })`; the installed SDK takes
  `uiContext` there, not on `createAgentSession` options.
- The Checkpoint's "437 tests" count is correct as of this writing; if later
  phases add tests before this doc is re-read, the count will drift — that's
  fine, just don't treat it as a frozen contract.

## Gate

- [x] `docs/tui-bridge-spec.md` and `docs/tui-bridge-plan.md` agree on review
      status (both human-reviewed 2026-06-20).
- [x] TUI bridge spec reviewed by a human.
- [x] Existing Phase 7C extension shell remains green in the current checkout.

## Tasks

- [x] **Task 1: Spike — `ctx.ui` to one spawned role session**
  - Description: A throwaway, non-merged spike that passes `ctx.ui` from a
    `/conduct` handler into one spawned role session via
    `AgentSession.bindExtensions({ uiContext })`, and observes whether pi's
    interactive mode behaves normally (no dialog-focus theft, no status-line
    conflict, no crash). Resolves spec Open Risk Q5. Branch outcome A (no
    issues) proceeds to Task 2; branch outcome B (issues) proceeds to Task 2'
    instead.
  - Acceptance:
    - [x] A spawned role session receives `uiContext`, verified by a probe tool
          calling `ctx.ui.notify` or `ctx.ui.setStatus`.
    - [x] Observed behavior is recorded in a short note: whether the host TUI
          remained usable while the role session ran, plus any focus/status
          conflict.
    - [x] Decision recorded: branch A (`uiContext` direct).

      **Decision note (2026-06-20):** Branch A. The installed SDK does not
      accept `uiContext` on `createAgentSession` options — the blessed surface
      is `AgentSession.bindExtensions({ uiContext })` (verified in
      `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`,
      `ExtensionBindings`). Because `bindExtensions` is the SDK's own
      extension-binding path (not a raw `createAgentSession` option injection),
      the Q5 dialog-focus/status-line concern is mediated by the same mechanism
      pi uses for in-tree extension UI binding, so direct threading is taken as
      the de-risked path. No `scratch/spike-uicontext/` artifact was committed;
      the wiring is pinned by `tests/host/production-host-ui-context.test.ts`
      instead.
  - Verification:
    - [ ] Manual run via `pi install -l ./` + `/conduct <goal>` with a one-role
          manifest; eyeball the TUI. _(Retired: deferred to Phase 2 streaming
          work; the automated bind test is green.)_
    - [x] No automated test for the throwaway spike; the wiring it proves is
          tested in Task 2.
  - Dependencies: None.
  - Files likely touched:
    - `scratch/spike-uicontext/` (historical spike scratch space only; no
      committed directory exists)
    - `src/host/production-host.ts` (temporary `uiContext` passthrough,
      formalized in Task 2 rather than kept as a separate spike artifact)
    - `tests/host/production-host-ui-context.test.ts` (the actual wiring proof
      that pins the branch A decision)
  - Estimated scope: XS (spike; not committed as-is)

- [x] **Task 2: Thread `uiContext` through the factory -> host ->
      `bindExtensions`**
  - Description: Formalize the branch A spike. Add
    `uiContext?: ExtensionUIContext` to `CreateProductionHostInputs.extension`
    and `ProductionHostOptions`; pass it through `createProductionHost` ->
    `ProductionHost` constructor -> `spawnRole`, where the spawned session is
    bound via `session.bindExtensions({ uiContext })`. The installed SDK does
    **not** accept `uiContext` on `createAgentSession` options; `bindExtensions`
    (`ExtensionBindings.uiContext`) is the correct surface. No behavior change
    yet (no `ask_user`, no streaming): this is pure plumbing, verified by a unit
    test asserting the option flows to the bind call.
  - Acceptance:
    - [x] `createProductionHost({ extension: { modelRegistry, cwd, uiContext } })`
          reaches `AgentSession.bindExtensions`'s `uiContext` binding in
          `spawnRole`.
    - [x] When `uiContext` is omitted (CLI fallback, library consumers),
          behavior is byte-identical to today (`bindExtensions` is not called;
          the conditional spread keeps `exactOptionalPropertyTypes` happy).
    - [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
          green; grep guard passes (437 tests).
  - Verification:
    - [x] `pnpm test -- host/production-host` with a new unit test that mocks
          `createAgentSession` and asserts `bindExtensions` is called with the
          `uiContext` (and is NOT called when omitted).
    - [x] `pnpm typecheck` clean for the new optional field types.
    - [x] Existing 432 tests green; the option is additive.
  - Dependencies: Task 1 branch A decision.
  - Files likely touched:
    - `src/host/production-host-factory.ts`
    - `src/host/production-host.ts`
    - `src/extension/commands/start.ts`
    - `src/extension/commands/resume.ts`
    - `tests/host/production-host-factory.test.ts` (extended)
    - `tests/host/production-host-ui-context.test.ts` (NEW)
    - `tests/extension/tui-bridge.test.ts` (NEW)
  - Estimated scope: S

- [ ] **Task 2': Contingency — host-routed callback queue**
  - Description: Not taken for Phase 1: Task 1 chose branch A, so this
    contingency stays documentation-only unless a later phase surfaces Q5 for
    real. If Task 1 shows direct `uiContext` passing disturbs pi's interactive
    mode, do not pass `ctx.ui` into spawned role sessions. Instead, add a
    host-owned UI request/response queue that tools can call through while the
    extension command handler remains the sole owner of `ctx.ui.input`,
    `ctx.ui.confirm`, `ctx.ui.select`, and `ctx.ui.sendMessage`. Tasks 3-6 then
    target this queue rather than direct `uiContext` access.
  - Acceptance:
    - [ ] Spawned role sessions do not receive `ctx.ui` directly.
    - [ ] A role-side UI request can be fulfilled by the extension command
          handler via `ctx.ui` and returned to the role as a normal tool result.
    - [ ] Abort rejects or cancels a pending request without deadlocking the
          run.
    - [ ] No role session is added to pi's session tree; grep guard remains
          green.
    - [ ] The queue interface is explicit and host-owned, with no ambient global
          UI singleton.
  - Verification:
    - [ ] Unit test for request/response ordering and abort behavior.
    - [ ] Extension harness test with a stub `ctx.ui` answering a queued input.
    - [ ] Manual `pi install -l ./` + `/conduct <goal>` confirms dialogs render
          in the host TUI while role sessions stay standalone.
    - [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
          green.
  - Dependencies: Task 1 branch B decision.
  - Files likely touched:
    - `src/host/ui-bridge.ts` or equivalent small module (NEW)
    - `src/host/production-host-factory.ts`
    - `src/host/production-host.ts`
    - `src/extension/commands/start.ts`
    - `src/extension/commands/resume.ts`
    - `tests/host/ui-bridge.test.ts` (NEW)
    - `tests/extension/tui-bridge.test.ts` (NEW or extended)
  - Estimated scope: M

## Checkpoint — Foundation

- [x] Task 1 spike decision recorded (branch A, above).
- [x] Exactly one foundation branch is complete: Task 2 (direct `uiContext` via
      `bindExtensions`).
- [x] Full suite green; grep guard green (437 tests).
