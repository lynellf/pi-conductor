/**
 * Bounded structured role-turn telemetry — Issue #68.
 *
 * Strict `role_turn` record validation at persistence boundaries (§7.1). This is
 * the validation entry point: it re-exports {@link assertRoleTurnRecord}, which
 * orchestrates the full record-shape check. The record's layered validators are
 * split by responsibility so each stays within the ~400 LOC module ceiling
 * (AGENTS.md): block shape and shared primitives live in
 * `role-turn-validate-blocks.ts`, and capture-object arithmetic lives in
 * `role-turn-validate-capture.ts`. Pure, side-effect-free.
 */

export { assertRoleTurnRecord } from "./role-turn-validate-capture.js";
