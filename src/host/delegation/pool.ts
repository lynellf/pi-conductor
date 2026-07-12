/**
 * Bounded concurrency pool (spec §8, issue #17 §8).
 *
 * Runs a list of async tasks with at most `maxParallel` concurrent,
 * returning results in input order regardless of completion order.
 *
 * One task's rejection does NOT short-circuit the others; the rejected
 * task's result slot holds the rejection.
 *
 * Pure control-flow; no I/O; no SDK imports.
 */

export class PoolConcurrencyError extends Error {
  readonly code = "pool_concurrency_error";
  constructor(maxParallel: number) {
    super(`maxParallel must be a positive finite integer; got ${maxParallel}`);
    this.name = "PoolConcurrencyError";
  }
}

/**
 * Result slot for a pooled task. The slot holds the settled value
 * (success or failure) at the correct index regardless of completion order.
 */
export type PoolResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: unknown };

export interface RunBoundedOptions<T> {
  readonly items: readonly T[];
  readonly maxParallel: number;
  readonly run: (item: T, index: number) => Promise<unknown>;
}

/**
 * Run `items` through `run` with bounded concurrency.
 *
 * Returns results in `items` order. At most `maxParallel` calls to `run`
 * are in-flight simultaneously at any time.
 *
 * One task's rejection does NOT cancel the others. Rejected tasks are
 * returned as `{ ok: false, reason: <error> }`.
 *
 * @throws PoolConcurrencyError if `maxParallel <= 0`.
 */
export async function runBounded<T>(
  opts: RunBoundedOptions<T>,
): Promise<readonly PoolResult<unknown>[]> {
  const { items, maxParallel, run } = opts;

  if (!Number.isFinite(maxParallel) || maxParallel <= 0) {
    throw new PoolConcurrencyError(maxParallel);
  }

  const results = new Array<PoolResult<unknown>>(items.length);
  let nextIndex = 0;

  /**
   * Start the next available task, if any remain.
   * Returns a promise that resolves when this task AND any subsequent
   * chained tasks (via finally) have all resolved.
   */
  const startNext = async (): Promise<void> => {
    if (nextIndex >= items.length) return;
    const current = nextIndex++;
    const item = items[current] as (typeof items)[number];
    try {
      const value = await run(item, current);
      results[current] = { ok: true, value };
    } catch (reason) {
      results[current] = { ok: false, reason };
    }
    // After this task settles, start the next one.
    await startNext();
  };

  // Start `maxParallel` workers. Each worker keeps calling startNext()
  // until no items remain. They interleave via the await in startNext.
  await Promise.all(Array.from({ length: maxParallel }, () => startNext()));

  return results;
}
