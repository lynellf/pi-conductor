# Spec: Manifest Model Effort + Status Visibility

## What I found

- Manifest parsing currently accepts `roles[].models` only as `readonly string[]` entries in `provider:id` form; `ProductionHost` and `StubHost` treat each entry as the logical model string and record it on `session_started.model`.
- pi SDK `createAgentSession` supports `thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`; its default is settings-driven, then `medium`. This feature should make conductor's manifest default explicit rather than relying on SDK/settings fallback.
- `RunStats.activeSession` is derived from the latest matching `session_started` record and currently exposes `{ role, sessionFile, model }`; `formatConductStatus()` renders `model=<...>` only while a session is active.
- The pure core can remain host-agnostic: effort is data carried through manifest/session records, while only `src/host/production-host.ts` passes it to pi as `thinkingLevel`.

## Objective

Add manifest-level per-model effort configuration, default omitted effort to `medium`, run role sessions with the configured effort, persist the effort for observability, and show the active effort in the conduct status line.

## Manifest syntax

Keep existing string syntax, but normalize it to explicit model entries during parsing:

```yaml
roles:
  - name: implementer
    max_visits: 3
    models:
      - model: openai-codex:gpt-5.5
        effort: high
      - model: openrouter:z-ai/glm-5.2
        # effort omitted -> medium
      - opencode-go:glm-5.2 # legacy shorthand -> { model: ..., effort: medium }
```

Rules:

- `models` may contain either strings or mappings.
- String entries are backward-compatible shorthand for `{ model: <string>, effort: medium }`.
- Mapping entries must include a non-empty `model` string and may include `effort`.
- Valid effort values are pi thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- Omitted `effort` defaults to `medium`, including roles with no `models` list (system/default model path).
- Existing provider/model validation still applies to the `model` string.

## Data model and behavior

- Add a host-agnostic `ModelEffort` type and default constant (`medium`) in the pure type layer or manifest layer.
- Change parsed `RoleConfig.models` from `readonly string[]` to normalized `readonly ModelConfig[]` where each entry is `{ model: string; effort: ModelEffort }`.
- Update model selection helpers to return both logical model and effort.
- `ProductionHost.spawnRole()` passes the selected effort to `createAgentSession({ thinkingLevel })` and returns `RoleSession.effort`.
- `StubHost.spawnRole()` mirrors the same normalized selection so loop tests remain deterministic.
- Extend lifecycle metadata and `session_started` / terminal records with `model_effort` for observability.
- Extend `RunStats.activeSession` with `effort`, derived from the matching `session_started` record and defaulting old records to `medium` for compatibility.
- Status line format while active becomes:
  - `conduct: worker · running · model=openai-codex:gpt-5.5 · effort=high · handoffs=0 · $0.000 · Esc abort`
  - `conduct: worker · running · model=<default> · effort=medium · handoffs=0 · $0.000 · Esc abort`

## Spec updates required

Update `docs/orchestrator-fsm-spec.md`:

- §8 manifest example: show object-form model entries and shorthand compatibility.
- §8.1 model assignment: define effort, allowed values, defaulting, and that driver maps effort to pi `thinkingLevel`.
- §11.4 lifecycle records: add `model_effort` next to `model`.
- §11.8 user-facing visibility: status line includes active model effort.
- §13 static checks: validate `models[].model` provider form and `models[].effort` values.

## Testing strategy

Add/update tests in small slices:

1. Manifest parser/validator tests
   - string shorthand normalizes to `{ model, effort: "medium" }`.
   - object form preserves explicit effort.
   - object form without effort defaults to `medium`.
   - invalid effort throws `ManifestParseError` or validation error consistently at the parser boundary.
   - provider:id validation applies to `entry.model`.
2. Host selection/spawn tests
   - selection helper returns both model and effort.
   - `ProductionHost.spawnRole()` exposes `RoleSession.effort` and passes the configured thinking level.
   - system/default model path uses effort `medium`.
   - `StubHost` matches production semantics.
3. Lifecycle/stats/status tests
   - `session_started` includes `model_effort`.
   - `runStats().activeSession.effort` is populated.
   - `formatConductStatus()` renders effort for declared and default active models.
4. Verification gates
   - `pnpm typecheck`
   - `pnpm test -- tests/manifest/parse.test.ts tests/manifest/validate.test.ts tests/host/production-host.test.ts tests/host/production-host-spawn.test.ts tests/host/loop.test.ts tests/host/stats.test.ts tests/extension/status.test.ts`
   - final full `pnpm test`, `pnpm lint`, `pnpm build`

## Boundaries

- Do not import pi runtime types into `src/core`, `src/manifest`, `src/seam`, `src/cost`, or `src/persistence`.
- Do not change reducer transition legality or machine topology.
- Do not add new dependencies.
- Preserve existing string manifest syntax.
- Do not rely on pi settings for omitted manifest effort; conductor defaults to `medium` explicitly.

## Success criteria

- Existing manifests using `models: [provider:id]` continue to parse and run with `medium` effort.
- New object-form model entries run with their configured effort.
- Active run status clearly shows both model and effort.
- Effort is persisted on lifecycle records and available through `RunStats.activeSession`.
- Full repository verification passes.

## Open questions

None blocking. The spec intentionally names the manifest field `effort` while mapping it to pi's SDK `thinkingLevel` internally; this keeps the user-facing syntax short and provider-neutral.

## Summary of changes in this spec

- Introduces normalized per-model manifest entries with `effort`.
- Defines `medium` as the conductor-owned default.
- Scopes implementation to manifest parsing/validation, host spawn wiring, lifecycle observability, status rendering, and tests.
