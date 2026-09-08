# `RoleConfig` fields

← [Back to README](../README.md#quick-start)

## Contents

- [RoleConfig fields](#roleconfig-fields)

| Field                  | Applies to        | Meaning                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | all roles         | Role identity (the `Role` the reducer keys on).                                                                                                                                                                                                           |
| `is_orchestrator`      | exactly one role  | Marks the hub. Workers hand back to it; only it may emit `end`.                                                                                                                                                                                           |
| `max_visits`           | workers           | Per-worker visit cap (finite). **Uncapped workers are a hard manifest error (§13).**                                                                                                                                                                      |
| `models`               | any role          | Ordered `[primary, ...fallbacks]`. Each entry is a `provider:id` string (shorthand for `{ model, effort: "medium" }`) or an object `{ model, effort }`. Bare aliases are rejected (§13). Effort values: `off | minimal | low | medium | high | xhigh | max` (maps to pi's `thinkingLevel`; `max` is available on models such as GPT-5.6 that support it). Omitted effort defaults to `medium`, including the system/default model path. Fallbacks are tried on `session_failed(model_error)`. |
| `max_session_cost_usd` | any role          | Per-invocation cap, **shared across model fallbacks** within that invocation (§8.1, §11.7).                                                                                                                                                               |
| `max_run_cost_usd`     | orchestrator only | Run-level cap. Rejected on workers (§13).                                                                                                                                                                                                                 |
| `system_prompt`        | any role          | Path to a per-role system-prompt file the host loads. Plain prose, not frontmatter.                                                                                                                                                                       |
| `tools`                | any role          | Declared tool allowlist. `handoff` and `end` are **force-injected by the host regardless**; omitting them emits a §13 warning. `delegate` is available only when it is listed here **and** the role declares `delegation`. See [Tools available to roles](role-tools.md#tools-available-to-roles) below for the full tool model and the `tools:`-omission footgun. |
| `delegation`           | parent roles only | Enables bounded worktree subagents for this role. Requires `tools: [..., delegate]`; see [Worktree subagent delegation](delegation.md#worktree-subagent-delegation) below. |

The optional top-level `end_request_roles` list enables gated completion. It
must contain one or more unique declared worker roles—never the orchestrator.
When omitted, legacy behavior is preserved: the orchestrator may call `end`
without a pending request. When configured, an authorized worker must first
handoff to the orchestrator with `status: complete` and `request_end: true`.
That approval is single-use: it is consumed by `end` and cleared if the
orchestrator dispatches more work. Run-cost-cap forced closure remains legal
without a request and still passes through the reducer.

`version` is a human-bumped integer, **pinned at run-start and never mutated
mid-run** (spec §10). `resumeRun` rejects a manifest whose version disagrees
with the snapshot's pinned version.

Related reference: [per-role isolated workspaces](workspaces.md#per-role-isolated-workspaces-issue-48) and [worktree subagent delegation](delegation.md#worktree-subagent-delegation) extend role configuration with workspace and child-profile policies.
