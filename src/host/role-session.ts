import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ModelEffort, Role, SessionWorkspaceDescriptor } from "../core/types.js";
import type { RoleSession, TrajectoryContinuationOptions } from "./host.js";
import type { SessionSeam } from "./seam.js";

/** RoleSession plus production-only inspection fields used by wiring tests. */
export interface RoleSessionAdapter extends RoleSession {
  readonly systemPrompt: string;
  getActiveToolNames(): string[];
  isAutoCompactionEnabled(): boolean;
}

/** Build the common production/stub adapter around a native pi `AgentSession`. */
export function createRoleSessionAdapter(opts: {
  readonly role: Role;
  readonly session: AgentSession;
  readonly seam: SessionSeam;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly model: string | null;
  readonly effort: ModelEffort;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly isTrajectory?: boolean;
  /** Reconfigure a shared native session for the next trajectory role. */
  readonly continueTrajectory?: (options: TrajectoryContinuationOptions) => Promise<RoleSession>;
  /** Host-owned workspace metadata for an isolated worktree/copy session. */
  readonly workspace?: SessionWorkspaceDescriptor;
  /** Detach logical resources; native conversation ownership is host-controlled. */
  readonly onDispose: () => Promise<void> | void;
  /** Whether this logical adapter still owns physical SDK disposal. */
  readonly disposeNative?: () => boolean;
}): RoleSessionAdapter {
  const { session, seam } = opts;
  const workspace =
    opts.workspace === undefined
      ? undefined
      : (Object.freeze(opts.workspace) as SessionWorkspaceDescriptor);
  return {
    role: opts.role,
    sessionId: opts.sessionId,
    conversationId: session.sessionId,
    sessionFile: opts.sessionFile,
    model: opts.model,
    effort: opts.effort,
    ...(workspace !== undefined ? { workspace } : {}),
    retries: opts.retries,
    retryDelayMs: opts.retryDelayMs,
    ...(opts.isTrajectory === true && { isTrajectory: true }),
    readCaptureBuffer: () => seam.read(),
    resetCaptureBuffer: () => seam.reset(),
    takeHandoffValidationFailures: () => seam.takeHandoffValidationFailures(),
    subscribe: (listener: (event: AgentSessionEvent) => void) => session.subscribe(listener),
    steer: (text: string) => session.steer(text),
    clearQueue: () => session.clearQueue(),
    isSealed: () => seam.isSealed,
    subscribeSealed: (listener: () => void) => seam.subscribeSealed(listener),
    prompt: (text: string) => session.prompt(text),
    getTrajectoryContext: () => ({
      tokens: session.getContextUsage()?.tokens,
      hasCompaction: session.sessionManager
        .getEntries()
        .some((entry) => entry.type === "compaction"),
      registeredToolNames: session.getAllTools().map((tool) => tool.name),
      userMessageTexts: session.messages.flatMap((message) =>
        message.role === "user" ? textParts(message.content) : [],
      ),
      toolDefinitions: Object.fromEntries(session.getAllTools().map((tool) => [tool.name, tool])),
    }),
    ...(opts.continueTrajectory !== undefined && {
      continueTrajectory: opts.continueTrajectory,
    }),
    dispose: async () => {
      if (opts.disposeNative?.() !== false) session.dispose();
      await opts.onDispose();
    },
    get systemPrompt(): string {
      return session.systemPrompt;
    },
    getActiveToolNames: () => session.getActiveToolNames(),
    isAutoCompactionEnabled: () => session.autoCompactionEnabled,
  };
}

function textParts(content: unknown): readonly string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
      ? [part.text]
      : [],
  );
}
