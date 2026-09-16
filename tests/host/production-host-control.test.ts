import { describe, expect, it, vi } from "vitest";
import { abortSession } from "../../src/host/production-host-control.js";
import { ProductionSessionState } from "../../src/host/production-session-state.js";

describe("production host controller control", () => {
  it("aborts controller-owned work without an SDK event-state entry", async () => {
    const abortOwnedWork = vi.fn().mockResolvedValue(undefined);
    const session = {
      sessionOrigin: {
        kind: "controller",
        controllerId: "controller",
        definitionDigest: "a".repeat(64),
        activationId: "activation",
        ownerEpoch: 1,
      },
      sessionId: "controller-session",
      abortOwnedWork,
    } as never;
    const sessionState = new ProductionSessionState(new Map(), new Map());

    await abortSession(
      {
        endGuardRunner: { abort: vi.fn().mockResolvedValue(undefined), run: vi.fn() },
        delegation: {
          closeScope: vi.fn().mockResolvedValue(undefined),
          failure: vi.fn(),
        },
        delegationSessionKeys: new Map(),
        inactiveDelegationSessions: new Set(),
        sessionState,
      } as never,
      session,
      "operator abort",
    );

    expect(abortOwnedWork).toHaveBeenCalledOnce();
  });
});
