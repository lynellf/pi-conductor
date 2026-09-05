/** Typed normalization for failures at the Prewalk guide/executor switch boundary. */

import type { PrewalkFailureCode } from "../persistence/prewalk-records.js";

export class PrewalkRoleSessionError extends Error {
  constructor(
    readonly code: PrewalkFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PrewalkRoleSessionError";
  }
}

export function normalizePrewalkRoleSessionFailure(error: unknown): PrewalkRoleSessionError {
  if (error instanceof PrewalkRoleSessionError) return error;
  if (isErrorCode(error, "prewalk_transform_unsupported")) {
    return new PrewalkRoleSessionError("prewalk_transform_unsupported", error.message, {
      cause: error,
    });
  }
  if (isErrorCode(error, "prewalk_projection_too_large")) {
    return new PrewalkRoleSessionError("prewalk_projection_too_large", error.message, {
      cause: error,
    });
  }
  if (isErrorCode(error, "prewalk_git_checkpoint_failed")) {
    return new PrewalkRoleSessionError("prewalk_git_checkpoint_failed", error.message, {
      cause: error,
    });
  }
  return new PrewalkRoleSessionError(
    "prewalk_environment_apply_failed",
    error instanceof Error ? error.message : "Prewalk switch failed",
    { cause: error },
  );
}

function isErrorCode(error: unknown, code: string): error is Error & { readonly code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}
