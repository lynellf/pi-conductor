/** Keep child command execution closed until the real bootstrap proof passes (#106 §6). */

/** Actionable reason the staged backend cannot yet accept command workloads. */
export const SANDBOX_UNAVAILABLE_MESSAGE =
  "Bubblewrap execution is not enabled in this build: the patched-runtime bootstrap, isolation, and cleanup verification gates are incomplete. Complete issue #106 verification on an authorized patched test host before dispatching this profile.";

/** A configured sandbox must never fall back to the legacy file-only child session. */
export class SandboxBackendUnavailableError extends Error {
  readonly code = "sandbox-backend-unavailable";

  constructor() {
    super(SANDBOX_UNAVAILABLE_MESSAGE);
    this.name = "SandboxBackendUnavailableError";
  }
}
