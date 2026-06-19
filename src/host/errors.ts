/**
 * Host-typed errors — spec §8.2, §9.4, plan Task 18.
 *
 * The host surfaces a small set of typed errors the loop can catch
 * to drive its model-fallback + escalation policy. Errors are
 * thrown, not returned, because the policy decision is "this call
 * cannot proceed" rather than "this call returned a value to act
 * on". The loop's recovery logic (`§8.2` / `§9.4`) branches on the
 * error class.
 *
 * Host-agnosticism: this module is pure types + a tiny base class.
 * No SDK runtime imports.
 */

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
