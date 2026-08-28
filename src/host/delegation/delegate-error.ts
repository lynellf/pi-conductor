/** Safe structured failures returned by delegate admission. */

/** One safe structured delegate admission diagnostic. */
export interface DelegateValidationErrorItem {
  readonly code: string;
  readonly message: string;
  readonly task_id?: string;
  readonly artifact_id?: string;
  readonly path?: string;
}

/** Structured parent-tool validation error. */
export class DelegateToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly errors: readonly DelegateValidationErrorItem[],
  ) {
    super(message);
    this.name = "DelegateToolError";
  }
}
