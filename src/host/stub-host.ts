/**
 * StubHost — minimal real `Host` that drives `createAgentSession`
 * via the stub provider (Task 16). Promoted to its own module so
 * Task 13.5's resume tests (and any future E2E) can reuse it.
 *
 * Implements the `Host` interface with the methods the loop
 * actually calls: `spawnRole`, `captureUsage`, `persistRecord`,
 * `nextVisitIndex`. The other methods (`seedRunMemory`,
 * `abortSession`, `sealSession`) are no-ops for now; they gain
 * real behavior in Task 16.5 and Phase 5.
 *
 * One `StubHost` per run: the constructor takes the run_id, log,
 * manifest def, and the script the stub will emit across turns.
 * `spawnRole` creates a fresh `createAgentSession` per role visit
 * (matching the production "fresh session per role invocation"
 * model — §12.1, plan Task 15).
 */

import type { Usage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import type {
  Host,
  PersistedRecord,
  RecordLog,
  Role,
  RoleSession,
  RunMemory,
  UsageRecord,
} from "../index.js";
import { createEndTool, createHandoffTool, SessionSeam } from "./index.js";
import { makeStubModel, makeStubStreamFunction, type StubStep } from "./stub-provider.js";

export interface StubHostOptions {
  readonly runId: string;
  /** Record log (in-memory for fast tests; file-backed via Task 13.5's FileRecordLog for resume tests). */
  readonly log: RecordLog;
  readonly steps: readonly StubStep[];
  readonly usage?: Partial<Usage>;
}

/**
 * Minimal real `Host` that wires `createAgentSession` to the stub
 * provider. The loop's contract:
 *
 *   - `spawnRole(role)` creates a fresh `createAgentSession` per
 *     role invocation (Task 15's canonical model).
 *   - `captureUsage` returns zeros — Task 17 wires real accumulation.
 *   - `persistRecord` writes to the run log.
 *   - `nextVisitIndex(role)` is 1-based and counts `session_started`
 *     records for `role` (§11.4: "reconstructable from records alone").
 */
export class StubHost implements Host {
  readonly log: StubHostOptions["log"];
  private readonly modelRegistry: ModelRegistry;
  private readonly sessionManager: SessionManager;
  private readonly model = makeStubModel();
  private readonly sessionsByStubId = new Map<
    string,
    { agentSession: AgentSession; seam: SessionSeam; role: Role }
  >();
  private stubSessionCounter = 0;
  private readonly runId: string;

  constructor(opts: StubHostOptions) {
    this.log = opts.log;
    this.runId = opts.runId;

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

  async spawnRole(role: Role): Promise<RoleSession> {
    const seam = new SessionSeam();
    const handoff = createHandoffTool(seam);
    const end = createEndTool(seam);

    const { session } = await createAgentSession({
      model: this.model,
      modelRegistry: this.modelRegistry,
      tools: ["handoff", "end"],
      customTools: [handoff, end],
      sessionManager: this.sessionManager,
    });

    this.stubSessionCounter += 1;
    const stubId = `stub-session-${this.stubSessionCounter}`;
    this.sessionsByStubId.set(stubId, { agentSession: session, seam, role });

    return {
      role,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? `/tmp/${stubId}.jsonl`,
      readCaptureBuffer: () => seam.read(),
      resetCaptureBuffer: () => seam.reset(),
      subscribe: (listener) => session.subscribe(listener),
      prompt: (text) => session.prompt(text),
      dispose: async () => {
        await session.dispose();
      },
    };
  }

  captureUsage(_session: RoleSession): UsageRecord {
    return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
  }

  persistRecord(record: PersistedRecord): void {
    this.log.append(record);
  }

  nextVisitIndex(role: Role): number {
    return (
      this.log.records(this.runId).filter((r) => r.type === "session_started" && r.role === role)
        .length + 1
    );
  }

  seedRunMemory(): RunMemory {
    return {
      run_id: this.runId,
      goal: "",
      current_role: "orchestrator",
      state: "orchestrator",
      visit_history: [],
      run_cost_to_date: 0,
      run_cost_cap: null,
      remaining_budget: null,
      per_role_cost: {},
      next_candidates: [],
    };
  }

  async abortSession(): Promise<void> {
    /* no-op */
  }

  sealSession(): void {
    /* no-op */
  }
}
