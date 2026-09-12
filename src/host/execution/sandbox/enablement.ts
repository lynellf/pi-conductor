/** Keep child command execution closed until command lifecycle and SDK integration pass (#106 §6). */

/** Actionable reason the staged backend cannot yet accept command workloads. */
export const SANDBOX_UNAVAILABLE_MESSAGE =
  "Bubblewrap execution is not enabled in this build: command lifecycle, output, restart, and delegated-session verification remain incomplete. Complete issue #106 execution verification before dispatching this profile.";

/** A configured sandbox must never fall back to the legacy file-only child session. */
export class SandboxBackendUnavailableError extends Error {
  readonly code = "sandbox-backend-unavailable";

  constructor() {
    super(SANDBOX_UNAVAILABLE_MESSAGE);
    this.name = "SandboxBackendUnavailableError";
  }
}
