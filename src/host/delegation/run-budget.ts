/**
 * Run delegation budget — phase-3-lifecycle-recovery.md Task 1.
 *
 * A single shared budget object constructed before `hostFactory` and shared by
 * every role turn and the `DelegationManager` for the lifetime of a run.
 *
 * The budget tracks:
 *   1. Persisted terminal spend (from `subagent_completed` / `subagent_failed` records).
 *   2. Pending settled spend (children that have terminaled but whose record append
 *      has not yet succeeded).
 *   3. Reserved spend (admitted but not yet terminal).
 *   4. The one live provider-cost reader for the active parent session.
 *   5. Role-lifetime distinct child IDs for `max_children` enforcement.
 *
 * The budget is **host-owned** and **not** persisted in the FSM reducer.
 * It is reconstructed on resume from persisted records plus the orphan
 * reconciliation result.
 *
 * ## Keyed terminal sync
 *
 * Each child terminal is added once, keyed by `child:${childId}:${attempt}`.
 * The keyed sync prevents double-counting across retries (a retry attempt
 * for the same `child_id` uses `attempt + 1`) and across resume reconciliation
 * (the reconciliation result carries orphan child IDs that have already been
 * terminalized).
 *
 * ## Admission contract
 *
 * - `admitChild` checks `projectedSpend <= cap` where
 *   `projectedSpend = persisted + pending + liveProvider + reserved + requested`.
 * - Admission uses `>` (strictly greater); hard closure uses `>=`.
 * - A failed-closed `max_children_exceeded` rejection creates no start or
 *   terminal.
 *
 * ## Callback ordering
 *
 * The parent/run cap callback is one-shot. It is called only after a durable
 * terminal append. The callback re-entry is guarded by the keyed sync — the
 * same key cannot add spend twice.
 */

import type { PersistedRecord, Role } from "../../index.js";
import type { ChildUsage } from "./manager.js";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Result of `admitChild`. Rejected reasons are mutually exclusive.
 */
export type AdmitResult =
  | { readonly ok: true; readonly childSlot: number }
  | {
      readonly ok: false;
      readonly reason: "max_children_exceeded" | "run_cap_breach" | "parent_cap_breach";
    };

/**
 * Callback fired when a child's terminal usage should be included in
 * the parent/run cap evaluation. The callback is one-shot per terminal
 * key — calling it multiple times for the same key is a no-op.
 */
export type ParentCapCallback = (args: {
  readonly childId: string;
  readonly attempt: number;
  readonly usage: ChildUsage;
  readonly isTerminal: boolean;
}) => void;

/**
 * Callback fired when the parent session's live cost changes. The
 * callback is responsible for re-evaluating the parent cap projection
 * and closing admission if breached.
 */
export type LiveProviderCallback = (args: { readonly providerCost: number }) => void;

// ─── RunDelegationBudget ─────────────────────────────────────────────

export interface RunDelegationBudgetOptions {
  /**
   * Dynamic cap reader for `max_run_cost_usd`. Called on every admission
   * and every terminal to get the current (possibly-overridden) cap.
   */
  readonly getRunCap: () => number | null;
  /**
   * Initial orphan reserved total from reconciliation. Children that were
   * started before a crash but not yet terminal have their reserved amount
   * already spent against the cap.
   */
  readonly orphanReservedTotal?: number;
  /**
   * Callback for parent/run cap re-evaluation after a terminal append.
   */
  readonly onParentCapBreach?: (args: {
    readonly childId: string;
    readonly attempt: number;
    readonly usage: ChildUsage;
    readonly projectedTotal: number;
    readonly cap: number;
  }) => void;
}

export class RunDelegationBudget {
  private readonly getRunCap: () => number | null;
  private readonly onParentCapBreach?: RunDelegationBudgetOptions["onParentCapBreach"];

  /** Set of distinct child IDs that have been admitted (role-lifetime). */
  private readonly admittedChildren = new Set<string>();
  /** Count of admitted children. */
  private admittedCount = 0;

  /** Map of terminal key → amount. Keyed by `child:${childId}:${attempt}`. */
  private readonly settledSpend = new Map<string, number>();
  /** Map of terminal key that failed to append. Retried on next terminal. */
  private readonly pendingSettledSpend = new Map<string, number>();
  /** Map of reservation key → amount. */
  private readonly reservations = new Map<string, number>();
  private reservedTotal = 0;

  /** Live provider cost from the active parent session. */
  private liveProviderCost = 0;
  /** Whether the live provider reader is active (cleared on session terminal). */
  private providerReaderActive = false;

  /** Callback for live provider cost changes. */
  private readonly liveProviderCallbacks: LiveProviderCallback[] = [];

