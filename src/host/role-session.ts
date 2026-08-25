import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ModelEffort, Role, SessionWorkspaceDescriptor } from "../core/types.js";
import type { RoleSession } from "./host.js";
import type { SessionSeam } from "./seam.js";

/** RoleSession plus production-only inspection fields used by wiring tests. */
export interface RoleSessionAdapter extends RoleSession {
  readonly systemPrompt: string;
  getActiveToolNames(): string[];
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
  /** Host-owned workspace metadata for an isolated worktree/copy session. */
  readonly workspace?: SessionWorkspaceDescriptor;
  readonly onDispose: () => Promise<void> | void;
}): RoleSessionAdapter {
  const { session, seam } = opts;
  const workspace =
    opts.workspace === undefined
      ? undefined
      : (Object.freeze(opts.workspace) as SessionWorkspaceDescriptor);
  return {
    role: opts.role,
    sessionId: opts.sessionId,
    sessionFile: opts.sessionFile,
    model: opts.model,
    effort: opts.effort,
    ...(workspace !== undefined ? { workspace } : {}),
    retries: opts.retries,
    retryDelayMs: opts.retryDelayMs,
    readCaptureBuffer: () => seam.read(),
    resetCaptureBuffer: () => seam.reset(),
    takeHandoffValidationFailures: () => seam.takeHandoffValidationFailures(),
    subscribe: (listener: (event: AgentSessionEvent) => void) => session.subscribe(listener),
    steer: (text: string) => session.steer(text),
    clearQueue: () => session.clearQueue(),
    isSealed: () => seam.isSealed,
    subscribeSealed: (listener: () => void) => seam.subscribeSealed(listener),
    prompt: (text: string) => session.prompt(text),
    dispose: async () => {
      session.dispose();
      await opts.onDispose();
    },
    get systemPrompt(): string {
      return session.systemPrompt;
    },
    getActiveToolNames: () => session.getActiveToolNames(),
  };
}
