import { describe, expect, it, vi } from "vitest";

import { exactProcessSettled } from "../../src/host/execution/sandbox/command-runner-cleanup.js";

describe("sandbox command exact settlement", () => {
  it.each([
    "missing",
    "reused",
    "settled",
  ] as const)("accepts explicit %s observation", async (classification) => {
    const classify = vi.fn().mockResolvedValue(classification);
    await expect(exactProcessSettled({ pid: 42, startTime: "100" }, classify)).resolves.toBe(true);
  });

  it("does not turn an observation failure into cleanup confirmation", async () => {
    const classify = vi.fn().mockRejectedValue(new Error("procfs unavailable"));
    await expect(exactProcessSettled({ pid: 42, startTime: "100" }, classify)).resolves.toBe(false);
  });

  it("does not accept a still-live exact identity", async () => {
    const classify = vi.fn().mockResolvedValue("alive");
    await expect(exactProcessSettled({ pid: 42, startTime: "100" }, classify)).resolves.toBe(false);
  });
});
