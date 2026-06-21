/**
 * `ProductionHost` — Phase 7A production `Host` (Tasks 7A.1–7A.4).
 *
 * Production `Host` implementation that resolves the normalized
 * `role.models[modelIndex]` entry (`model` + `effort`) against a real
 * `ModelRegistry`, loads `role.system_prompt` from disk, wires
 * a real `DefaultResourceLoader` + file-backed `SessionManager`
 * for each role session, and matches `StubHost`'s event-handling
 * semantics (usage capture, terminal reason, model fallback,
 * visit index, abort, seal, persistence, run-memory seeding).
 *
 * **Status (Phase 7A):** 7A.1 — constructor + `Host` interface
 * conformance + three boundary errors. 7A.2 — pure resolution
 * pieces (`selectModelEntry`, `resolveModel`, `loadSystemPrompt`).
 * 7A.3 — `DefaultResourceLoader` + `SessionManager` wiring +
 * `buildToolsAllowlist`. 7A.4 — full `Host` method parity with
 * `StubHost` (every method now implemented; the event-handler
 * logic is shared via `session-event-handler.ts`).
 *
 * **Module size.** This file is ~455 LOC, over the AGENTS.md
 * ~400-LOC soft ceiling. The size is justified by the
 * comprehensive JSDoc on every `Host` method (each method has a
 * spec-section pointer + 5–15 lines of intent documentation, per
 * the repo's code conventions) and the fact that splitting the
 * class would break the single `class ProductionHost implements
 * Host` declaration the loop imports. The class stays under the
 * 500-LOC hard cap that AGENTS.md allows for "coherent concept"
 * files. The pure resolution pieces were already extracted to
 * `production-host-resolve.ts` (Tasks 7A.2, 7A.3).
 *
 * **Host-agnosticism:** this module imports from
 * `@earendil-works/pi-coding-agent` (it's in `src/host/` — the
 * grep-guard test allows pi imports here). The pure core
 * (`src/core`, `src/manifest`, `src/seam`, `src/cost`) is
 * untouched and remains host-agnostic.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  type ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { RunMemory } from "../core/run-memory.js";
import { buildRunMemory } from "../core/run-memory.js";
import type {
  Checkpoint,
  MachineDefinition,
  ModelEffort,
  Role,
  UsageRecord,
} from "../core/types.js";
import { DEFAULT_MODEL_EFFORT } from "../core/types.js";
import type { ModelConfig, RoleConfig } from "../manifest/types.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import { createAskUserTool } from "./ask-user-tool.js";
import { SessionState } from "./cost.js";
import type { DisplaySink } from "./display-sink.js";
import { NoMoreModelsError, RoleEscalationError } from "./errors.js";
import type { Host, RoleSession, SessionTerminalReason, SpawnRoleOptions } from "./host.js";
import type { LoadedManifest } from "./manifest.js";
import {
  buildToolsAllowlist,
  loadSystemPrompt,
  resolveModel,
  selectModelEntry,
} from "./production-host-resolve.js";
import { SessionSeam } from "./seam.js";
import { attachSessionEventHandler, createCaptureRejector } from "./session-event-handler.js";
import { createEndTool, createHandoffTool } from "./tools.js";

/**
 * Constructor options for `ProductionHost`. Mirrors the production
 * context the orchestration loop needs to pass through: the
 * `ModelRegistry` (typically the extension's
 * `ExtensionCommandContext.modelRegistry`, shared with pi's
 * configured providers), the working directory (typically
 * `ctx.cwd`), and the run-scoped state (`log`, `loadedManifest`,
 * `runId`) the loop already gives `StubHost`.
 */
