/**
 * Tracks command-context generations across pi session replacement.
 *
 * A command may still be awaiting a run after pi invalidates its extension
 * context. Generation guards let its completion path stop before touching the
 * stale context; a newly-loaded extension gets a fresh generation.
 */
let currentGeneration = 0;

/** Start a context generation and return a guard for callbacks created in it. */
export function createSessionContextGuard(): () => boolean {
  const generation = ++currentGeneration;
  return () => generation === currentGeneration;
}

/** Invalidate callbacks belonging to the current pi session generation. */
export function invalidateSessionContext(): void {
  currentGeneration += 1;
}
