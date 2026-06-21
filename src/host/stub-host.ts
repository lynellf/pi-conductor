/**
 * StubHost — minimal real `Host` that drives `createAgentSession`
 * via the stub provider (Tasks 16, 17, 18).
 *
 * Implements the `Host` interface with the methods the loop
 * actually calls:
 *  - `spawnRole` — fresh `createAgentSession` per role visit
 *    (Task 15's canonical model). Per the §11.4 SDK mapping
 *    the host subscribes to the session's events and accumulates
 *    `Usage` from assistant `message_end` events (Task 17).
 *  - `captureUsage` — returns the session's cumulative §11.4
 *    normalized usage (Task 17).
 *  - `sessionTerminalReason` — returns the host's reason for
 *    abnormal session terminations (Task 17: cap; Task 18: model
 *    error).
 *  - `persistRecord` — appends to the run log.
 *  - `nextVisitIndex` — 1-based, counts `session_started` records
 *    per role.
 *  - `seedRunMemory` — delegates to `buildRunMemory` (Task 16.5).
 *  - `runCostSoFar` — sums terminal session costs from the log
 *    (Task 17).
 *  - `abortSession` / `sealSession` — no-ops (the seal wrapper
 *    lives at the tool layer in Task 15.5; the cap abort happens
 *    inside the session-event subscription below).
 *
 * **Per-session state** (Task 17): one `SessionState` per spawned
 * session, keyed by `sessionId`. The host's event subscription
 * writes to it; `captureUsage` and `sessionTerminalReason` read
 * from it.
 *
 * **Model fallback** (Task 18, §8.2): the host resolves the model
 * for a given `modelIndex` from the role's `models[]` list. The
 * loop passes the index; the host throws `NoMoreModelsError` on
 * exhaustion and tracks the unavailable role for the §9.4
 * re-dispatch escalation.
 */

import type { Usage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildRunMemory } from "../core/run-memory.js";
import type {
  Checkpoint,
  Host,
  MachineDefinition,
  PersistedRecord,
  RecordLog,
  Role,
  RoleSession,
  RunMemory,
  UsageRecord,
} from "../index.js";
import { SessionState } from "./cost.js";
import { NoMoreModelsError, RoleEscalationError } from "./errors.js";
import type { SessionTerminalReason } from "./host.js";
import { createEndTool, createHandoffTool, SessionSeam } from "./index.js";
import type { LoadedManifest } from "./manifest.js";
import { attachSessionEventHandler, createCaptureRejector } from "./session-event-handler.js";
import { makeStubModel, makeStubStreamFunction, type StubStep } from "./stub-provider.js";

export interface StubHostOptions {
  readonly runId: string;
  /** Record log (in-memory for fast tests; file-backed via Task 13.5's FileRecordLog for resume tests). */
  readonly log: RecordLog;
  readonly steps: readonly StubStep[];
  readonly usage?: Partial<Usage>;
  /**
   * The loaded manifest. The host reads the role config (`models[]`,
   * `max_session_cost_usd`) to resolve fallback chains and per-
   * session caps. Optional for backward compat with the Phase 4
   * tests that don't exercise Task 17/18 behavior; when omitted,
   * the host treats every role as uncapped with a single null
   * model and never throws `NoMoreModelsError`.
   */
  readonly loadedManifest?: LoadedManifest;
}

/**
 * Minimal real `Host` that wires `createAgentSession` to the stub
 * provider.
 */
export class StubHost implements Host {
  readonly log: StubHostOptions["log"];
  private readonly modelRegistry: ModelRegistry;
  private readonly sessionManager: SessionManager;
  private readonly model = makeStubModel();
  private readonly sessionStates = new Map<string, SessionState>();
  private readonly agentsBySessionId = new Map<string, AgentSession>();
  private stubSessionCounter = 0;
  private readonly runId: string;
  private readonly loadedManifestValue: LoadedManifest | undefined;
  /**
   * Tracks the most-recent role that exhausted its model fallback
   * (Task 18, §9.4 v1 default). The next `spawnRole` for this role
   * throws `RoleEscalationError`; `spawnRole` for any other role
   * clears the marker (so a different re-dispatch doesn't trip the
   * guard, only the same-role re-dispatch does).
   */
  private unavailableRole: Role | null = null;

