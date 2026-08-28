# Issue #63 — trajectory-preserving handoffs

**Status: Acknowledged — implementation complete; fail-closed resume remediation re-review requested**

## Objective and scope

Issue [#63](https://github.com/lynellf/pi-conductor/issues/63) adds an opt-in, per-legal-edge transport policy. A `trajectory` edge continues the *same Pi conversation* into the target role so its prior user/assistant/tool-result trajectory remains model-visible; a `fresh` edge retains the current handoff/context path unchanged. Models never select transport in `handoff()`.

This is deliberately a host feature. Manifest parsing and validation stay pure in `src/manifest`; `reduce` and `reduceLifecycle` continue to receive only machine events and never interpret conversations. Pi imports and all session operations remain in `src/host`. This follows the archived FSM spec §10 (pinned manifest), §11.1/§11.4 (snapshot/lifecycle persistence), and §12 (pure reducer), plus `AGENTS.md`’s core/host boundary.

### Assumptions made explicit

1. “Exact trajectory” means the active Pi branch's complete message and tool-result sequence, not a handoff summary, context reference, or a compacted branch summary.
2. The MVP supports only a single active role and only shared-workspace trajectory edges. It does not make a source workspace's built-in tools safe for a different worktree/copy/container workspace.
3. The checkout SDK (`@earendil-works/pi-coding-agent` **0.80.6**) is the implementation evidence. The PATH Pi CLI (**0.84.3**) is recorded only as a separate runtime-version observation; it is not an API compatibility claim.
4. A trajectory preflight failure is not eligible for fresh fallback. It leaves the accepted FSM state auditable and closes the run with a typed host failure.

## Evidence and SDK decision

### Versions and sources

| Evidence | Observed version / result | Use in this contract |
| --- | --- | --- |
| Checkout package, `node_modules/.bin/pi --version` | `@earendil-works/pi-coding-agent` 0.80.6 / `0.80.6` | Sole SDK API and behavior basis. |
| Checkout package companions | `@earendil-works/pi-ai` 0.80.6 and `@earendil-works/pi-agent-core` 0.80.6, resolved beneath coding-agent | Required by the 0.80.6 session experiment. |
| Active PATH CLI, `pi --version` | `0.84.3` at `/home/lynellf/.nvm/versions/node/v26.5.0/bin/pi` | Separate operational fact only. Re-run the spike before using its API surface. |
| Node | `v26.5.0` | Spike runner environment. |

Version commands recorded for this checkout were:

```bash
node_modules/.bin/pi --version # 0.80.6
pnpm list @earendil-works/pi-coding-agent --depth 0 # 0.80.6
pi --version # 0.84.3 (PATH runtime, separate evidence)
```

Official packaged Pi 0.80.6 documentation says `AgentSession` exposes `sessionId`, `sessionFile`, `messages`, `setModel`, and `setThinkingLevel` (`node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`, lines 75–118), and demonstrates `SessionManager.open()` (`docs/sdk.md`, lines 723–795). Exact local declarations add `setActiveToolsByName()` and say it rebuilds the system prompt for the next turn (`dist/core/agent-session.d.ts`, lines 275–314), model/thinking setters (`lines 423–452`), `getContextUsage()` (`lines 588–594`), and `SessionManager.open(path, sessionDir?, cwdOverride?)` (`dist/core/session-manager.d.ts`, lines 250–320). Model metadata contains `contextWindow` and `maxTokens` (`@earendil-works/pi-ai/dist/types.d.ts`, lines 581–600). `ContextUsage.tokens` is explicitly nullable immediately after compaction (`dist/core/extensions/types.d.ts`, lines 192–197).

For replacement instructions, the official extension guide documents `before_agent_start` as able to modify the fully assembled system prompt (`docs/extensions.md`, lines 513–523 and the example around lines 480–548) and documents dynamic tool registration/activation (`docs/extensions.md`, “pi.registerTool” and “pi.setActiveTools”; lines 1327–1370 and 1600–1680). These are the public/documented mechanisms used by the spike—not a private `_agent` field.

### Reproducible no-key spike

Artifact: [`sdk-feasibility-spike.mjs`](./sdk-feasibility-spike.mjs)

```bash
node --max-old-space-size=1024 docs/issue-63-trajectory-handoffs/sdk-feasibility-spike.mjs
```

It creates a temporary persistent session directory, a `spike` provider with a literal non-live key and in-process stream, a source-only custom tool, a target-only custom tool, and a dynamic `before_agent_start` extension. No network provider or live API key is used; the temporary directory is removed in `finally`.

Observed 0.80.6 run (session IDs and temp paths are intentionally run-specific):

```text
sessionId: 01a0467e-0e67-7aea-a7f1-af445eaa0a65
sessionFile: /tmp/issue-63-sdk-spike-erXBOM/sessions/...jsonl
source request: model=source, prompt=SOURCE_ROLE_ONLY,
  tools=[source_tool,target_tool]
target request: model=target, prompt=TARGET_ROLE_ONLY,
  tools=[target_tool], messages=[user,assistant,toolResult,user]
source executions=1; target executions=1
known admission: required=142, window=1000
too-large admission: trajectory_context_too_large, requires 136 / window 1
unknown admission after a compaction entry: trajectory_context_unknown
reopened sessionId/sessionFile identical; restored selected model=tiny
result=PASS
```

The target provider inspected—not merely typed—the source user prompt, source assistant `source_tool` call, and exact `SOURCE_TOOL_RESULT_EXACT` before it received the target prompt. It intentionally emitted `source_tool` after target tool replacement; the source executor remained at one call while `target_tool` executed once. That proves no source custom tool remained model-callable through the active target allowlist.

| Required feasibility claim | 0.80.6 observed result | Contract consequence |
| --- | --- | --- |
| Completed trajectory survives model switch and target prompt | **Pass.** Same session ID/file; target provider received `user → assistant(tool call) → toolResult → target user`. | Use one persistent `AgentSession` for a selected trajectory chain. |
| Model and thinking level change in place | **Pass.** `await setModel(target)` then `setThinkingLevel("high")`; same session ID/file, target model/high observed. | Use these public calls only while idle. Assert resulting model/effort before prompt. |
| Target instructions replace rather than append | **Pass, bounded.** Public `before_agent_start` returned `TARGET_ROLE_ONLY`; provider received that exact value, with no source marker. | Use a host-owned dynamic role-environment extension; do not assign private SDK state. |
| Target tools replace, including custom source tools | **Pass, bounded.** `setActiveToolsByName(["target_tool"])`; provider saw only target and a source tool call did not execute. | Exact active-name equality is a postcondition. Registry retention is allowed, but inactive tools must not be sent or execute. |
| Pre-generation admission has known/unknown/too-large outcomes | **Pass for the primitive.** `getContextUsage()` plus model metadata produced known/too-large; a compaction entry yielded null tokens and a typed unknown error. | Host owns a conservative admission calculator; lack of metadata/estimate is a hard typed failure. |
| Same conversation can return after process/session replacement | **SDK pass; current conductor gap.** `SessionManager.open(file)` created a new SDK object with identical session ID/file/messages and restored model. Current `ProductionHost` always calls `SessionManager.create`; `resumeRun` does not retain a trajectory transport binding. | Add the durable host seam in §4.5. Do not claim conductor resume support until its test passes. |

### 0.80.6 limitations and compatibility cost

There is **no single public 0.80.6 `replaceEnvironment()` transaction**. `setModel`, `setThinkingLevel`, and `setActiveToolsByName` are separate operations; `setActiveToolsByName` silently ignores unknown names by declaration. A role-specific system prompt must be supplied by a public extension hook for the next prompt. The host therefore needs a small, explicit reconfiguration seam with prepare/commit/assert/cleanup steps. It must not reach into private session fields.

The original `AgentSession` tool registry also binds built-in tools to its construction `cwd`, and current conductor-created custom `handoff`, `end`, and `delegate` tools close over one role/session seam. Thus 0.80.6 does **not** safely support trajectory across isolated workspaces or an arbitrary per-role custom-tool implementation without a host bridge. The MVP is bounded to shared-workspace roles and conductor-owned rebindable tools. Any later peer/runtime upgrade is allowed only after this exact artifact passes against that exact installed version and the compatibility matrix is updated; 0.84.3 is not assumed compatible. The host also gates trajectory mode at runtime to exact SDK version `0.80.6`; a different version fails closed with `trajectory_environment_unsupported` rather than relying on the package's wildcard peer range.

## 1. Additive manifest contract

### 1.1 Syntax and normalized type

`handoffs` is optional. Each entry is exactly one directed policy:

```yaml
version: 1
handoffs:
  - from: senior-planner
    to: orchestrator
    mode: trajectory
  - from: orchestrator
    to: implementer
    mode: trajectory
  - from: implementer
    to: orchestrator
    mode: fresh
roles: # existing role syntax, unchanged
  # ...
```

The normalized pure manifest type is:

```ts
type HandoffMode = "fresh" | "trajectory";
interface HandoffPolicy {
  readonly from: Role;
  readonly to: Role;
  readonly mode: HandoffMode;
}
interface Manifest {
  // existing fields unchanged
  readonly handoffs?: readonly HandoffPolicy[];
}
```

`handoffs` absent means an empty immutable policy list. `handoffs` must be a YAML sequence; every entry must be a mapping with non-empty string `from`, non-empty string `to`, and `mode` exactly `fresh` or `trajectory`. Unknown entry keys are rejected by the parser rather than ignored. `mode` is required for an entry—there is no per-entry implicit mode.

The policy selector is total:

```ts
modeFor(from, to) = pinnedHandoffs.get(`${from}\u0000${to}`) ?? "fresh";
```

Therefore every undeclared edge is `fresh`, including existing manifests and manifests that declare other edges. `handoff()` keeps its current semantic schema; it receives no `mode`, conversation ID, session path, or transport override.

### 1.2 Exact static validation

Validation is pure and runs after parsing with the existing manifest checks. It adds these `ManifestErrorCode` values. The validator accumulates all applicable errors so the operator can fix a manifest in one edit.

| Condition for `handoffs[i]` | Exact error code | Rule |
| --- | --- | --- |
| `from` is not a declared role | `handoff-policy-from-undeclared` | Never infer or create roles. |
| `to` is not a declared role | `handoff-policy-to-undeclared` | Never infer or create roles. |
| `from === to` | `handoff-policy-self-edge` | Self transport is forbidden even if the role is declared. |
| Same ordered `(from,to)` occurred at an earlier index | `handoff-policy-duplicate-edge` | `fresh` does not make a duplicate harmless. |
| Both endpoints are declared but the directed pair is not legal in the pinned hub-and-spoke FSM | `handoff-policy-illegal-edge` | Legal pairs are only `orchestrator → declared worker` and `declared worker → orchestrator`; `end` is not an edge policy. |
| `mode: trajectory` has a source or target whose declared workspace backend is not `shared` (default is `shared`) | `trajectory-workspace-unsupported` | The same SDK session cannot rebind built-in tool cwd safely. |
| `mode: trajectory` source or target declares conductor delegation/progressive file bridge capability (`delegate`, `request_files`, or a delegation/progressive-disclosure block) | `trajectory-custom-tool-unsupported` | Current role-bound custom tools cannot be safely rebound without a new, separately approved bridge. |
| `mode: trajectory` target omits `models` or has an empty model list | `trajectory-target-model-unresolved` | Admission requires a concrete target `Model`; retaining the source/default model is forbidden. |
| `mode: trajectory` target omits `system_prompt` | `trajectory-target-system-prompt-unresolved` | The public replacement hook needs an explicit target instruction value; retaining the source/default prompt is forbidden. |

All table predicates are independent except `handoff-policy-illegal-edge`, which runs only when both endpoints are declared **and distinct**; e.g. `ghost → ghost` reports both undeclared endpoint errors plus self-edge, a declared self edge reports self-edge, and a declared worker → different declared worker reports illegal-edge. The last four are conservative MVP validations; `fresh` entries retain existing workspace and model behavior. Runtime target-model lookup, target effort support, active-tool availability, and admission are host preflight errors because the pure manifest must not import Pi.

### 1.3 Core boundary

`Manifest`, its parser, validator, policy lookup helper, and tests stay in `src/manifest` with zero Pi imports. `MachineDefinition` does not gain a conversation field and `reduce` does not call `modeFor`. The host receives the accepted `(from,to)` plus the run-pinned manifest snapshot and chooses transport afterward.

## 2. Pinning, persistence, and resume

### 2.1 New-run snapshot

When a new manifest declares one or more `handoffs` entries, `startRun` appends exactly one host-owned record after pure validation and before any role session is spawned. A manifest with no `handoffs` field writes no new record and retains the existing all-fresh path exactly:

```ts
interface ManifestSnapshotRecord {
  readonly type: "manifest_snapshot";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly manifest_version: string;
  readonly normalized_manifest: Manifest; // canonical parsed, immutable data
  readonly definition: MachineDefinition;
  readonly sha256: string; // canonical JSON of schema_version + manifest + definition
  readonly ts: number;
}
```

The snapshot pins roles, models, tools, workspace declarations, and `handoffs`; it is the source for every new host instance for that run. It contains parsed configuration, not arbitrary YAML text. The host keeps prompt-file loading behavior compatible with the current fresh path; a trajectory selection additionally persists its fully resolved target prompt/environment in §2.2 so resume cannot re-read changed target role instructions.

A new `resumeRun` reads and hash-validates this record before constructing a host. It derives/rechecks the stored `definition`; it does not re-load the manifest to decide a policy. The supplied manifest path remains a UX locator only for new runs and historical compatibility, not a way to change a snapshot run.

### 2.2 Selected transport is durable before target spawn

For a **trajectory** accepted nonterminal handoff, append one selector record after the reducer's accepted snapshot and source terminal lifecycle snapshot, but before target startup:

```ts
interface HandoffTransportSelectedRecord {
  readonly type: "handoff_transport_selected";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly source_role_session_id: string;
  readonly from: Role;
  readonly to: Role;
  readonly mode: "trajectory";
  readonly source_conversation: { readonly id: string; readonly file: string };
  readonly target: {
    readonly model: string;
    readonly requested_effort: ModelEffort;
    readonly system_prompt: string;
    readonly active_tool_names: readonly string[];
    readonly seed: string; // exact host-generated target user prompt used for admission and resume
    readonly environment_sha256: string;
  };
  readonly admission: TrajectoryAdmission;
  readonly ts: number;
}
```

`system_prompt` is the fully resolved prompt value passed by the role-environment controller; persisting it is intentional so a resume cannot silently pick up altered instructions. `environment_sha256` covers exactly the prompt, target model/effort, active names, and serialized active tool definitions used for admission. The persisted admission type is:

```ts
interface TrajectoryAdmission {
  readonly schema_version: 1;
  readonly observed_context_tokens: number;
  readonly role_envelope_tokens: number;
  readonly target_max_tokens: number;
  readonly safety_reservation_tokens: 8192;
  readonly required_tokens: number;
  readonly target_context_window: number;
  readonly target_model: string;
}
```

The selector record is **not** a reducer event and does not change visit counts, acceptance, or legal targets. `fresh` has no selector record at all: it calls the existing spawn/seed path, with current `formatHandoffSeed`, fresh session creation, tool exposure, context tool behavior, and model fallback behavior unchanged.

### 2.3 Historical logs

Records written before this feature have neither `manifest_snapshot` nor `handoff_transport_selected` and remain readable. They resume via the existing manifest-version check and existing fresh-session flow; their effective policy is `fresh` for every edge. A snapshot-era log with unknown record schema/hash mismatch is a typed `ManifestSnapshotError`, never a guessed current manifest. A trajectory selector without its required snapshot/environment fields is a typed `TrajectoryResumeError`, never a fresh fallback.

## 3. One host-owned transport selector

`runLoop` remains the sole owner of reduction, checkpoint persistence, lifecycle reduction, and role spawning. After it has followed the existing accepted-transition sequence through the source `session_ended` lifecycle record and its cleared checkpoint snapshot—but before it disposes the still-idle physical session or spawns a target—it calls one host method conceptually shaped as:

```ts
selectAcceptedHandoffTransport({
  accepted: { from, to, sourceRoleSession, sourceConversation },
  pinnedManifest,
  nextSeed,
}): Promise<FreshTransport | TrajectoryTransport>;
```

Only this selector reads `modeFor(from,to)`. It is called neither for rejected events nor by `handoff`/`end` tools. The reducer remains transport-agnostic.

* **Fresh / undeclared edge:** return the existing new-session spawn plan unchanged, without a new selector record. Keep the existing handoff payload seed and optional bounded `handoff_context` reference exactly as today.
* **Trajectory edge:** preflight supported workspace/custom-tool conditions, resolve the target model and complete target role environment, and perform §5 admission before the source lifecycle terminal; after that normal source terminal, append `handoff_transport_selected` and return a plan whose target role reuses the source physical conversation.

The old `spawnRole` fresh path remains the default branch—not a reimplementation behind a common abstraction. The new branch may use a narrowly additive `resumeTrajectoryRole` helper. This is the guard against accidental fresh-path behavior drift.

## 4. Lifecycle, identity, usage, and resume seam

### 4.1 Two identities

A conductor role invocation and a Pi conversation are different objects. New lifecycle records add fields without removing `session_file`:

```ts
role_session_id: string; // host-minted, unique per conductor invocation
conversation_id: string | null; // Pi sessionId; null only for legacy/synthetic records
```

`Checkpoint.active_role_session.id` and `parent_session` become `role_session_id` values for new runs. `session_file` remains the physical Pi JSONL file. A trajectory chain has separate role session IDs and `session_started/session_ended` pairs but the same non-null `conversation_id` and session file. Fresh successors have a new conversation identity/file as before. Legacy records retain their old identity semantics and remain readable.

### 4.2 Usage and observability

Every role invocation starts a new host `SessionState` and event subscription even when it reuses an SDK session. Its terminal usage is only messages received after that role invocation started; source usage is not recharged to the target. The selector and new records expose:

* `handoff_transport_selected` mode, from/to, target model/effort, environment hash, and admission inputs/result;
* `trajectory_handoff_failed` with stable typed code, message, source conversation identity, and no target lifecycle record;
* `role_session_id`, `conversation_id`, and unchanged `session_file` on new lifecycle records;
* existing per-role/per-model/run cost rollups, now keyed by role invocation deltas, not physical conversation totals.

The source still produces normal `session_ended`; the target still produces normal `session_started`. A trajectory chain must therefore display the same lifecycle boundaries as a fresh chain while revealing its shared conversation identity.

### 4.3 Environment replacement order

The host must run only while the source session is idle and sealed. For a trajectory candidate:

1. Build an uncommitted target environment from the pinned snapshot: concrete model, requested effort, fully resolved target prompt, exact active allowlist, serialized active tool definitions, and rebindable conductor tool state. Validate every named target tool is in the session registry. Run §5 admission without mutating the native session.
2. Persist source `session_ended` and its cleared checkpoint exactly as the existing accepted path requires; retain (do not yet dispose) the idle physical `AgentSession`. If preflight failed, append `trajectory_handoff_failed` now and stop.
3. Append the selected transport record only after a passed preflight.
4. Replace the host's role binding for `handoff`, `end`, and `ask_user`; install a fresh capture buffer and a fresh event/usage subscription. The machine tools are stable host bridges whose execution delegates to the current binding, not source-role closures.
5. `await session.setModel(targetModel)`, call `session.setThinkingLevel(targetEffort)`, and assert the effective model and effort equal the target plan. Then call `session.setActiveToolsByName(targetAllowlist)` and assert `getActiveToolNames()` equals the allowlist exactly (including no source custom tool). The trajectory target allowlist is target-declared tools plus the three conductor tools; unlike the unchanged fresh path, it does not add the predecessor-only `handoff_context` tool.
6. Arm the role-environment controller, installed when the shared session was created, to return the persisted target system prompt from public `before_agent_start`; only then emit target `session_started` and call the target `prompt`.

The controller must replace the prompt value, not concatenate it. The spike's provider observed exact target instructions; it did not inspect a declaration alone. A trajectory receiver runs only `models[0]`: it does not use the existing same-model retry or fresh-session fallback machinery, because either can change the exact continuation semantics. A target model error is an ordinary typed `session_failed("model_error")` with no fallback; a later design may add an empirically proven same-conversation retry policy.

If any step through 5 fails, no target prompt or compaction may occur. Detach the tentative target subscription, invalidate its capture binding, dispose the idle SDK object only after its persisted JSONL remains available, append `trajectory_handoff_failed`, and return a typed `TrajectoryHandoffError` / `session_failed` outcome. Do not spawn a fresh target, append a summary, truncate, compact, or retry with another model. A selector record followed by no target start resumes to the same typed failure rather than attempting a new transport.

### 4.4 Workspace and custom-tool boundary

Trajectory is rejected for `worktree`, `copy`, and `container` on either endpoint because 0.80.6's active built-in tools retain construction cwd. It is also rejected for current delegate/request-files bridges and any role-specific custom tool that has no approved rebindable bridge. Source custom tools may remain in Pi's internal registry, but after the exact allowlist assertion they are not model-visible or executable; the spike intentionally attempted one to prove this.

### 4.5 Minimal durable conductor resume seam

The SDK can reopen a durable JSONL conversation. Current conductor cannot select it on resume because `src/host/shared-sdk-role-spawn.ts` always constructs `SessionManager.create(...)`, the log has no transport record, and `src/host/api.ts` resume only reconstructs a fresh handoff reference. This matches the current session/host/resume tests (`tests/host/role-session.test.ts`, `tests/host/production-host-spawn.test.ts`, and `tests/host/resume.test.ts`), which exercise fresh role sessions and fresh crash recovery rather than a shared conversation. The minimum durable seam is:

1. extend the persisted union/materializer with `manifest_snapshot`, `handoff_transport_selected`, and `trajectory_handoff_failed`;
2. let `resumeRun` obtain the latest selector targeting the current checkpoint role before it constructs `ProductionHost`;
3. add a trajectory-specific host spawn that calls `SessionManager.open(selected.source_conversation.file, sessionDir, cwd)`, rehydrates the target environment from the persisted record, and uses the same lifecycle/reconfiguration path; and
4. restore fresh behavior when no trajectory selector is present.

A resume between the accepted receiver checkpoint and selector durability has no stored exact target seed/environment, so it is **not** a fresh case. If the current checkpoint was reached by a pinned `mode: trajectory` accepted edge and the log has neither its valid matching selector nor a durable `trajectory_handoff_failed`, resume appends exactly one `trajectory_handoff_failed(trajectory_transport_unrecoverable)` using the durable source conversation identity and fails before host construction, session opening, compaction, or prompting. This covers both crashes before and after source `session_ended`; a later resume observes that failure and neither reopens nor duplicates it.

This is smaller and safer than putting Pi conversation data in `Checkpoint`, teaching the reducer transport, or relying on Pi's session tree as conductor persistence. Target-seed delivery is additionally fail-closed: the loop records `trajectory_target_seed_delivered` after a target prompt completes. On a crash-recovery reopen, if the exact selected seed is already in the active Pi conversation before an accepted target transition is durable, the host records `trajectory_handoff_failed(trajectory_target_seed_ambiguous)` and refuses to prompt again. This avoids a duplicate user seed or unobservable second generation; a selected target with no seed present can still be resumed normally.

## 5. Context admission contract

### 5.1 Inputs and calculation

Before any target generation, the trajectory selector must obtain all of the following through public/documented APIs or host-owned data:

1. a resolved target `Model` with finite positive `contextWindow` and finite non-negative `maxTokens`;
2. `sourceSession.getContextUsage()` with non-null `tokens` while the source active branch is un-compacted; roles with any outgoing trajectory policy start with automatic compaction disabled, and the selector still scans the branch for a manual/legacy compaction entry;
3. the target seed text; and
4. the exact target system prompt plus canonical serialized active tool definitions.

The production calculation is:

```text
trajectoryTokens = sourceSession.getContextUsage().tokens
roleEnvelopeTokens = estimateTokens(userMessage(targetPrompt + toolDefinitions + targetSeed))
requiredTokens = trajectoryTokens + roleEnvelopeTokens + targetModel.maxTokens + 8192
admit iff requiredTokens <= targetModel.contextWindow
```

`estimateTokens` is a public 0.80.6 export whose local declaration identifies its chars/4 estimate as conservative (`dist/core/compaction/compaction.d.ts`, lines 46–59). The fixed 8,192-token host safety reservation is deliberately pessimistic for provider framing and tokenizer variance. The persisted `TrajectoryAdmission` includes each input, the safety reservation, `requiredTokens`, target window, and the target model ID. The admission formula is versioned with `schema_version: 1`; changing it requires a new selector schema, not reinterpretation of old runs.

### 5.2 Typed failures and invariants

Admission returns exactly one failure in this precedence order: invalid/unavailable target metadata or effort; detected compaction; unknown Pi context estimate; then arithmetic overflow. This makes an already-compacted unknown session consistently report `trajectory_history_compacted`, not whichever secondary condition happens to be checked first.

| Failure | Typed code | Required outcome |
| --- | --- | --- |
| Target model missing/non-finite metadata, unavailable, or unsupported exact effort | `trajectory_context_metadata_unknown` / `trajectory_target_environment_invalid` | No target generation; terminal host failure. |
| `getContextUsage()` is undefined or `tokens === null` | `trajectory_context_unknown` | No target generation; terminal host failure. |
| Any compaction entry exists on the active source branch | `trajectory_history_compacted` | No target generation; full trajectory is already unavailable. |
| Calculated requirement exceeds target window | `trajectory_context_too_large` | No target generation; terminal host failure. |
| Source/target workspace or custom tool cannot be rebound | `trajectory_environment_unsupported` | No target generation; terminal host failure. |

Invariant: trajectory code never calls `compact`, never enables auto-compaction for that role invocation, never removes/summarizes messages, never truncates context, and never falls back to `fresh`. A failure must be visible in the run log and stats. The only way to get fresh behavior is an explicitly fresh/undeclared edge in the pinned manifest.

## 6. Test-first implementation slices and ownership

| Order | Test first | Implementation ownership | Acceptance |
| --- | --- | --- | --- |
| 1 | `tests/manifest/issue-63.test.ts`: absent policy/default fresh; explicit modes; malformed syntax; undeclared from/to; duplicate; self; illegal hub edge; workspace/custom/model restrictions | `src/manifest/types.ts`, `parse.ts`, `validate.ts`; no Pi imports | Table-driven validation produces exact codes and existing manifests still parse identically. |
| 2 | `tests/persistence/trajectory-records.test.ts`: materialization, canonical snapshot hash, legacy log acceptance, corrupt snapshot rejection | `src/persistence/log.ts`, `record-materialization.ts`, new record helper | New records append/read; legacy records have fresh-only interpretation. |
| 3 | `tests/host/trajectory-selector.test.ts`: reducer accepted first; one selector per accepted handoff; ordinary/undeclared fresh calls the existing spawn/seed path byte-for-byte | `src/host/host.ts`, `loop.ts`, `api.ts` | Reducer remains transport-blind and fresh parity stays green. |
| 4 | `tests/host/trajectory-environment.test.ts`: real stub provider proves source tool result visible after model swap; exact target prompt; exact target active tools; attempted stale custom tool cannot execute; role usage delta; target model error has no fresh fallback | new `src/host/trajectory-session.ts`, narrow adapter changes in `role-session.ts` / `shared-sdk-role-spawn.ts` | Only public 0.80.6 APIs and rebindable host tools are used. |
| 5 | `tests/host/trajectory-admission.test.ts`: pass, null estimate, invalid metadata, compacted history, too-large; each has one code and zero target prompts/compactions/fresh fallbacks | `src/host/trajectory-admission.ts`, `errors.ts` | Table-driven conservative admission and cleanup invariants hold. |
| 6 | `tests/host/trajectory-resume.test.ts`: crash after selector-before-start and after target start; same session ID/file/trajectory after reopen; historical fresh resume unchanged | `src/host/api.ts`, `production-host.ts`, `log-file.ts` | Durable selector restores same conversation deterministically or returns persisted typed failure. |
| 7 | Existing host/manifest/resume suites plus new E2E planner → orchestrator → implementer chain with two trajectory edges and later fresh edge | only integration wiring required by prior slices | Separate role lifecycle records, shared conversation only over selected edges, fresh later edge starts a new file. |

Do not edit `src/core` for transport. Do not add a Pi import to `src/manifest`, `src/persistence`, `src/seam`, or `src/cost`. No README/package/conductor-config change belongs to this issue unless separately approved.

## 7. Verification, rollout, and rollback

### Required verification

```bash
node --max-old-space-size=1024 docs/issue-63-trajectory-handoffs/sdk-feasibility-spike.mjs
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm audit
```

The implementation gate also includes the full host/session/manifest/resume test suites named in §6, a grep-guard pass, and a manual no-key stub E2E that verifies no automatic compaction/fresh fallback on each admission failure. Re-run the spike whenever the resolved `@earendil-works/pi-coding-agent` version changes; record the CLI/runtime versions separately.

### Rollout

1. Ship the parser and snapshot records with no `handoffs` entries in shipped/default manifests: behavior remains fresh.
2. Enable only a shared-workspace, explicit-model planner → orchestrator edge in a controlled run; observe selector records, admission failures, per-role cost delta, and shared `conversation_id`.
3. Enable the second orchestrator → implementer edge only after step 2 proves exact tool/result preservation.
4. Compare Issue #63’s stated experiment cohorts: fresh versus exactly the two selected trajectory edges. Track completion/pass rate, target exploration/tool calls, wall time, prefill/input tokens, admission failures, context growth, and total cost.

### Rollback

Remove or change selected manifest entries to `mode: fresh` and start a new run. In-flight runs retain their snapshot and are never reinterpreted. If a runtime defect appears, disable trajectory admission at the host feature gate so new trajectory selections fail with `trajectory_environment_unsupported`; never silently route those runs fresh. Existing fresh runs require no migration.

## Fixed decisions

* The syntax is `handoffs: [{ from, to, mode }]`; absent edges are fresh.
* Only declared legal hub-and-spoke edges may be configured; duplicate, undeclared, illegal, and self edges are hard validation errors.
* Transport is selected once, host-side, only after an accepted reduction. The reducer does not know Pi conversations.
* A durable normalized manifest snapshot plus a per-handoff selector/environment record pins policy and supports resume; legacy logs remain fresh-only.
* MVP trajectory is shared-workspace, explicit-target-model, explicit-target-system-prompt, no delegated/progressive custom bridge only.
* Role invocations are distinct from Pi conversations. Lifecycle/usage records use separate logical role-session and physical conversation identities.
* Admission is conservative and fail-closed. There is no compaction, truncation, summary substitution, or fresh fallback.

## Acknowledgement record

| Acknowledged by | Date | Notes |
| --- | --- | --- |
| Overseer | 2026-08-28 | Explicit ACK received for the quoted acknowledgement request; implementation authorized. |

**Acknowledgement requested:** “I acknowledge this Issue #63 contract: per-edge `handoffs` defaults to fresh; the 0.80.6 MVP is shared-workspace and explicit-model only; trajectory admission is fail-closed with no compaction/truncation/fresh fallback; and implementation may proceed only through the pinned-snapshot, host-owned selector and durable resume seam described above.”