export interface ProductionHostOptions {
  /** Real `ModelRegistry` from the host's environment (extension
   *  `ExtensionCommandContext.modelRegistry` or
   *  `ModelRegistry.create(authStorage, modelsPath)` in standalone). */
  readonly modelRegistry: ModelRegistry;
  /** Working directory for prompt-path resolution and session cwd. */
  readonly cwd: string;
  /** Optional extension UI handle threaded into role sessions. */
  readonly uiContext?: ExtensionUIContext;
  /** Optional display sink for streamed role output. */
  readonly displaySink?: DisplaySink;
  /** Host-owned `run_id`-keyed append-only log (Task 13.5). */
  readonly log: RecordLog;
  /** Pinned manifest snapshot (def + role configs + warnings). */
  readonly loadedManifest: LoadedManifest;
  /** The run this host is bound to. */
  readonly runId: string;
  /**
   * Optional: directory for SDK `SessionManager` files. The plan
   * calls for the file-backed `SessionManager` to be "rooted under
   * the conductor run log directory" — i.e., NOT in pi's own
   * session tree (~/.pi/agent/sessions/<encoded-cwd>/). Default:
   * `<cwd>/.pi-conductor/runs/<runId>/sessions`. Created on
   * construction (`mkdirSync({ recursive: true })`).
   */
  readonly sessionDir?: string;
  /**
   * Optional: directory for the SDK's `DefaultResourceLoader` agent
   * config (auth.json, models.json, extensions, etc.). Default:
   * `<cwd>/.pi-conductor/agent`. The extension is expected to
   * share its own `~/.pi/agent` by passing the path here, so
   * spawned role sessions see the user's pi configuration. The
   * default keeps the conductor's role sessions isolated from pi.
   */
  readonly agentDir?: string;
}

/**
 * Production `Host` — `Phase 7A` scaffold + role-session spawn
 * (Tasks 7A.1, 7A.2, 7A.3).
 *
 * `implements Host` enforces compile-time conformance to the
 * seam the loop programs against. Adding/removing/renaming a
 * `Host` method in `host.ts` will fail typecheck here, which
 * is the right shape for a scaffold: any drift between the
 * seam and the implementation is caught at the boundary, not
 * at runtime.
 */
export class ProductionHost implements Host {
  // ─── Stored production context ────────────────────────────────────
  /** See {@link ProductionHostOptions.modelRegistry}. */
  readonly modelRegistry: ModelRegistry;
  /** See {@link ProductionHostOptions.cwd}. */
  readonly cwd: string;
  /** See {@link ProductionHostOptions.log}. */
  readonly log: RecordLog;
  /** See {@link ProductionHostOptions.loadedManifest}. */
  readonly loadedManifest: LoadedManifest;
  /** See {@link ProductionHostOptions.runId}. */
  readonly runId: string;
  /** See {@link ProductionHostOptions.uiContext}. */
  readonly uiContext: ExtensionUIContext | undefined;
  /** See {@link ProductionHostOptions.displaySink}. */
  readonly displaySink: DisplaySink | undefined;
  /** See {@link ProductionHostOptions.sessionDir}. */
  readonly sessionDir: string;
  /** See {@link ProductionHostOptions.agentDir}. */
  readonly agentDir: string;

  constructor(opts: ProductionHostOptions) {
    this.modelRegistry = opts.modelRegistry;
    this.cwd = opts.cwd;
    this.log = opts.log;
    this.loadedManifest = opts.loadedManifest;
    this.runId = opts.runId;
    this.uiContext = opts.uiContext;
    this.displaySink = opts.displaySink;
    this.sessionDir =
      opts.sessionDir ?? join(opts.cwd, ".pi-conductor", "runs", opts.runId, "sessions");
    this.agentDir = opts.agentDir ?? join(opts.cwd, ".pi-conductor", "agent");
    // The SessionManager writes JSONL files directly into `sessionDir`
    // without creating parent directories. Ensure the dir exists so
    // the first `SessionManager.create(cwd, this.sessionDir)` call
    // in `spawnRole` doesn't ENOENT.
    mkdirSync(this.sessionDir, { recursive: true });
  }

  // ─── Per-session state (Task 17 / 7A.4) ────────────────────────
  // The host tracks the `SessionState` + the live `AgentSession`
  // for each spawned role so the `Host` methods (`captureUsage`,
  // `sessionTerminalReason`, `dispose`) can read the per-session
  // cap/usage/terminal-reason state and clean up on dispose.
  // Mirrors `StubHost.sessionStates` / `agentsBySessionId`.
  private readonly sessionStates: Map<string, SessionState> = new Map();
  private readonly agentsBySessionId: Map<string, AgentSession> = new Map();

  /**
   * Tracks the most-recent role that exhausted its model fallback
   * (Task 18, §9.4 v1 default). The next `spawnRole` for this
   * role throws `RoleEscalationError`; a `spawnRole` for any
   * other role clears the marker (so a different re-dispatch
   * doesn't trip the guard, only the same-role re-dispatch
   * does). Identical semantics to `StubHost.unavailableRole` —
   * kept as per-class state rather than extracted (the 15-line
   * policy doesn't cross a "real duplication" threshold).
   */
  private unavailableRole: Role | null = null;

