/**
 * ProductionHost delegation helpers — extracted to satisfy the AGENTS.md
 * ~500-LOC hard ceiling on source files.
 *
 * Phase 2, issue #17: manages production child sessions for the
 * `DelegationManager`. All mutable delegation state lives here.
 * Exported as a class so the host can instantiate it once and
 * call its methods.
 *
 * **Module size:** ~170 LOC (well below ceiling).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelEffort, PersistedRecord, Role } from "../index.js";
import { SessionState } from "./cost.js";
import { buildChildToolsAllowlist } from "./delegation/child-tool-policy.js";
import type { ChildSpawnHandle, DelegationManager, SpawnChildArgs } from "./delegation/manager.js";
import { DelegationManager as DelegationManagerClass } from "./delegation/manager.js";
import { createReportResultTool } from "./delegation/report-result-tool.js";
import { attachSessionEventHandler } from "./session-event-handler.js";

/**
 * Delegation state and helpers for `ProductionHost`.
 *
 * Holds all mutable delegation state (`admittedChildren`, `childSessionStates`,
 * `_parentSessionFile`) and the methods that operate on it.
 * `ProductionHost` creates one of these per instance and delegates to it.
 */
export class ProductionHostDelegation {
  /** Per-role admitted child count for `max_children` enforcement. */
  private readonly admittedChildren = new Map<Role, number>();
  /** Track child session state for cleanup. */
  private readonly childSessionStates = new Map<string, SessionState>();

  /**
   * The session file of the current parent session. Set via
   * `setParentSessionFile()` after `createAgentSession` resolves.
   * Used by `spawnChild` for the child `SessionManager`'s
   * `parentSession` provenance header.
   */
  private _parentSessionFile = "";

  constructor(
    private readonly opts: {
      readonly sessionDir: string;
      readonly cwd: string;
      readonly agentDir: string;
      readonly modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry;
    },
  ) {}

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

  /** Add delta to the admitted child count (used after manager.run returns). */
  addAdmittedChildren(role: Role, delta: number): void {
    const prev = this.admittedChildren.get(role) ?? 0;
    this.admittedChildren.set(role, prev + delta);
  }

  /** Record the parent session file (called after `createAgentSession`). */
  setParentSessionFile(file: string): void {
    this._parentSessionFile = file;
  }

  /**
   * Create a `DelegationManager` for the given parent role.
   * The manager is created before the parent session exists, so
   * `parentSession` starts empty — the caller must call
   * `setParentSessionFile()` after `createAgentSession` resolves.
   */
  createDelegationManager(opts: {
    readonly parentRole: Role;
    readonly policy: import("../manifest/types.js").DelegationPolicy;
    readonly runId: string;
    readonly onRecord: (record: PersistedRecord) => void;
    readonly parentModel: string | null;
    readonly parentModelEffort: ModelEffort;
    readonly admittedChildren: number;
  }): DelegationManager {
    return new DelegationManagerClass({
      parentRole: opts.parentRole,
      parentSession: "", // Updated via setParentSessionFile after createAgentSession
      policy: opts.policy,
      onRecord: opts.onRecord,
      spawnChild: (args) => this.spawnChild(args, opts.parentRole),
      runId: opts.runId,
      admittedChildren: opts.admittedChildren,
      parentModel: opts.parentModel,
      parentModelEffort: opts.parentModelEffort,
    });
  }

  /**
   * Spawn a production child session for delegation.
   * Each child gets its own file-backed `SessionManager` under
   * `<sessionDir>/children/<childId>/` with `parentSession` provenance.
   */
  async spawnChild(args: SpawnChildArgs, parentRole: Role): Promise<ChildSpawnHandle> {
    const { childId, workspace, worktreePath, onSessionCreated } = args;

    const childSessionDir = join(this.opts.sessionDir, "children", childId);
    mkdirSync(childSessionDir, { recursive: true });

    const parentSessionFile = this._parentSessionFile || this.opts.sessionDir;

    const childSessionManager = SessionManager.create(
      worktreePath ?? this.opts.cwd,
      childSessionDir,
      { parentSession: parentSessionFile },
    );

    const childState = new SessionState({ cap: null, model: null });
    this.childSessionStates.set(childId, childState);

    const reportTool = createReportResultTool({
      childId,
      attempt: args.attempt,
      onReport: args.onReport,
    });

    const tools = buildChildToolsAllowlist({ workspace, role: parentRole });

    const childResult = await createAgentSession({
      cwd: worktreePath ?? this.opts.cwd,
      modelRegistry: this.opts.modelRegistry,
      resourceLoader: new DefaultResourceLoader({
        cwd: worktreePath ?? this.opts.cwd,
        agentDir: this.opts.agentDir,
      }),
      sessionManager: childSessionManager,
      customTools: [reportTool],
      tools: [...tools],
    });

    const childSession = childResult.session;

    if (onSessionCreated !== undefined) {
      const sessionFile =
        (childSession as { sessionFile?: string }).sessionFile ??
        `${childSessionDir}/${childSession.sessionId}.jsonl`;
      onSessionCreated({ sessionFile, model: args.model ?? null });
    }

    // Subscribe to child session events for usage accumulation via the shared handler.
    attachSessionEventHandler({ session: childSession, state: childState, role: parentRole });

    const sessionFile =
      (childSession as { sessionFile?: string }).sessionFile ??
      `${childSessionDir}/${childSession.sessionId}.jsonl`;

    return {
      sessionId: childSession.sessionId,
      sessionFile,
      prompt: (text) => childSession.prompt(text),
      subscribe: (listener) => childSession.subscribe(listener),
      abort: async () => {
        childState.markAborted();
        await childSession.abort();
      },
      dispose: async () => {
        await childSession.dispose();
        this.childSessionStates.delete(childId);
      },
    };
  }
}