  /** Set of terminal keys that have fired their cap callback (one-shot). */
  private readonly capCallbackFired = new Set<string>();

  constructor(opts: RunDelegationBudgetOptions) {
    this.getRunCap = opts.getRunCap;
    this.onParentCapBreach = opts.onParentCapBreach;
    this.reservedTotal = opts.orphanReservedTotal ?? 0;
  }

  /**
   * Current total spend: persisted + pending settled + reserved + live provider.
   */
  totalSpend(): number {
    let total = 0;
    for (const v of this.settledSpend.values()) total += v;
    for (const v of this.pendingSettledSpend.values()) total += v;
    total += this.reservedTotal;
    total += this.liveProviderCost;
    return total;
  }

  /**
   * Persisted terminal spend only.
   */
  settledSpendTotal(): number {
    let total = 0;
    for (const v of this.settledSpend.values()) total += v;
    return total;
  }

  /**
   * Reserved spend only.
   */
  reservedSpendTotal(): number {
    return this.reservedTotal;
  }

  /**
   * Admit a child for a task. Checks `max_children` first (role-lifetime
   * distinct child IDs), then the run cap.
   *
   * Admission is `projected > cap` → reject. Hard closure is `>=`.
   *
   * @param childId - The child's unique ID (distinct child ID for max_children).
   * @param taskId - The task ID (for logging/debugging).
   * @param reservationAmount - Amount to reserve against the run cap.
   * @param maxChildren - The role's `max_children` from the manifest.
   * @param role - The role this admission is for (for provider reader tracking).
   */
  admitChild(args: {
    readonly childId: string;
    readonly taskId: string;
    readonly reservationAmount: number;
    readonly maxChildren: number;
    readonly role: Role;
  }): AdmitResult {
    const { childId, reservationAmount, maxChildren } = args;

    // Role-lifetime max_children check.
    if (this.admittedChildren.has(childId)) {
      // Same child ID — this is a retry attempt, not a new child. Allowed.
    } else {
      if (this.admittedCount >= maxChildren) {
        return { ok: false, reason: "max_children_exceeded" };
      }
      this.admittedChildren.add(childId);
      this.admittedCount++;
    }

    // Run cap check.
    const projected = this.totalSpend() + reservationAmount;
    const cap = this.getRunCap();
    if (cap !== null && projected > cap) {
      return { ok: false, reason: "run_cap_breach" };
    }

    // Reserve the amount.
    this.reservedTotal += reservationAmount;
    this.reservations.set(`child:${childId}`, reservationAmount);

    return { ok: true, childSlot: this.admittedCount };
  }

  /**
   * Release a reservation without settlement (used when a child fails to start).
   */
  releaseReservation(childId: string): void {
    const amount = this.reservations.get(`child:${childId}`);
    if (amount === undefined) return;
    this.reservations.delete(`child:${childId}`);
    this.reservedTotal -= amount;
  }

  /**
   * Settle a reservation with the child's actual cost. The actual cost
   * replaces the reserved amount in the total.
   *
   * @param childId - The child's unique ID.
   * @param attempt - The attempt number (for keyed sync).
   * @param actualCost - The child's actual total cost.
   */
  settleReservation(childId: string, attempt: number, actualCost: number): void {
    const key = `child:${childId}:${attempt}`;
    const reservedAmount = this.reservations.get(`child:${childId}`);

    // Remove the reservation first.
    if (reservedAmount !== undefined) {
      this.reservations.delete(`child:${childId}`);
      this.reservedTotal -= reservedAmount;
    }

    // Add the actual cost keyed by (child_id, attempt).
    // Idempotent: settling the same key twice is a no-op.
    if (this.settledSpend.has(key)) return;
    this.settledSpend.set(key, actualCost);

    // Fire cap callbacks for this terminal (one-shot per key).
    if (!this.capCallbackFired.has(key)) {
      this.capCallbackFired.add(key);
      const cap = this.getRunCap();
      if (cap !== null) {
        const projected = this.totalSpend();
        if (projected > cap) {
          this.onParentCapBreach?.({
            childId,
            attempt,
            usage: {
              input: 0,
              output: 0,
              cache_read: 0,
              cache_write: 0,
              tokens: 0,
              cost: actualCost,
            },
            projectedTotal: projected,
            cap,
          });
        }
      }
    }
  }

  /**
   * Sync a terminal from persisted records (called on resume). Adds the
   * cost to the keyed settled map (idempotent).
   */
  syncTerminal(childId: string, attempt: number, cost: number): void {
    const key = `child:${childId}:${attempt}`;
    if (this.settledSpend.has(key)) return; // Idempotent.
    this.settledSpend.set(key, cost);
  }

