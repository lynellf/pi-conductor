/**
 * Child budget reservation ledger — spec §9 decision 4, §11, phase-3-lifecycle-recovery.md Task 3.1.
 *
 * The ledger tracks reserved `max_child_cost_usd` for each admitted child
 * and settles on terminal. The ledger is consulted before each child is
 * spawned and at every parent terminal evaluation of the run cap.
 *
 * **Separate from parent session-cap admission:** delegated usage is charged
 * to the parent invocation's session budget for admission/cap purposes,
 * while child usage remains in child terminal records so roll-ups do not
 * double count it. This ledger tracks the *reserved* portion of the
 * child's budget against the run cap only — the actual cost is settled
 * from the child's terminal record when it completes.
 *
 * The ledger is **not** persisted in the FSM reducer; it is host-owned
 * and reconstructed at run-start from `subagent_started` records (§11).
 *
 * Idempotent: `settle`/`release` on an unknown reservationId are no-ops.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────

/** Result of a successful reservation. */
export interface ReservationOk {
  readonly ok: true;
  readonly reservationId: string;
}

/** Result of a rejected reservation (run cap would be breached). */
export interface ReservationBreach {
  readonly ok: false;
  readonly reason: "run_cap_would_breach";
}

/** Union of reservation results. */
export type ReservationResult = ReservationOk | ReservationBreach;

// ─── ChildBudgetLedger ─────────────────────────────────────────────────

/**
 * Host-owned budget ledger that tracks reserved `max_child_cost_usd` for each
 * admitted child and settles on terminal.
 *
 * Construction options:
 * - `runCap: number | null` — the orchestrator's `max_run_cost_usd`.
 *   `null` = uncapped; all reserves succeed.
 * - `randomBytes` — for generating reservation IDs. Defaults to
 *   `node:crypto.randomBytes` in production; tests can inject a
 *   deterministic fake.
 * - `initialReserved: number` — for reconstructing the ledger on resume
 *   (§11). Pass the sum of `subagent_started` records with no matching
 *   terminal as the initial reserved total.
 */
export class ChildBudgetLedger {
  private readonly runCap: number | null;
  private readonly randomBytes: (n: number) => Buffer;
  private _reservedTotal: number = 0;
  private readonly reservations: Map<string, number> = new Map();

  constructor(opts: {
    readonly runCap?: number | null;
    readonly randomBytes?: (n: number) => Buffer;
    readonly initialReserved?: number;
  }) {
    this.runCap = opts.runCap ?? null;
    this.randomBytes = opts.randomBytes ?? ((n) => nodeRandomBytes(n));
    this._reservedTotal = opts.initialReserved ?? 0;
  }

  /**
   * Attempt to reserve `amount` for a child.
   *
   * Returns `{ ok: true, reservationId }` if the reservation fits within
   * the run cap. Returns `{ ok: false, reason: "run_cap_would_breach" }`
   * if the reservation would push the total reserved above the cap.
   *
   * An uncapped run (`runCap === null`) always returns `{ ok: true }`.
   */
  reserve(args: { childId: string; amount: number }): ReservationResult {
    const { amount } = args;

    // Uncapped: always succeed.
    if (this.runCap === null) {
      const reservationId = this.makeReservationId();
      this.reservations.set(reservationId, amount);
      this._reservedTotal += amount;
      return { ok: true, reservationId };
    }

    // Would this push us over the cap?
    const nextTotal = this._reservedTotal + amount;
    if (nextTotal > this.runCap) {
      return { ok: false, reason: "run_cap_would_breach" };
    }

    const reservationId = this.makeReservationId();
    this.reservations.set(reservationId, amount);
    this._reservedTotal = nextTotal;
    return { ok: true, reservationId };
  }

  /**
   * Settle a reservation with the child's actual cost.
   *
   * Releases the reservation and adjusts the reserved total.
   * The run cap accounting uses `actualCost` (not the reserved amount)
   * going forward — callers must update their cost tracking accordingly.
   *
   * Idempotent: settling an unknown reservationId is a no-op.
   */
  settle(reservationId: string, actualCost: number): void {
    void actualCost;
    const amount = this.reservations.get(reservationId);
    if (amount === undefined) return;
    this.reservations.delete(reservationId);
    this._reservedTotal -= amount;
  }

  /**
   * Release a reservation without settlement (used on child errors that
   * never produced a terminal).
   *
   * Idempotent: releasing an unknown reservationId is a no-op.
   */
  release(reservationId: string): void {
    const amount = this.reservations.get(reservationId);
    if (amount === undefined) return;
    this.reservations.delete(reservationId);
    this._reservedTotal -= amount;
  }

  /**
   * Sum of currently-reserved amounts.
   *
   * Used by the run-cap evaluator at parent terminal evaluation time.
   */
  reservedTotal(): number {
    return this._reservedTotal;
  }

  // ─── Test helpers ───────────────────────────────────────────────

  /** Number of active reservations. */
  get activeReservationCount(): number {
    return this.reservations.size;
  }

  // ─── Internals ─────────────────────────────────────────────────

  private makeReservationId(): string {
    const bytes = this.randomBytes(8);
    return `rsv-${bytes.toString("hex")}`;
  }
}

// ─── Reconstruction helper ─────────────────────────────────────────────

/**
 * Reconstruct the initial reserved total from persisted `subagent_started`
 * records that have no matching terminal record.
 *
 * Called at run-start / resume to seed the ledger with the residual
 * reserved amount (§11). The sum of `subagent_started` amounts minus
 * the sum of settled terminal amounts equals the residual reserved total.
 *
 * @param startedRecords - `subagent_started` records for this run.
 * @param terminalChildIds - Set of child IDs that have a terminal record
 *   (`subagent_completed` or `subagent_failed`).
 * @param getChildCost - function to look up the child's reserved cost
 *   (e.g., from the manifest policy's `max_child_cost_usd`).
 */
export function reconstructInitialReserved(args: {
  readonly startedRecords: ReadonlyArray<{
    readonly child_id: string;
    readonly attempt: number;
  }>;
  readonly terminalChildIds: ReadonlySet<string>;
  readonly getChildCost: (childId: string) => number;
}): number {
  let total = 0;
  for (const record of args.startedRecords) {
    if (!args.terminalChildIds.has(record.child_id)) {
      total += args.getChildCost(record.child_id);
    }
  }
  return total;
}
