/**
 * Type-surface pin for src/core/types (spec §12, plan Checkpoint A).
 *
 * If a future change removes, renames, or repoints a type that the
 * reducer / host contract depends on, this file will fail to compile
 * under `pnpm typecheck` before the runtime tests even run.
 *
 * The runtime assertion is intentionally trivial; the test's value is
 * the compile that ships with `pnpm typecheck`.
 */

import { describe, expect, it } from "vitest";

import type {
  ActiveRoleSession,
  Checkpoint,
  createInitialCheckpoint,
  Effect,
  LegalTargets,
  MachineDefinition,
  MachineEvent,
  ModelFallback,
  PayloadSummary,
  RejectReason,
  Role,
  SessionLifecycleEvent,
  State,
  TransitionAccepted,
  TransitionRejected,
  TransitionResult,
  UsageRecord,
} from "../../src/core/types.js";

describe("core types public surface", () => {
  // Compile-time pin of every exported type. Never read at runtime.
  type _Surface = {
    role: Role;
    state: State;
    def: MachineDefinition;
    event: MachineEvent;
    checkpoint: Checkpoint;
    activeRoleSession: ActiveRoleSession;
    accepted: TransitionAccepted;
    rejected: TransitionRejected;
    result: TransitionResult;
    lifecycle: SessionLifecycleEvent;
    fallback: ModelFallback;
    reason: RejectReason;
    effect: Effect;
    legalTargets: LegalTargets;
    payloadSummary: PayloadSummary;
    usage: UsageRecord;
    init: ReturnType<typeof createInitialCheckpoint>;
  };

  it("exposes every spec §11/§12 type", () => {
    const pin: _Surface | null = null;
    expect(pin).toBeNull();
  });

  it("MachineEvent.payload is unknown (reducer never branches on it)", () => {
    // If `payload` ever becomes typed, this assignment stops compiling.
    const event: MachineEvent = {
      type: "handoff",
      target_role: "implementer",
      payload: undefined,
    };
    expect(event.type).toBe("handoff");
  });

  it("RejectReason union includes both reducer and host vocabulary", () => {
    const reasons: RejectReason[] = [
      "illegal_event",
      "guard_failed",
      "schema_invalid",
      "extra_emission",
      "no_emission",
    ];
    expect(reasons).toHaveLength(5);
  });
});
