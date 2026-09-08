/** Bounded arbitration for process identity races at the spawn boundary. */

/** Result of bounded admission arbitration. */
export type AdmissionWaitResult = "closed" | "aborted" | "deadline";

/** Wait for close, caller abort, or the fixed process deadline without extending it. */
export async function waitForAdmissionSettlement(options: {
  readonly closeObserved: Promise<void>;
  readonly signal: AbortSignal | undefined;
  readonly deadlineMs: number;
}): Promise<AdmissionWaitResult> {
  if (options.signal?.aborted) return "aborted";
  const remaining = Math.max(0, options.deadlineMs - Date.now());
  if (remaining === 0) return "deadline";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = () => resolveAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await Promise.race([
      options.closeObserved.then(() => "closed" as const),
      aborted.then(() => "aborted" as const),
      new Promise<AdmissionWaitResult>((resolve) => {
        timer = setTimeout(() => resolve("deadline"), remaining);
      }),
    ]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
