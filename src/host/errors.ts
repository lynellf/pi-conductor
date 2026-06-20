/**
 * Host-typed errors — spec §8, §8.1, §8.2, §9.4, plan Task 18, Phase 7A.1.
 *
 * The host surfaces a small set of typed errors the loop can catch
 * to drive its model-fallback + escalation policy. Errors are
 * thrown, not returned, because the policy decision is "this call
 * cannot proceed" rather than "this call returned a value to act
 * on". The loop's recovery logic (`§8.2` / `§9.4`) branches on the
 * error class.
 *
 * Phase 7A.1 adds three boundary errors used by `ProductionHost`:
 *   - `ModelNotFoundError`         — registry miss for `provider:id` (§8.1)
 *   - `MalformedModelEntryError`   — `role.models[]` entry is not `provider:id` (§8.1, §13)
 *   - `SystemPromptNotFoundError`  — declared prompt path is missing on disk (§8.1)
 *
 * Each error's `message` includes the role name AND the missing
 * value (entry or path) so the loop / caller can surface a useful
 * diagnostic without re-deriving either side from stack frames.
 *
 * Host-agnosticism: this module is pure types + a tiny base class.
 * No SDK runtime imports.
 */

// ─── Phase 7A.1 boundary errors (§8.1) ────────────────────────────────

/**
 * Thrown by `ProductionHost.spawnRole` when
 * `modelRegistry.find(provider, id)` returns `null` for a
 * declared `role.models[modelIndex]` entry (Phase 7A.1, Task 7A.2,
 * spec §8.1).
 *
 * Distinct from `NoMoreModelsError` (Phase 4 Task 18): that one is
 * about the *index* being out of range; this one is about a
 * specific declared `provider:id` entry not being registered in
 * the model registry. The two flow through different recovery
 * paths — `NoMoreModelsError` is the loop's own fallback exhaustion
 * signal; `ModelNotFoundError` is a hard "this model isn't
 * available" — so they are kept as separate error classes.
 */
export class ModelNotFoundError extends Error {
  readonly role: string;
  readonly entry: string;
  constructor(role: string, entry: string) {
    super(
      `ModelNotFoundError: role '${role}' has no registered model for entry '${entry}' (§8.1: modelRegistry.find returned null)`,
    );
    this.name = "ModelNotFoundError";
    this.role = role;
    this.entry = entry;
  }
}

/**
 * Thrown by `ProductionHost.spawnRole` when a `role.models[modelIndex]`
 * entry is not in `provider:id` form (Phase 7A.1, Task 7A.2, spec
 * §8.1, §13 `bare-model-alias`).
 *
 * §13 `bare-model-alias` already rejects malformed entries at
 * manifest-load time as a hard error. This class is the runtime
 * counterpart: a manifest that *did* pass §13 (e.g. via
 * `RoleConfig` constructed in a test) but still surfaces a
 * non-`provider:id` entry should fail loud rather than silently
 * pick a default provider. The static check is the load-time gate;
 * this is the in-process fallback that keeps `ProductionHost` from
 * being a footgun.
 */
export class MalformedModelEntryError extends Error {
  readonly role: string;
  readonly entry: string;
  constructor(role: string, entry: string) {
    super(
      `MalformedModelEntryError: role '${role}' model entry '${entry}' is not in 'provider:id' form (§8.1)`,
    );
    this.name = "MalformedModelEntryError";
    this.role = role;
    this.entry = entry;
  }
}

/**
 * Thrown by `ProductionHost.spawnRole` when `role.system_prompt` is
 * declared but the path does not resolve to a file on disk under
 * `cwd` (Phase 7A.1, Task 7A.2, spec §8.1).
 *
 * A role with no `system_prompt` field is valid (§8.1 allows the
 * default); this error fires only when the path IS declared AND
 * missing — the explicit "you said it would be here, it isn't"
 * failure mode, not the implicit default.
 */
export class SystemPromptNotFoundError extends Error {
  readonly role: string;
  readonly path: string;
  constructor(role: string, path: string) {
    super(
      `SystemPromptNotFoundError: role '${role}' declared system_prompt path '${path}' does not exist on disk (resolved against cwd)`,
    );
    this.name = "SystemPromptNotFoundError";
    this.role = role;
    this.path = path;
  }
}

// ─── Phase 4 / Task 18 errors (preserved verbatim) ──────────────────

/**
 * Thrown by `Host.spawnRole` when the requested `modelIndex` is
 * past the end of the role's `models[]` list (Task 18, §8.2).
 *
 * The loop catches this, records the final `session_failed`
 * with `failure_reason: "model_error"`, and dispatches the
 * orchestrator with a "role unavailable" payload. Per `§9.4` v1
 * default, the orchestrator gets one chance to route around the
 * unavailable role; a re-dispatch to the same role surfaces as a
 * `RoleEscalationError` from the host.
 */
export class NoMoreModelsError extends Error {
  readonly role: string;
  readonly requestedIndex: number;
  readonly availableCount: number;
  constructor(role: string, requestedIndex: number, availableCount: number) {
    super(
      `NoMoreModelsError: role '${role}' has ${availableCount} model entr${
        availableCount === 1 ? "y" : "ies"
      }; requested index ${requestedIndex} is out of range (§8.2 model fallback exhausted)`,
    );
    this.name = "NoMoreModelsError";
    this.role = role;
    this.requestedIndex = requestedIndex;
    this.availableCount = availableCount;
  }
}

/**
 * Thrown by `Host.spawnRole` when the orchestrator re-dispatches
 * a role that just exhausted its model fallback (Task 18, §9.4 v1
 * default). This is the "escalate" case: hand to orchestrator
 * once, then surface to the caller if the orchestrator loops back
 * to the same unavailable role.
 *
 * The loop catches this and aborts the run with a typed error so
 * the caller (a CLI, a test harness) can surface a clear message
 * rather than a confusing `session_failed` cycle. Resume after
 * escalation is out of scope for v1 — the run is dead.
 */
export class RoleEscalationError extends Error {
  readonly role: string;
  constructor(role: string) {
    super(
      `RoleEscalationError: orchestrator re-dispatched role '${role}' after its model fallback was exhausted (§9.4 v1 default: hand to orchestrator once, then escalate); the run is terminated`,
    );
    this.name = "RoleEscalationError";
    this.role = role;
  }
}

/**
 * Thrown when `ask_user` runs without dialog-capable UI.
 * Spec §B.3 keeps this as a typed failure instead of a silent no-op.
 */
export class AskUserUnavailableError extends Error {
  readonly mode: string;
  readonly hasUI: boolean;

  constructor(mode: string, hasUI = false) {
    super(
      `AskUserUnavailableError: ask_user requires dialog-capable UI; mode='${mode}' hasUI=${hasUI}`,
    );
    this.name = "AskUserUnavailableError";
    this.mode = mode;
    this.hasUI = hasUI;
  }
}
