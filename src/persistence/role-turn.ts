/**
 * Bounded structured role-turn telemetry — Issue #68.
 *
 * Public barrel for the additive `role_turn` record. The implementation is split
 * into responsibility-scoped submodules so each stays within the ~400 LOC module
 * ceiling (AGENTS.md): the pure value model lives in `role-turn-model.ts`, config
 * resolution in `role-turn-limits.ts`, the measurement + limit-application
 * algorithm in `role-turn-capture.ts`, strict persistence-boundary validation
 * split by responsibility (`role-turn-validate.ts` entry, `role-turn-validate-
 * blocks.ts` block shape/primitives, `role-turn-validate-capture.ts` capture
 * arithmetic, `role-turn-validate-limits.ts` limit-set validation), and ledger
 * reconstruction in `role-turn-ledger.ts`.
 *
 * This barrel re-exports the union of those public symbols so existing importers
 * (`src/host/role-turn-producer.ts`, `src/persistence/record-materialization.ts`,
 * and the tests) keep working unchanged. Pure, host-agnostic; the pi-coupled
 * content extraction lives in `src/host/role-turn-producer.ts`.
 *
 * The record lets an analytics / observability consumer answer, in durable order,
 * which role said what readable text or readable thinking in which logical
 * invocation and physical conversation — without treating Pi's session JSONL as
 * analytics payload (spec §1 / §2).
 */

export * from "./role-turn-capture.js";
export * from "./role-turn-ledger.js";
export * from "./role-turn-limits.js";
export * from "./role-turn-model.js";
export * from "./role-turn-validate.js";
export * from "./role-turn-validate-blocks.js";
export * from "./role-turn-validate-capture.js";
export * from "./role-turn-validate-limits.js";
