/** Fixed wall deadlines without Node's >2^31-1 delay overflow. */
const MAX_DELAY_MS = 2_147_483_647;

/** Arm bounded timer chunks; early callbacks recheck the original deadline. */
export function armDeadline(deadlineMs: number, expire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let cancelled = false;
  const check = () => {
    if (cancelled) return;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) expire();
    else timer = setTimeout(check, Math.min(MAX_DELAY_MS, remaining));
  };
  timer = setTimeout(check, Math.min(MAX_DELAY_MS, Math.max(0, deadlineMs - Date.now())));
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
