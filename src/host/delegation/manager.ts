/** Active child-session registry — delegation lite §7. */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Owns active child cancellation without involving the FSM. */
export class DelegationManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly abortFailureHandlers = new Map<string, (cause: unknown) => void>();
  private readonly cancelled = new Set<string>();
  private closed = false;

  /** Register a live child session. */
  register(
    childId: string,
    session: AgentSession,
    onAbortFailure?: (cause: unknown) => void,
  ): void {
    this.sessions.set(childId, session);
    if (onAbortFailure !== undefined) this.abortFailureHandlers.set(childId, onAbortFailure);
    if (!this.closed && !this.cancelled.has(childId)) return;
    this.cancelled.add(childId);
    void session.abort().catch((cause: unknown) => onAbortFailure?.(cause));
  }

  /** Stop tracking a child after its sole terminal record is appended. */
  unregister(childId: string): void {
    this.sessions.delete(childId);
    this.abortFailureHandlers.delete(childId);
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
    await Promise.all(
      active.map(([childId, session]) =>
        session.abort().catch((cause: unknown) => this.abortFailureHandlers.get(childId)?.(cause)),
      ),
    );
  }

  /** Abort one owned child without closing admission for unrelated work. */
  async abort(childId: string): Promise<void> {
    this.cancelled.add(childId);
    const session = this.sessions.get(childId);
    if (session === undefined) return;
    await session
      .abort()
      .catch((cause: unknown) => this.abortFailureHandlers.get(childId)?.(cause));
  }
}
