import type { RoleConfig } from "./types.js";

export type ContextRetentionErrorCode =
  | "invalid-context-retention"
  | "context-retention-on-worker"
  | "context-retention-prewalk-conflict";

export interface ContextRetentionError {
  readonly code: ContextRetentionErrorCode;
  readonly message: string;
  readonly role: string;
}

/** Validate the role-local Issue #87 context retention contract. */
export function validateContextRetention(role: RoleConfig): readonly ContextRetentionError[] {
  const errors: ContextRetentionError[] = [];
  if (
    role.context_retention !== undefined &&
    role.context_retention !== "none" &&
    role.context_retention !== "run"
  ) {
    errors.push({
      code: "invalid-context-retention",
      message: `role '${role.name}' has invalid \`context_retention\`; expected "none" or "run"`,
      role: role.name,
    });
  }
  if (role.context_retention !== undefined && !role.is_orchestrator) {
    errors.push({
      code: "context-retention-on-worker",
      message: `role '${role.name}' cannot declare context retention because it is a worker`,
      role: role.name,
    });
  }
  if (role.context_retention === "run" && role.prewalk !== undefined) {
    errors.push({
      code: "context-retention-prewalk-conflict",
      message: `orchestrator '${role.name}' cannot combine \`context_retention: run\` with prewalk`,
      role: role.name,
    });
  }
  return errors;
}
