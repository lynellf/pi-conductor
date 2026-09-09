import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { SessionState } from "./cost.js";
import type { ToolExecutionController } from "./execution/tool-execution-controller.js";
import type { SessionEventSource } from "./session-event-handler.js";

/** Resources acquired while starting one shared SDK role session. */
export interface SharedSdkStartupResources {
  readonly session: AgentSession;
  readonly roleSessionId: string;
  readonly sessionStates: Map<string, SessionState>;
  readonly agentsBySessionId: Map<string, SessionEventSource>;
  readonly unsubscribe?: () => void;
  readonly controller?: ToolExecutionController;
}

/** Create the cleanup callback shared by startup steps after native creation. */
export function createSharedSdkStartupCleanup(resources: SharedSdkStartupResources): () => void {
  return () => cleanupSharedSdkStartupFailure(resources);
}

/** Run one synchronous startup step while preserving its original failure. */
export function runSharedSdkStartupStep<T>(cleanup: () => void, step: () => T): T {
  try {
    return step();
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Best-effort cleanup for a failed shared startup while preserving its error. */
export function cleanupSharedSdkStartupFailure(resources: SharedSdkStartupResources): void {
  try {
    resources.unsubscribe?.();
  } catch {
    // Preserve the startup error; event listeners are process-local cleanup.
  }
  resources.sessionStates.delete(resources.roleSessionId);
  resources.agentsBySessionId.delete(resources.roleSessionId);
  try {
    resources.session.dispose();
  } catch {
    // Preserve the startup error; native disposal is best effort.
  }
}