  constructor(opts: StubHostOptions) {
    this.log = opts.log;
    this.runId = opts.runId;
    this.loadedManifestValue = opts.loadedManifest;

    const authStorage = AuthStorage.inMemory();
    this.modelRegistry = ModelRegistry.inMemory(authStorage);
    const streamFn = makeStubStreamFunction({
      steps: opts.steps,
      ...(opts.usage !== undefined && { usage: opts.usage }),
    });
    this.modelRegistry.registerProvider("stub", {
      api: "anthropic-messages" as const,
      apiKey: "stub-dummy-key-not-used",
      streamSimple: streamFn,
    });
    this.sessionManager = SessionManager.inMemory();
  }

  async spawnRole(role: Role, opts: { modelIndex?: number } = {}): Promise<RoleSession> {
    // ── Task 18: model-fallback policy ─────────────────────────
    // §9.4 v1 default: hand to orchestrator once, then escalate.
    // The "unavailable" marker is set when the role's models were
    // just exhausted; the next spawnRole for the same role
    // surfaces as a typed error.
    //
    // Marker lifecycle:
    //   - Set: list exhausted for `role` (NoMoreModelsError path).
    //   - Consumed: a same-role spawn (escalation). The marker is
    //     cleared when consumed.
    //   - Cleared (not consumed): a non-orchestrator, non-unavailable
    //     role is spawned. The orchestrator's spawn is the "hand
    //     to orchestrator once" — the marker persists so that a
    //     re-dispatch of the same role can escalate. A different
    //     non-orchestrator role's spawn consumes the "one chance":
    //     the unavailable role is no longer relevant, the marker
    //     is cleared.
    if (this.unavailableRole === role) {
      this.unavailableRole = null; // consume the escalation
      throw new RoleEscalationError(role);
    }
    if (this.unavailableRole !== null && this.unavailableRole !== role) {
      // Different role — clear only if it's a non-orchestrator role
      // (the "one chance" is used). The orchestrator's spawn leaves
      // the marker in place so a re-dispatch of the same role
      // escalates.
      const orchestrator = this.loadedManifestValue?.def.orchestrator;
      if (role !== orchestrator) {
        this.unavailableRole = null;
      }
    }

    // ── Task 18: resolve the model from the role's models[] list.
    // The "logical" model is the `provider:id` string the
    // lifecycle record will carry; the SDK model is always the
    // stub (we don't have a real provider for the test path).
    const roleConfig = this.lookupRoleConfig(role);
    const modelIndex = opts.modelIndex ?? 0;
    let logicalModel: string | null = null;
    if (roleConfig?.models !== undefined) {
      if (modelIndex >= roleConfig.models.length) {
        // List exhausted — mark the role unavailable so the next
        // re-dispatch escalates (§9.4 v1 default). The loop
        // catches `NoMoreModelsError`, records the final
        // session_failed(model_error), and synthesizes a handoff
        // to the orchestrator.
        this.unavailableRole = role;
        throw new NoMoreModelsError(role, modelIndex, roleConfig.models.length);
      }
      const entry = roleConfig.models[modelIndex];
      if (entry !== undefined) logicalModel = entry;
    } else if (modelIndex > 0) {
      // No fallback list declared, but the loop asked for index >0.
      // Same exhaustion semantics.
      this.unavailableRole = role;
      throw new NoMoreModelsError(role, modelIndex, 0);
    }

    // ── Task 17: per-session cap. Read from the role's
    // `max_session_cost_usd`. Uncapped if absent.
    const cap = roleConfig?.max_session_cost_usd ?? null;

    const seam = new SessionSeam();
    // Shared rejection predicate (7A.4): the tool factories
    // close over a `shouldRejectCapture` that reads the
    // session's terminal state. Bound to the state after the
    // session is constructed (the state needs the
    // `sessionId`).
    const rejector = createCaptureRejector();
    const handoff = createHandoffTool(seam, rejector.shouldRejectCapture);
    const end = createEndTool(seam, rejector.shouldRejectCapture);

    const { session } = await createAgentSession({
      model: this.model,
      modelRegistry: this.modelRegistry,
      tools: ["handoff", "end"],
      customTools: [handoff, end],
      sessionManager: this.sessionManager,
    });

    this.stubSessionCounter += 1;
    const stubId = `stub-session-${this.stubSessionCounter}`;

    // ── Task 17: per-session state. The host accumulates usage
    // here; `captureUsage` and `sessionTerminalReason` read from it.
    const state = new SessionState({ cap, model: logicalModel });
    this.sessionStates.set(session.sessionId, state);
    this.agentsBySessionId.set(session.sessionId, session);
    rejector.bindState(state);

    // ── Task 17: subscribe to the session's events. The shared
    // handler (session-event-handler.ts) accumulates usage,
    // detects model errors, and enforces the per-session cap.
    attachSessionEventHandler({ session, state, role });

    return {
      role,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? `/tmp/${stubId}.jsonl`,
      model: logicalModel,
      readCaptureBuffer: () => seam.read(),
      resetCaptureBuffer: () => seam.reset(),
      subscribe: (listener) => session.subscribe(listener),
      prompt: (text) => session.prompt(text),
      dispose: async () => {
        await session.dispose();
        this.sessionStates.delete(session.sessionId);
        this.agentsBySessionId.delete(session.sessionId);
      },
    };
  }

