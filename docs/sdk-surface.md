# SDK Surface Spike — pi SDK host driver

> Verified against `@earendil-works/pi-coding-agent` docs (`docs/sdk.md`) on
> 2026-06-18. Purpose: pin the exact SDK primitives the orchestrator FSM host driver
> (plan Phase 4) programs against, so Tasks 13–19 are not built on assumed signatures.
> This is the spike referenced by the implementation-readiness review.

## 1. Session factory — `createAgentSession`

The single factory for one `AgentSession`. Confirmed option surface (from
`docs/sdk.md` → "Options Reference"):

| Option | Type / shape | Notes |
|---|---|---|
| `model` | `Model` | Per-role model selection lives here. Resolve via `modelRegistry.find(provider, id)` or `getModel(provider, id)`. |
| `tools` | `string[]` | **Allowlist.** Must include custom tool names (`handoff`, `end`) to enable them. Built-in names: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. |
| `customTools` | `Tool[]` | Combined with extension-registered tools. This is where `handoff`/`end` `defineTool()` entries go. |
| `sessionManager` | `SessionManager` | Use `SessionManager.inMemory()` for unit tests; `SessionManager.create(cwd)` for real runs. |
| `resourceLoader` | `ResourceLoader` | **The system-prompt hook.** Pass a `DefaultResourceLoader`. |
| `authStorage` / `modelRegistry` | — | Needed to resolve real models; the stub provider (Task 16) sidesteps these in CI. |
| `cwd` / `agentDir` | `string` | Influence session naming + tool path resolution. Ignored for resource discovery when a custom `resourceLoader` is passed. |
| `thinkingLevel` | `"off"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"` | Optional per-role. |

### ⚠️ Corrections baked into the plan from this spike

- **`systemPromptOverride` is NOT a direct `createAgentSession` option.** It is a
  `DefaultResourceLoader` constructor option. Per-role system prompts are wired as:
  ```ts
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => rolePrompt,   // read from manifest system_prompt path
  });
  await loader.reload();
  const { session } = await createAgentSession({
    model, tools: [...roleTools, "handoff", "end"],
    customTools: [handoffTool, endTool],
    resourceLoader: loader,
    sessionManager,
  });
  ```
  (Plan Task 15 + spec §12 updated to reflect this.)
- **`tools` is an allowlist that must name custom tools.** Forgetting to add
  `"handoff"`/`"end"` to `tools` silently disables them even though they're in
  `customTools`. Task 15 now states this explicitly.

## 2. Custom tools — `defineTool` (TypeBox, confirmed)

```ts
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

const handoffTool = defineTool({
  name: "handoff",
  label: "Handoff",
  description: "Terminate this role and route to another role.",
  parameters: Type.Object({                          // TypeBox — single source of truth
    target_role: Type.String(),
    reason: Type.Optional(Type.String()),
    suggests_next: Type.Optional(Type.String()),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: "Emission recorded; do not call further tools." }],
    details: {},
  }),
});
```

This validates the plan's TypeBox decision (Architecture Decisions): `defineTool`
params are TypeBox, so the same schema derives the `MachineEvent` payload type via
`Static<>` and is the seam `validateEmission` checks. **No Zod anywhere.**

### Tool ≠ session termination (critical for plan Tasks 14/15)

A custom tool call does **not** automatically end the role session — the model may
call more tools afterward. Therefore:
- The `handoff`/`end` tools only **record intent** into a per-session capture buffer
  and return a terminating *message*; they do not end the session.
- The **loop** enforces termination: after `session.prompt()` resolves, it reads the
  capture buffer and asserts exactly one machine-event. Zero → `no_emission`;
  >1 → `extra_emission`; one → `reduce` + persist + spawn.
- `reduce` and persistence run **only in the loop**, never in the tool — this is the
  single-owner rule that prevents a double-reduce/double-persist path.

## 3. Event stream — usage capture (RESOLVED — see below)

`session.subscribe((event: AgentSessionEvent) => …)` emits a discriminated union.
Confirmed event types from `docs/sdk.md` → "Events":

- `message_start` / `message_end` — message lifecycle. **`message_end` is a marker;
  the docs do not show a `usage` field on it.**
- `turn_start` / `turn_end` — one LLM response + tool calls. `turn_end` exposes
  `event.message` (assistant response) and `event.toolResults`.