  /**
   * Check whether a terminal key has been synced (for recovery idempotency).
   */
  hasSyncedTerminal(childId: string, attempt: number): boolean {
    return this.settledSpend.has(`child:${childId}:${attempt}`);
  }

  /**
   * Retain pending settled spend when an append fails. The amount stays
   * in `pendingSettledSpend` until the retry succeeds.
   */
  retainPendingSettled(childId: string, attempt: number, cost: number): void {
    const key = `child:${childId}:${attempt}`;
    this.pendingSettledSpend.set(key, cost);
  }

  /**
   * Finalize pending settled spend (append succeeded). Moves from pending
   * to settled and fires callbacks.
   */
  finalizePendingSettled(childId: string, attempt: number): void {
    const key = `child:${childId}:${attempt}`;
    const amount = this.pendingSettledSpend.get(key);
    if (amount === undefined) return;
    this.pendingSettledSpend.delete(key);

    // Add to settled (idempotent).
    if (!this.settledSpend.has(key)) {
      this.settledSpend.set(key, amount);
    }

    // Fire cap callbacks.
    if (!this.capCallbackFired.has(key)) {
      this.capCallbackFired.add(key);
      const cap = this.getRunCap();
      if (cap !== null) {
        const projected = this.totalSpend();
        if (projected > cap) {
          this.onParentCapBreach?.({
            childId,
            attempt,
            usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: amount },
            projectedTotal: projected,
            cap,
          });
        }
      }
    }
  }

  /**
   * Update the live provider cost for the active parent session.
   * Called by the session event handler on every `message_end`.
   */
  updateLiveProviderCost(cost: number): void {
    if (!this.providerReaderActive) return;
    this.liveProviderCost = cost;
    for (const cb of this.liveProviderCallbacks) {
      cb({ providerCost: cost });
    }
  }

  /**
   * Set the live provider reader as active for a role.
   * Called when the parent session starts.
   */
  setProviderReaderActive(role: Role): void {
    this.providerReaderActive = true;
    this.liveProviderCost = 0;
    void role; // Reserved for future use (role tracking).
  }

  /**
   * Clear the live provider reader. Called when the parent session ends.
   * The provider cost is NOT reset here — it is added to the terminal
   * record as the session's final usage. Clearing the reader prevents
   * double-counting on the next role turn.
   */
  clearProviderReader(): void {
    this.providerReaderActive = false;
    // Note: liveProviderCost is NOT reset here. The session's final
    // cost is recorded by the loop as the session's terminal usage.
    // Clearing the reader just prevents the event handler from updating
    // the cost after the session has terminated.
    this.liveProviderCallbacks.length = 0;
  }

  /**
   * Register a live provider cost change callback.
   */
  onLiveProviderChange(cb: LiveProviderCallback): void {
    this.liveProviderCallbacks.push(cb);
  }

  /**
   * Get the count of role-lifetime admitted distinct child IDs.
   */
  admittedChildCount(): number {
    return this.admittedCount;
  }

  /**
   * Get the set of admitted child IDs.
   */
  admittedChildIds(): ReadonlySet<string> {
    return this.admittedChildren;
  }

  /**
   * Reconstruct from persisted records. Called on resume to rebuild the
   * budget from the log.
   */
  static fromRecords(opts: {
    readonly records: readonly PersistedRecord[];
    readonly getChildCost: (childId: string) => number;
    readonly getRunCap: () => number | null;
    readonly orphanReservedTotal?: number;
    readonly onParentCapBreach?: RunDelegationBudgetOptions["onParentCapBreach"];
  }): RunDelegationBudget {
    const budget = new RunDelegationBudget({
      getRunCap: opts.getRunCap,
      orphanReservedTotal: opts.orphanReservedTotal ?? 0,
      ...(opts.onParentCapBreach !== undefined && { onParentCapBreach: opts.onParentCapBreach }),
    });

    const terminalKeys = new Set<string>();
    const childIds = new Set<string>();

    // Sync all terminal records.
    for (const record of opts.records) {
      if (record.type === "subagent_completed" || record.type === "subagent_failed") {
        const key = `child:${record.child_id}:${record.attempt}`;
        if (!terminalKeys.has(key)) {
          terminalKeys.add(key);
          const cost = record.usage?.cost ?? 0;
          budget.syncTerminal(record.child_id, record.attempt, cost);
        }
        childIds.add(record.child_id);
      }
      if (record.type === "subagent_started") {
        childIds.add(record.child_id);
      }
    }

    // Reconstruct admitted child count.
    for (const childId of childIds) {
      budget.admittedChildren.add(childId);
      budget.admittedCount++;
    }

    return budget;
  }
}
