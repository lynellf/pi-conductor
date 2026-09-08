/** Deadline timer and bounded cleanup helpers for executable tool attempts. */

const CLEANUP_ALLOWANCE_MS = 1_000;
const MAX_TIMER_MS = 2_147_483_647;

/** Keep Node timer arguments finite even when a policy uses a safe integer grace value. */
export function timeoutDelay(milliseconds: number): number {
  return Math.min(milliseconds, MAX_TIMER_MS);
}

/** Preserve explicit cleanup evidence across host and worker error types. */
export function hasUnconfirmedCleanup(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "cleanup" in error &&
    (error as { readonly cleanup?: unknown }).cleanup === "unconfirmed"
  );
}

/** Wait for operation settlement after cancellation, bounded by graceful cleanup windows. */
export async function settleWithinCleanupWindow<T>(
  operation: Promise<T>,
  graceSeconds: number,
  setTimer: (timer: ReturnType<typeof setTimeout>) => void,
): Promise<{ readonly settled: boolean; readonly cleanup: "confirmed" | "unconfirmed" }> {
  let settled = false;
  let cleanup: "confirmed" | "unconfirmed" = "confirmed";
  const observed = operation.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      if (hasUnconfirmedCleanup(error)) {
        cleanup = "unconfirmed";
      }
    },
  );
  const cleanupMs = Math.min(
    boundedMilliseconds(graceSeconds) * 2 + CLEANUP_ALLOWANCE_MS,
    MAX_TIMER_MS,
  );
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, cleanupMs);
    setTimer(timer);
  });
  await Promise.race([observed, timeout]);
  return { settled, cleanup: settled ? cleanup : "unconfirmed" };
}

function boundedMilliseconds(seconds: number): number {
  const milliseconds = seconds * 1_000;
  if (!Number.isFinite(milliseconds) || milliseconds < 1) return MAX_TIMER_MS;
  return Math.min(milliseconds, MAX_TIMER_MS);
}