- `agent_start` / `agent_end` — `agent_end` carries `event.messages`.
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end` —
  `event.toolName`, `event.isError`.
- `queue_update`, `compaction_*`, `auto_retry_*`.

### ✅ Resolved (inspected `@earendil-works/pi-ai` `dist/types.d.ts`)

`usage` is **not** a field on `MessageEndEvent`/`TurnEndEvent` directly. Both events
carry `message: AgentMessage`. Usage lives on the **`AssistantMessage`** (`message.usage`),
typed as `pi-ai`'s `Usage`:

```ts
interface Usage {
  input: number;
  output: number;
  cacheRead: number;          // camelCase
  cacheWrite: number;         // camelCase
  cacheWrite1h?: number;      // Anthropic-only split; ignore for v1 roll-up
  totalTokens: number;        // NOT `tokens`
  cost: {                     // cost is an OBJECT, not a number
    input: number; output: number; cacheRead: number; cacheWrite: number;
    total: number;            // <- this is the §11.4 record `cost`
  };
}
```

**Host mapping (`src/host/cost.ts`), §11.4 normalized record ← SDK `Usage`:**

| §11.4 record field | SDK source |
|---|---|
| `input` | `message.usage.input` |
| `output` | `message.usage.output` |
| `cache_read` | `message.usage.cacheRead` |
| `cache_write` | `message.usage.cacheWrite` |
| `tokens` | `message.usage.totalTokens` |
| `cost` | `message.usage.cost.total` |

**Two gotchas the mapping MUST handle:**
1. `message_end` fires for **user / assistant / toolResult** messages. `usage` exists
   only on `assistant` messages → guard `message.role === "assistant"` before reading,
   else `undefined`/crash.
2. A role session emits **many** assistant messages. The §11.4 per-session terminal
   `usage` is the **sum across** that session's assistant `message_end` events, not a
   single capture. The per-session cap (§11.7) reads the same running sum on `turn_end`.

Task 16's stub provider must emit canned `usage` in **this** shape (camelCase, nested
`cost`) so the normalization mapping is asserted in CI. This was the largest pre-spike
unknown; it is now pinned.

## 4. Session control primitives (confirmed)

- `session.prompt(text, options?)` — send a prompt and await completion. Use this to
  drive each role turn with `seedFromHandoff(payload)`.
- `session.steer(text)` — queue a steering message during streaming. This is the
  mechanism for run-cap-breach forced-`end` (§11.7): steer "run cost cap reached,
  end now." **Caveat (open):** if the model ignores the steer and hands off again,
  nothing currently force-closes the run. The host may need to `abort()` + inject an
  `end` transition directly, or force-`done` outside the reducer. This is a spec gap
  to close before Task 17, not an SDK gap.
- `session.abort()` — abort the current operation. Used for per-session cost-cap
  breach (§11.7): abort, then record `session_failed` with
  `session_cost_cap_exceeded`.
- `session.dispose()` — cleanup.
- `session.sessionFile`, `session.sessionId` — feed `session_file` in §11 records.

## 5. Session replacement vs. fresh sessions

- `createAgentSession` creates a **fresh, independent** `AgentSession`. Each role
  invocation = one `createAgentSession` call. Nothing is captured across them.
  This is the model the plan uses; it avoids the `ExtensionContext`-lacks-`newSession`
  problem (§9.5) entirely.
- `AgentSessionRuntime` (`createAgentSessionRuntime`) is the *replacement* layer
  (`newSession`, `switchSession`, `fork`). **The host driver does not need this** —
  it spawns fresh sessions, not replaces one. If branch/tree scoping of role
  sessions onto one persisted log is later required, revisit `SessionManager`
  scoping (see §6).

## 6. Persistence / branch scoping (RESOLVED — safe default adopted)

- `SessionManager.inMemory()` for tests; `SessionManager.create(cwd)` for real runs.
- **Decision:** the host owns its **own `run_id`-keyed append-only log** and
  reconstructs the checkpoint from the latest snapshot for that `run_id`. It does
  **not** rely on `SessionManager.getBranch()` scoping at all. Spec §11.1 has been
  updated to mandate this.
- **Rationale:** role sessions are spawned as separate `createAgentSession` calls and
  are not guaranteed to share the host session's branch. `parent_session` links them
  into a tree (§11.4), but tree-links ≠ branch membership, so a `getBranch()`-scoped
  replay could silently miss role-session records. Keying solely on `run_id` is
  branch-independent and correct regardless of how `sessionManager` scopes spawned
  sessions — which removes the dependency on confirming that semantic at all. (If a
  future TUI viewer wants branch-tree navigation, it can layer on top; v1 does not
  need it.)

## Summary of plan/spec deltas from this spike

| Item | Status | Where applied |
|---|---|---|
| `systemPromptOverride` is a `ResourceLoader` option | Fixed | spec §12, plan AD + Task 15 |
| `tools` allowlist must include `handoff`/`end` | Fixed | plan Task 15 |
| Tool does not end session; loop enforces exactly-one emission | Fixed | plan Tasks 14 & 15 |
| `defineTool` uses TypeBox | Confirmed | plan AD (no change) |
| `usage`/`cost` shape on `message_end`/`turn_end` | **Resolved** | §3: `message.usage` (`AssistantMessage`), camelCase + nested `cost.total`, `totalTokens`; assistant-only guard + per-session sum |
| Forced-`end` on run-cap breach mechanism | **Resolved** | spec §11.7 / plan Task 17: synthesized `end` event through `reduce`; direct checkpoint mutation forbidden |
| Role-session branch scoping for checkpoint replay | **Resolved (safe default adopted)** | spec §11.1 now mandates the host-owned `run_id`-keyed log; `getBranch()` scoping explicitly NOT used |
| Model naming form (`provider:id`) + resolution | **Resolved** | spec §8.1: `provider:id` via `modelRegistry.find(provider, id)`; bare aliases hard-rejected (§13) |
