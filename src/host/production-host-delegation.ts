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

import { execFile as execFileNode } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelEffort, PersistedRecord, Role } from "../index.js";
import { SessionState } from "./cost.js";
import { buildChildToolsAllowlist } from "./delegation/child-tool-policy.js";
import { buildConfinedTools } from "./delegation/child-tools.js";
import type { ChildSpawnHandle, DelegationManager, SpawnChildArgs } from "./delegation/manager.js";
import { DelegationManager as DelegationManagerClass } from "./delegation/manager.js";
import { createReportResultTool } from "./delegation/report-result-tool.js";
import { createRunTool } from "./delegation/run-tool.js";
import { createWorktreeManager, type WorktreeManager } from "./delegation/worktree.js";
import { attachSessionEventHandler } from "./session-event-handler.js";

/**
 * Delegation state and helpers for `ProductionHost`.
 *
 * Holds all mutable delegation state (`admittedChildren`, `childSessionStates`,
 * `_parentSessionFile`) and the methods that operate on it.
 * `ProductionHost` creates one of these per instance and delegates to it.
 */
const execFile = promisify(execFileNode);

async function runGit(
  args: readonly string[],
  opts?: { readonly cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFile("git", [...args], { cwd: opts?.cwd });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (cause: unknown) {
    const error = cause as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(cause),
      exitCode: typeof error.code === "number" ? error.code : 1,
    };
  }
}

export class ProductionHostDelegation {
  /** Per-role admitted child count for `max_children` enforcement. */
  private readonly admittedChildren = new Map<Role, number>();
  /** Track child session state for cleanup. */
  private readonly childSessionStates = new Map<string, SessionState>();

  constructor(
    private readonly opts: {
      readonly sessionDir: string;
      readonly cwd: string;
      readonly agentDir: string;
      readonly modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry;
      readonly worktreeStateDir: string;
    },
  ) {
    mkdirSync(join(opts.worktreeStateDir, "worktrees"), { recursive: true });
    this.worktreeManager = createWorktreeManager({
      cwd: opts.cwd,
      stateDir: opts.worktreeStateDir,
      runGit,
    });
  }

  private readonly worktreeManager: WorktreeManager;

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
    readonly parentModelDefinition?: import("@earendil-works/pi-ai").Model<never>;
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
      getRemainingChildren: () =>
        opts.policy.max_children - this.admittedChildCount(opts.parentRole),
      addAdmittedChildren: (delta) => this.addAdmittedChildren(opts.parentRole, delta),
      parentModel: opts.parentModel,
      ...(opts.parentModelDefinition !== undefined && {
        parentModelDefinition: opts.parentModelDefinition,
      }),
      parentModelEffort: opts.parentModelEffort,
      worktreeManager: this.worktreeManager,
      primaryCwd: this.opts.cwd,
      worktreeStateDir: this.opts.worktreeStateDir,
    });
  }

  /**
   * Spawn a production child session for delegation.
   * Each child gets its own file-backed `SessionManager` under
   * `<sessionDir>/children/<childId>/` with `parentSession` provenance.
   */
  async spawnChild(args: SpawnChildArgs, parentRole: Role): Promise<ChildSpawnHandle> {
    const { childId, workspace, worktreePath, onSessionCreated } = args;
    const effectiveCwd = worktreePath ?? this.opts.cwd;

    const childSessionDir = join(this.opts.sessionDir, "children", childId);
    mkdirSync(childSessionDir, { recursive: true });

    const parentSessionFile = args.parentSession || this.opts.sessionDir;

    const childSessionManager = SessionManager.create(effectiveCwd, childSessionDir, {
      parentSession: parentSessionFile,
    });

    const childState = new SessionState({ cap: null, model: args.model });
    this.childSessionStates.set(childId, childState);

    const reportTool = createReportResultTool({
      childId,
      attempt: args.attempt,
      onReport: args.onReport,
    });

    const confinedTools = buildConfinedTools(workspace, effectiveCwd);
    const customTools = [...confinedTools, reportTool];
    if (workspace === "worktree") {
      customTools.push(
        createRunTool({
          worktreePath: effectiveCwd,
          branch: `conductor/${childId}`,
        }),
      );
    }

    const sessionOptions: Parameters<typeof createAgentSession>[0] = {
      cwd: effectiveCwd,
      modelRegistry: this.opts.modelRegistry,
      resourceLoader: new DefaultResourceLoader({
        cwd: effectiveCwd,
        agentDir: this.opts.agentDir,
      }),
      sessionManager: childSessionManager,
      customTools,
      tools: [...buildChildToolsAllowlist({ workspace, role: parentRole })],
      ...(args.modelDefinition !== undefined && { model: args.modelDefinition }),
      thinkingLevel: args.modelEffort === "max" ? "high" : args.modelEffort,
    };
    const childResult = await createAgentSession(sessionOptions);

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
