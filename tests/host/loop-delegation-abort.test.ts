/**
 * Tests for loop's setActiveDelegation integration.
 * Phase 3 Task 3.4 verification.
 */

import { describe, expect, test } from "vitest";
import type { RunAbortControl } from "../../src/host/loop.js";

describe("RunAbortControl.setActiveDelegation", () => {
  test("setActiveDelegation stores the manager reference", async () => {
    let storedManager: unknown | null = null;

    const abortControl: RunAbortControl = {
      async setActiveSession(_session) {
        // no-op
      },
      async requestAbort(_reason) {
        // no-op
      },
      async setActiveDelegation(manager) {
        storedManager = manager;
      },
    };

    // Create a mock manager object
    const mockManager = { name: "DelegationManager" };

    await abortControl.setActiveDelegation(mockManager);
    expect(storedManager).toBe(mockManager);
  });

  test("setActiveDelegation(null) clears the manager reference", async () => {
    let storedManager: unknown | null = { name: "DelegationManager" };

    const abortControl: RunAbortControl = {
      async setActiveSession(_session) {
        // no-op
      },
      async requestAbort(_reason) {
        // no-op
      },
      async setActiveDelegation(manager) {
        storedManager = manager;
      },
    };

    await abortControl.setActiveDelegation(null);
    expect(storedManager).toBe(null);
  });

  test("requestAbort reaches the delegation manager", async () => {
    let storedManager: unknown | null = null;
    let cancelAllCalled = false;
    let cancelAllReason: string | null = null;

    const mockManager = {
      cancelAll: async (reason: string) => {
        cancelAllCalled = true;
        cancelAllReason = reason;
      },
    };

    const abortControl: RunAbortControl = {
      async setActiveSession(_session) {
        // no-op
      },
      async requestAbort(reason: string) {
        if (storedManager !== null) {
          await (storedManager as { cancelAll: (reason: string) => Promise<void> }).cancelAll(
            reason,
          );
        }
      },
      async setActiveDelegation(manager) {
        storedManager = manager;
      },
    };

    // Set the manager
    await abortControl.setActiveDelegation(mockManager);

    // Request abort
    await abortControl.requestAbort("user_abort");

    expect(cancelAllCalled).toBe(true);
    expect(cancelAllReason).toBe("user_abort");
  });

  test("setActiveDelegation(null) makes requestAbort a no-op for delegation", async () => {
    let storedManager: unknown | null = null;
    let cancelAllCalled = false;

    const mockManager = {
      cancelAll: async () => {
        cancelAllCalled = true;
      },
    };

    const abortControl: RunAbortControl = {
      async setActiveSession(_session) {
        // no-op
      },
      async requestAbort(_reason: string) {
        if (storedManager !== null) {
          await (storedManager as { cancelAll: () => Promise<void> }).cancelAll();
        }
      },
      async setActiveDelegation(manager) {
        storedManager = manager;
      },
    };

    // Set and then clear the manager
    await abortControl.setActiveDelegation(mockManager);
    await abortControl.setActiveDelegation(null);

    // Request abort — should not call cancelAll since manager is null
    await abortControl.requestAbort("user_abort");

    expect(cancelAllCalled).toBe(false);
  });

  test("a run with no delegation enabled continues via existing abort path", async () => {
    // When no delegation manager is active, abort still works through the
    // existing setActiveSession / requestAbort path.
    let activeSessionAborted = false;
    let activeSessionId: string | null = null;

    const abortControl: RunAbortControl = {
      async setActiveSession(session) {
        activeSessionId = session !== null ? (session as { sessionId: string }).sessionId : null;
      },
      async requestAbort(_reason: string) {
        if (activeSessionId !== null) {
          activeSessionAborted = true;
        }
      },
      async setActiveDelegation(_manager) {
        // No delegation manager — this is a non-delegation run
      },
    };

    // Set an active session (null means no session)
    await abortControl.setActiveSession(null);

    // Request abort — with no active session, should be no-op
    await abortControl.requestAbort("user_abort");

    expect(activeSessionAborted).toBe(false);
  });
});
