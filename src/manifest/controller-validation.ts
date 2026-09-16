/** Semantic checks for controller-only manifests — issue #115 §2. */
import { Value } from "typebox/value";
import { controllerConfigSchema } from "./controller.js";
import type { Manifest } from "./types.js";
import type { ManifestError } from "./validate.js";

export function validateControllerConfig(m: Manifest, errors: ManifestError[]): void {
  const config = m.controller;
  if (config === undefined) return;
  if (!Value.Check(controllerConfigSchema, config)) {
    errors.push({
      code: "invalid-controller-config",
      message: "controller does not match the closed version 1 configuration schema",
    });
    return;
  }
  const adapters = new Set<string>();
  for (const adapter of config.adapters) {
    if (adapters.has(adapter.id))
      errors.push({
        code: "controller-duplicate-adapter-id",
        message: `controller repeats adapter '${adapter.id}'`,
      });
    adapters.add(adapter.id);
  }
  const profiles = new Set((m.subagents ?? []).map((profile) => profile.name));
  const allowed = new Set<string>();
  for (const name of config.delegation.allowed_subagents) {
    if (allowed.has(name))
      errors.push({
        code: "delegation-duplicate-allowed-subagent",
        message: `controller delegation repeats subagent '${name}'`,
      });
    allowed.add(name);
    if (!profiles.has(name))
      errors.push({
        code: "delegation-undeclared-subagent",
        message: `controller delegation references undeclared subagent '${name}'`,
      });
  }
  if (config.delegation.max_parallel > config.delegation.max_children_per_session)
    errors.push({
      code: "delegation-max-parallel-exceeds-slot-limit",
      message: "controller delegation max_parallel cannot exceed max_children_per_session",
    });
  const orchestrator = m.roles.find((role) => role.is_orchestrator === true);
  if (orchestrator === undefined) return;
  if (m.end_request_roles !== undefined)
    errors.push({
      code: "controller-end-request-roles-unsupported",
      message: "controller mode cannot configure worker end-request roles",
    });
  if (m.roles.some((role) => role.is_orchestrator !== true))
    errors.push({
      code: "controller-workers-unsupported",
      message: "controller mode is coordinator-only and cannot declare FSM worker roles",
    });
  if (orchestrator.models !== undefined || orchestrator.max_session_cost_usd !== undefined)
    errors.push({
      code: "controller-orchestrator-model-unsupported",
      message: "controller mode cannot configure an orchestrator model or session cost",
      role: orchestrator.name,
    });
  if (orchestrator.tools !== undefined)
    errors.push({
      code: "controller-orchestrator-tools-unsupported",
      message: "controller mode cannot configure an SDK orchestrator tool list",
      role: orchestrator.name,
    });
  if (orchestrator.context_retention === "run")
    errors.push({
      code: "controller-orchestrator-context-unsupported",
      message: "controller mode cannot configure orchestrator context retention",
      role: orchestrator.name,
    });
  if (orchestrator.delegation !== undefined)
    errors.push({
      code: "controller-orchestrator-delegation-unsupported",
      message: "controller mode uses controller.delegation instead of SDK orchestrator delegation",
      role: orchestrator.name,
    });
}