  // ─── Host methods ──────────────────────────────────────────────────
  // `spawnRole` is wired (7A.3). The remaining methods throw a
  // phase-tagged "not yet implemented" error so 7A.4 fills them
  // in (one task at a time, per the plan's slice structure).

  async spawnRole(role: Role, opts: SpawnRoleOptions = {}): Promise<RoleSession> {
    // ── Task 18: model-fallback policy (parity with StubHost) ──
    // §9.4 v1 default: hand to orchestrator once, then escalate.
    // The "unavailable" marker is set when the role's models were
    // just exhausted; the next spawnRole for the same role
    // surfaces as a typed error. Different-role spawns clear the
    // marker (unless the different role is the orchestrator and
    // the unavailable role was a non-orchestrator, in which case
    // the marker persists so a same-role re-dispatch escalates).
    if (this.unavailableRole === role) {
      this.unavailableRole = null; // consume the escalation
      throw new RoleEscalationError(role);
    }
    if (this.unavailableRole !== null && this.unavailableRole !== role) {
      const orchestrator = this.loadedManifest.def.orchestrator;
      if (role !== orchestrator) {
        this.unavailableRole = null;
      }
    }

    const roleConfig = this.lookupRoleConfig(role);
    const modelIndex = opts.modelIndex ?? 0;

    // ── Task 18: resolve the model from the role's models[] list.
    // The "logical" model is the `provider:id` string the
    // lifecycle record will carry; the SDK model is resolved via
    // `resolveModel` against `this.modelRegistry`. On a registry
    // miss (`NoMoreModelsError` for out-of-range index), the role
    // is marked unavailable so the next re-dispatch escalates
    // (§9.4 v1 default).
    let entry: ModelConfig | null = null;
    try {
      entry = selectModelEntry(role, roleConfig, modelIndex);
    } catch (e) {
      if (e instanceof NoMoreModelsError) {
        this.unavailableRole = role;
      }
      throw e;
    }
    let model: Model<never> | undefined;
    let logical: string | null = null;
    const effort: ModelEffort = entry?.effort ?? DEFAULT_MODEL_EFFORT;
    if (entry !== null) {
      const resolved = resolveModel(role, entry.model, this.modelRegistry);
      model = resolved.model;
      logical = resolved.logical;
    }

    // 2. Load the role's system prompt. `loadSystemPrompt` returns
    //    null when the role has no `system_prompt` field; the
    //    `systemPromptOverride` then leaves the SDK default in
    //    place.
    //
    //    Phase 7D: thread the manifest's directory + version
    //    through so the §8.1 prompt resolver can pick the right
    //    resolution root. v1 (existing manifests) keeps
    //    cwd-relative resolution; v2 (HOME-sourced and
    //    self-contained manifests) resolves against
    //    `manifestDir`. Both fields ride on `LoadedManifest` —
    //    added in Task 7D.2, populated by `loadManifest` /
    //    `loadManifestFromString`.
    const rolePrompt = await loadSystemPrompt(
      role,
      roleConfig?.system_prompt,
      this.cwd,
      this.loadedManifest.manifestDir,
      this.loadedManifest.manifestVersion,
    );

    // 3. Build the `DefaultResourceLoader` with the role's prompt
    //    wired via `systemPromptOverride`. The override is a closure
    //    over `rolePrompt` so a single loader instance re-evaluates
    //    the same string each time the SDK calls
    //    `loader.getSystemPrompt()`. `await loader.reload()` is
    //    required by the SDK before the session uses the loader.
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      systemPromptOverride: () => rolePrompt ?? undefined,
    });
    await loader.reload();

    // 4. Build the tools allowlist. The `tools` option on
    //    `createAgentSession` is the SDK's allowlist — forgetting
    //    to name `handoff` / `end` here silently disables them
    //    even when they're in `customTools` (sdk-surface.md §1).
    //    `buildToolsAllowlist` dedups so a role that already names
    //    them in `role.tools` still gets them exactly once.
    const roleTools = roleConfig?.tools;
    const tools = buildToolsAllowlist(roleTools);

    // 5. Build the file-backed `SessionManager` rooted under the
    //    conductor's per-run directory (NOT pi's own session tree).
    //    `SessionManager.create(cwd, sessionDir)` puts each session's
    //    JSONL file directly in `sessionDir`. The constructor
    //    `mkdirSync`'d `sessionDir` already, so this never ENOENTs.
    const sessionManager = SessionManager.create(this.cwd, this.sessionDir);

    // 6. Build the per-session seam + the handoff/end tools. The
    //    seam's capture buffer is the loop's read surface (§12.1);
    //    the tools write to it on call. `ask_user` is the
    //    non-terminating UI tool and does not touch the seam. The
    //    `rejector` predicate is bound to the `SessionState` after
    //    construction (the state needs the `sessionId`).
    const seam = new SessionSeam();
    const rejector = createCaptureRejector();
    const handoff = createHandoffTool(seam, rejector.shouldRejectCapture);
    const end = createEndTool(seam, rejector.shouldRejectCapture);
    const askUser = createAskUserTool() as ToolDefinition;

    // 7. Spawn the real `AgentSession` via the SDK. `model` is
    //    `undefined` for the system-model path; the SDK uses its
    //    default in that case (no `model` override).
    const createOpts: Parameters<typeof createAgentSession>[0] = {
      cwd: this.cwd,
      modelRegistry: this.modelRegistry,
      resourceLoader: loader,
      sessionManager,
      customTools: [handoff, end, askUser],
      tools: [...tools],
    };
    if (model !== undefined) {
      // The SDK's `model` is `Model<any>`; `resolveModel` returns
      // `Model<never>` (any-Api escape, see the function's
      // comment). Cast at the boundary; the SDK handles any-Api
      // models via its discriminated `api` field.
      (createOpts as { model?: Model<never> }).model = model;
    }
    (createOpts as { thinkingLevel?: ModelEffort }).thinkingLevel = effort;
    const { session } = await createAgentSession(createOpts);
    if (this.uiContext !== undefined) {
      await session.bindExtensions({ uiContext: this.uiContext });
    }

    // 8. Track per-session state (Task 17 / 7A.4). The host's
    //    `captureUsage` and `sessionTerminalReason` read from
    //    this; `dispose` cleans up the maps.
    const cap = roleConfig?.max_session_cost_usd ?? null;
    const state = new SessionState({ cap, model: logical });
    this.sessionStates.set(session.sessionId, state);
    this.agentsBySessionId.set(session.sessionId, session);
    rejector.bindState(state);

    // 9. Subscribe the session to the shared event handler
    //    (Task 17 + 18). The handler accumulates usage, detects
    //    model errors, and enforces the per-session cost cap.
    attachSessionEventHandler({
      session,
      state,
      role,
      ...(this.displaySink !== undefined && { onDisplay: this.displaySink }),
    });

    // 10. Wrap the SDK session in the loop's `RoleSession` seam.
    //     The wrapper explicitly forwards the SDK methods the loop
    //     uses (`subscribe`, `prompt`, `dispose`) — the SDK's
    //     `AgentSession` has these on the prototype, so a spread
    //     would miss them. Two SDK fields are also exposed as
    //     extra properties: `systemPrompt` (a getter) and
    //     `getActiveToolNames` (a method). These are NOT part of
    //     the `RoleSession` interface — the loop doesn't read them
    //     — but the wiring tests do (via a typed cast).
    const sessionId = session.sessionId;
    const wrapper = {
      role,
      sessionId,
      sessionFile: session.sessionFile ?? `${this.sessionDir}/${sessionId}.jsonl`,
      model: logical,
      effort,
      readCaptureBuffer: () => seam.read(),
      resetCaptureBuffer: () => seam.reset(),
      subscribe: (listener: (event: AgentSessionEvent) => void) => session.subscribe(listener),
      prompt: (text: string) => session.prompt(text),
      dispose: async () => {
        session.dispose();
        this.sessionStates.delete(sessionId);
        this.agentsBySessionId.delete(sessionId);
      },
      // Test-introspection escape hatches. The loop never reads
      // these; the wiring tests cast through `unknown` to verify
      // the resource loader + tools allowlist are wired correctly.
      get systemPrompt(): string {
        return session.systemPrompt;
      },
      getActiveToolNames: () => session.getActiveToolNames(),
    };
    return wrapper as unknown as RoleSession;
  }

  /**
   * Look up the role's `RoleConfig` from the loaded manifest.
   * Returns `undefined` for an undeclared role (which the loop
   * shouldn't ask for; surfaced as a "use system model" fallback
   * downstream, matching `StubHost`'s tolerance). Internal helper.
   */
  private lookupRoleConfig(role: Role): RoleConfig | undefined {
    return this.loadedManifest.manifest.roles.find((r) => r.name === role);
  }

  captureUsage(session: RoleSession): UsageRecord {
    // Read the session's cumulative §11.4 normalized usage from
    // the per-session `SessionState`. Returns zeros for a session
    // with no state (e.g., never registered, or already disposed).
    const state = this.sessionStates.get(session.sessionId);
    return (
      state?.usage() ?? { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 }
    );
  }

  sessionTerminalReason(session: RoleSession): SessionTerminalReason {
    // Read the host-set terminal reason (cap exceeded, model
    // error, or null if the session ended normally). The loop
    // uses this to set `session_failed.failure_reason`.
    const state = this.sessionStates.get(session.sessionId);
    return state?.terminalReason ?? null;
  }

  persistRecord(record: PersistedRecord): void {
    // Append-only: the host is the sole writer (the loop calls
    // this exactly once per reduce / reduceLifecycle result,
    // plus once per checkpoint snapshot).
    this.log.append(record);
  }

  seedRunMemory(args: {
    readonly checkpoint: Checkpoint;
    readonly def: MachineDefinition;
    readonly goal: string;
    readonly runCostCap: number | null;
  }): RunMemory {
    // Delegate to the core's `buildRunMemory` so the
    // orchestrator's seed reflects the actual persisted record
    // history (visit_history, per_role_cost, next_candidates).
    // The host owns its log; this is the canonical seam for
    // the loop's orchestrator-seed injection (Task 16.5, §8.4
    // single-writer rule).
    const records = this.log.records(this.runId);
    return buildRunMemory(args.checkpoint, records, args.def, {
      goal: args.goal,
      runCostCap: args.runCostCap,
    });
  }

  nextVisitIndex(role: Role): number {
    // Count terminals (session_ended + session_failed) for the
    // role. A model retry (Task 18) is the SAME visit with a
    // different model — the role didn't transition, it re-ran.
    // Counting session_started would inflate visit_index on
    // every model retry within the same visit. The visit ends
    // when the role transitions away or is abandoned.
    return (
      this.log
        .records(this.runId)
        .filter(
          (r) => (r.type === "session_ended" || r.type === "session_failed") && r.role === role,
        ).length + 1
    );
  }

  getNextModel(role: Role, currentModelIndex: number): string | null {
    // Read the role's `models[]` list and return the entry at
    // `currentModelIndex + 1`, or `null` if exhausted (or the
    // role has no `models` field). The loop uses this to
    // populate the `model_fallback` record's `to_model` field.
    const roleConfig = this.lookupRoleConfig(role);
    if (roleConfig?.models === undefined) return null;
    const next = roleConfig.models[currentModelIndex + 1];
    return next?.model ?? null;
  }

  runCostSoFar(): number {
    // Sum `usage.cost` across all session_ended + session_failed
    // records in the run. Both terminals cost (§11.4). The
    // loop adds the current terminal's usage on top of this
    // when evaluating the cap (§11.7: "persisted roll-up plus
    // the current terminal's captured usage before reducing
    // the role's captured machine event").
    let total = 0;
    for (const r of this.log.records(this.runId)) {
      if ((r.type === "session_ended" || r.type === "session_failed") && r.usage) {
        total += r.usage.cost;
      }
    }
    return total;
  }

  async abortSession(session: RoleSession, _reason: string): Promise<void> {
    const state = this.sessionStates.get(session.sessionId);
    const agent = this.agentsBySessionId.get(session.sessionId);
    if (state === undefined || agent === undefined) return;
    if (state.terminalReason !== null) return;
    state.markAborted();
    state.setTerminalReason("user_aborted");
    await agent.abort();
  }

  sealSession(_session: RoleSession): void {
    // No-op: sealing is owned by the handoff/end tool wrapper
    // (Task 15.5) flipping `SessionSeam.isSealed`. This method
    // is reserved for external consumers.
  }
}
