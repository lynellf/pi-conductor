/** Active child-session registry — delegation lite §7. */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Owns active child cancellation without involving the FSM. */
export class DelegationManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly cancelled = new Set<string>();
  private closed = false;

  /** Register a live child session. */
  register(childId: string, session: AgentSession): void {
    this.sessions.set(childId, session);
    if (!this.closed) return;
    this.cancelled.add(childId);
    void session.abort();
  }

  /** Stop tracking a child after its sole terminal record is appended. */
  unregister(childId: string): void {
    this.sessions.delete(childId);
  }

  /** Whether this child was cancelled by a run abort. */
  wasCancelled(childId: string): boolean {
    return this.cancelled.has(childId);
  }

  /** Whether run abort closed further child admission. */
  isClosed(): boolean {
    return this.closed;
  }

  /** Abort all active children before the parent session is signalled (§7). */
  async abortAll(): Promise<void> {
    this.closed = true;
    const active = [...this.sessions.entries()];
    for (const [childId] of active) this.cancelled.add(childId);
    await Promise.all(active.map(([, session]) => session.abort().catch(() => undefined)));
  }
}