  captureUsage(session: RoleSession): UsageRecord {
    const state = this.sessionStates.get(session.sessionId);
    return (
      state?.usage() ?? { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 }
    );
  }

  sessionTerminalReason(session: RoleSession): SessionTerminalReason {
    const state = this.sessionStates.get(session.sessionId);
    return state?.terminalReason ?? null;
  }

  persistRecord(record: PersistedRecord): void {
    this.log.append(record);
  }

  nextVisitIndex(role: Role): number {
    // Count terminals (session_ended + session_failed) for the role,
    // not session_started. A model retry (Task 18) is the SAME visit
    // with a different model — the role didn't transition, it re-ran.
    // Counting session_started would inflate the visit_index on every
    // model retry within the same visit, which would be wrong.
    //
    // Semantics: visit_index is "which visit of this role in the run"
    // (§11.4). A visit ends when the role transitions away (terminal
    // session_ended) or is abandoned (session_failed for a non-
    // recoverable cause). A model retry produces a session_failed for
    // the failed model — that counts as the same visit, so the count
    // doesn't increment until the visit actually ends.
    return (
      this.log
        .records(this.runId)
        .filter(
          (r) => (r.type === "session_ended" || r.type === "session_failed") && r.role === role,
        ).length + 1
    );
  }

  seedRunMemory(args: {
    checkpoint: Checkpoint;
    def: MachineDefinition;
    goal: string;
    runCostCap: number | null;
  }): RunMemory {
    // Real call into the core's buildRunMemory so the orchestrator's
    // run-memory seed reflects the actual persisted record history
    // (visit_history, per_role_cost, next_candidates). The host owns
    // its log; this is the canonical seam for the loop's
    // orchestrator-seed injection (Task 16.5, §8.4 single-writer
    // rule).
    const records = this.log.records(this.runId);
    return buildRunMemory(args.checkpoint, records, args.def, {
      goal: args.goal,
      runCostCap: args.runCostCap,
    });
  }

  runCostSoFar(): number {
    // Sum `usage.cost` across all session_ended + session_failed
    // records in the run. Both terminals cost (§11.4). The loop
    // adds the current terminal's usage on top of this when
    // evaluating the cap (§11.7: "persisted roll-up plus the
    // current terminal's captured usage before reducing the
    // role's captured machine event").
    let total = 0;
    for (const r of this.log.records(this.runId)) {
      if ((r.type === "session_ended" || r.type === "session_failed") && r.usage) {
        total += r.usage.cost;
      }
    }
    return total;
  }

  getNextModel(role: Role, currentModelIndex: number): string | null {
    // Read the role's `models[]` list from the loaded manifest
    // and return the entry at `currentModelIndex + 1`, or `null`
    // if the list is exhausted (or the role has no models field).
    // The loop uses this to populate the `model_fallback`
    // record's `to_model` field on each model transition.
    const roleConfig = this.lookupRoleConfig(role);
    if (roleConfig?.models === undefined) return null;
    const next = roleConfig.models[currentModelIndex + 1];
    return next ?? null;
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
    // (Task 15.5) flipping SessionSeam.isSealed. The Host
    // interface method is reserved for external consumers.
  }

  // ─── Internals ──────────────────────────────────────────────

  /**
   * Look up the role's config from the loaded manifest. Returns
   * `undefined` if no manifest was provided (backward compat with
   * Phase 4 tests) or the role isn't declared.
   */
  private lookupRoleConfig(role: Role): import("../manifest/types.js").RoleConfig | undefined {
    const loaded = this.loadedManifestValue;
    if (loaded === undefined) return undefined;
    return loaded.manifest.roles.find((r) => r.name === role);
  }
}
