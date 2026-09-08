/** Pin executable-tool defaults into every role and subagent profile for run snapshots — spec §10. */

import { resolveToolExecutionPolicy } from "./execution-policy.js";
import type { Manifest, RoleConfig, SubagentProfile } from "./types.js";

function pinRole(role: RoleConfig): RoleConfig {
  return Object.freeze({
    ...role,
    tool_execution: resolveToolExecutionPolicy(role.tool_execution),
  });
}

function pinProfile(profile: SubagentProfile): SubagentProfile {
  return Object.freeze({
    ...profile,
    tool_execution: resolveToolExecutionPolicy(profile.tool_execution),
  });
}

/** Return an immutable manifest copy with explicit tool policies on all executable principals. */
export function pinExecutionPolicies(manifest: Manifest): Manifest {
  return Object.freeze({
    ...manifest,
    roles: Object.freeze(manifest.roles.map(pinRole)),
    ...(manifest.subagents === undefined
      ? {}
      : { subagents: Object.freeze(manifest.subagents.map(pinProfile)) }),
  });
}
