/**
 * StubHost delegation helpers — extracted to satisfy the AGENTS.md
 * ~500-LOC hard ceiling on source files.
 *
 * Phase 2, issue #17: manages stub child sessions for the
 * `DelegationManager`. All mutable delegation state lives here.
 * Exported as a class so the host can instantiate it once and
 * call its methods.
 *
 * **Module size:** ~160 LOC (well below ceiling).
 */

import { Buffer } from "node:buffer";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelEffort, PersistedRecord, Role } from "../index.js";
import { SessionState } from "./cost.js";
import { buildChildToolsAllowlist } from "./delegation/child-tool-policy.js";
import type { ChildSpawnHandle, DelegationManager, SpawnChildArgs } from "./delegation/manager.js";
import { DelegationManager as DelegationManagerClass } from "./delegation/manager.js";
import { createReportResultTool } from "./delegation/report-result-tool.js";
import { attachSessionEventHandler } from "./session-event-handler.js";
import { makeStubModel, makeStubStreamFunction, type StubStep } from "./stub-provider.js";

/**
 * Delegation state and helpers for `StubHost`.
 *
 * Holds all mutable delegation state (`admittedChildren`, `childSteps`,
 * `randomBytes`, `stubChildCounter`) and the methods that operate on it.
 * `StubHost` creates one of these per instance and delegates to it.
 */
export class StubHostDelegation {
  private readonly childSteps: ReadonlyMap<string, readonly StubStep[]>;
  private readonly randomBytes: (n: number) => Buffer;
  private readonly admittedChildren = new Map<Role, number>();
  private stubChildCounter = 0;

  /** Per-child session state for usage accumulation and cleanup. */
  private readonly sessionStates = new Map<string, SessionState>();

  constructor(opts: {
    readonly childSteps?: ReadonlyMap<string, readonly StubStep[]>;
    readonly randomBytes?: (n: number) => Buffer;
  }) {
    this.childSteps = opts.childSteps ?? new Map();
    this.randomBytes =
      opts.randomBytes ??
      ((n) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { randomBytes } = require("node:crypto") as { randomBytes: (n: number) => Buffer };
        return Buffer.from(randomBytes(n));
      });
  }

  /** Increment and return the next admitted-child count for a role. */
  nextAdmittedChild(role: Role): number {
    const prev = this.admittedChildren.get(role) ?? 0;
    const next = prev + 1;
    this.admittedChildren.set(role, next);
    return prev;
  }

  /** Get the current admitted-child count for a role (no increment). */
  admittedChildCount(role: Role): number {
    return this.admittedChildren.get(role) ?? 0;
  }

  /** Increment admitted child count by delta (used by manager after run). */
  addAdmittedChildren(role: Role, delta: number): void {
    const prev = this.admittedChildren.get(role) ?? 0;
    this.admittedChildren.set(role, prev + delta);
  }

  /**
   * Create a `DelegationManager` for the given parent role.
   * The manager is created before the parent session exists, so
   * `parentSession` starts empty — the caller must call
   * `manager.updateParentSession(sessionFile)` after
   * `createAgentSession` resolves.
   */
  createDelegationManager(opts: {
    readonly parentRole: Role;
    readonly parentSession: string;
    readonly policy: import("../manifest/types.js").DelegationPolicy;
    readonly runId: string;
    readonly onRecord: (record: PersistedRecord) => void;
    readonly parentModel: string | null;
    readonly parentModelEffort: ModelEffort;
    readonly admittedChildren: number;
  }): DelegationManager {
    return new DelegationManagerClass({
      parentRole: opts.parentRole,
      parentSession: opts.parentSession,
      policy: opts.policy,
      onRecord: opts.onRecord,
      spawnChild: (args) => this.spawnChild(args, opts.parentRole),
      runId: opts.runId,
      admittedChildren: opts.admittedChildren,
      parentModel: opts.parentModel,
      parentModelEffort: opts.parentModelEffort,
      randomBytes: this.randomBytes,
    });
  }

  /**
   * Spawn a stub child session for delegation.
   * Each child gets its own stub session driven by `childSteps`.
   */
  async spawnChild(args: SpawnChildArgs, parentRole: Role): Promise<ChildSpawnHandle> {
    const { taskId, workspace, onSessionCreated } = args;
    this.stubChildCounter += 1;
    const stubChildId = `stub-child-${this.stubChildCounter}`;

    const childStepList = this.childSteps.get(taskId) ?? [{ kind: "no_emission" as const }];

    const authStorage = AuthStorage.inMemory();
    const childRegistry = ModelRegistry.inMemory(authStorage);
    const childStreamFn = makeStubStreamFunction({
      steps: childStepList,
      emitStopAfterToolCalls: true,
    });

    // Use a unique API per child session to avoid the global `apiProviderRegistry`
    // collision (keyed only by `api`, not `api + provider`). Without this,
    // concurrent child spawns with the same `api: "anthropic-messages"` overwrite
    // each other's stream functions, causing child sessions to execute wrong steps.
    const childApi = `stub-child-api-${stubChildId}`;
    childRegistry.registerProvider(stubChildId, {
      api: childApi,
      apiKey: "stub-child-key",
      streamSimple: childStreamFn,
    });

    const childModel = makeStubModel();
    childModel.provider = stubChildId;
    childModel.api = childApi;

    const childSessionManager = SessionManager.inMemory();
    const tools = buildChildToolsAllowlist({ workspace, role: parentRole });

    const childState = new SessionState({ cap: null, model: args.model });
    this.sessionStates.set(stubChildId, childState);

    const reportTool = createReportResultTool({
      childId: args.childId,
      attempt: args.attempt,
      onReport: args.onReport,
    });

    const childResult = await createAgentSession({
      model: childModel,
      modelRegistry: childRegistry,
      tools: [...tools],
      customTools: [reportTool],
      sessionManager: childSessionManager,
    });

    const childSession = childResult.session;

    if (onSessionCreated !== undefined) {
      const sessionFile =
        (childSession as { sessionFile?: string }).sessionFile ?? `/tmp/${stubChildId}.jsonl`;
      onSessionCreated({ sessionFile, model: args.model });
    }

    // Subscribe to child events for usage accumulation via the shared handler.
    attachSessionEventHandler({ session: childSession, state: childState, role: parentRole });

    return {
      sessionId: stubChildId,
      sessionFile:
        (childSession as { sessionFile?: string }).sessionFile ?? `/tmp/${stubChildId}.jsonl`,
      prompt: (text) => childSession.prompt(text),
      subscribe: (listener) => childSession.subscribe(listener),
      abort: async () => {
        childState.markAborted();
        await childSession.abort();
      },
      dispose: async () => {
        await childSession.dispose();
        this.sessionStates.delete(stubChildId);
      },
    };
  }
}
