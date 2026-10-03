import { afterEach, expect, it, vi } from "vitest";
import { armDeadline } from "../../src/host/execution/deadline-timer.js";
import { waitForAdmissionSettlement } from "../../src/host/execution/supervised-process-admission.js";

afterEach(() => vi.useRealTimers());

it("rearms long timer chunks without expiring the original deadline early", async () => {
  vi.useFakeTimers();
  const expire = vi.fn();
  const duration = 2_147_483_647 + 1000;
  const cancel = armDeadline(Date.now() + duration, expire);
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(expire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(999);
  expect(expire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(expire).toHaveBeenCalledTimes(1);
  cancel();
});

it("cancels a rearmed deadline", async () => {
  vi.useFakeTimers();
  const expire = vi.fn();
  const cancel = armDeadline(Date.now() + 2_147_483_647 + 1000, expire);
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  cancel();
  await vi.advanceTimersByTimeAsync(1000);
  expect(expire).not.toHaveBeenCalled();
});

it("does not overflow an unobserved-identity admission wait", async () => {
  vi.useFakeTimers();
  let close!: () => void;
  const closeObserved = new Promise<void>((resolve) => {
    close = resolve;
  });
  let settled = false;
  const promise = waitForAdmissionSettlement({
    closeObserved,
    signal: undefined,
    deadlineMs: Date.now() + 2_592_000_000,
  });
  void promise.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled).toBe(false);
  close();
  await expect(promise).resolves.toBe("closed");
});
