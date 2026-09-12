/** Typed failure while collecting trusted host facts for Bubblewrap admission. */
export class BubblewrapObservationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "bubblewrap-observation-invalid-path"
      | "bubblewrap-observation-unavailable"
      | "bubblewrap-observation-unsafe-file"
      | "bubblewrap-observation-mutated"
      | "bubblewrap-observation-capability-check-failed"
      | "bubblewrap-observation-unapproved-build"
      | "bubblewrap-observation-command-failed"
      | "bubblewrap-observation-unsupported-platform"
      | "bubblewrap-observation-privileged-observer",
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "BubblewrapObservationError";
  }
}
