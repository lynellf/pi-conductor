/** Live writer and effect fences for one controller activation — issue #115 §4. */
import type { ControllerActivationStartedRecord } from "../../persistence/controller-records.js";
import type { PersistedRecord } from "../../persistence/log.js";

type FenceState = "open" | "finish_pending" | "closing" | "retired";
const settlingRecords = new Set([
  "tool_execution_finished",
  "tool_execution_cleanup_confirmed",
  "subagent_completed",
  "subagent_failed",
  "controller_child_output_failed",
  // Observed effect postconditions remain durable facts while owned cleanup drains.
  "controller_effect_settled",
  "sandbox_output_recorded",
]);

/** Fence all controller effects and appends against the durable current owner. */
export class ControllerActivationFence {
  #state: FenceState = "open";
  constructor(
    readonly activation: ControllerActivationStartedRecord,
    private readonly readRecords: () => readonly PersistedRecord[],
  ) {}
  get state(): FenceState {
    return this.#state;
  }

  /** Allow only this epoch's previously committed effects while finish drains. */
  assertOpen(): void {
    this.assertOwner();
    if (this.#state === "closing" || this.#state === "retired")
      throw new Error("controller activation is permanently closed");
  }
  /** New decisions are forbidden while an ordinary finish is pending. */
  assertPlanningOpen(): void {
    this.assertOpen();
    if (this.#state !== "open") throw new Error("controller finish is pending");
  }
  /** Last synchronous check before the host's append-only persistence boundary. */
  assertAppend(record: PersistedRecord): void {
    this.assertOwner();
    if (!("run_id" in record) || record.run_id !== this.activation.run_id)
      throw new Error("controller append run mismatch");
    if (this.#state === "retired") throw new Error("controller writer is retired");
    this.assertRecordIdentity(record);
    if ("origin" in record && typeof record.origin === "object" && record.origin !== null)
      this.assertRecordIdentity(record.origin);
    if (this.#state === "closing") {
      // Authoritative owned terminals can race closure. Controller success receipts cannot.
      const failureReceipt =
        record.type === "controller_action_receipt" &&
        ["failed", "interrupted", "uncertain", "rejected"].includes(record.outcome);
      if (!settlingRecords.has(record.type) && !failureReceipt)
        throw new Error("controller closure forbids new effects and success receipts");
    }
  }
  /** Prevent new planner decisions while already-committed work settles. */
  finishPending(): void {
    this.assertPlanningOpen();
    this.#state = "finish_pending";
  }
  /** Reopen only after the loop has durably rejected the pending finish. */
  reopen(): void {
    this.assertOwner();
    if (this.#state !== "finish_pending") throw new Error("controller finish cannot reopen");
    this.#state = "open";
  }
  /** Permanently forbid further admission and publication; owned terminals may settle. */
  close(): void {
    if (this.#state !== "retired") this.#state = "closing";
  }
  /** End all write authority after owned cleanup has settled. */
  retire(): void {
    this.#state = "retired";
  }

  private assertRecordIdentity(record: object): void {
    for (const key of [
      "activation_id",
      "owner_epoch",
      "controller_id",
      "definition_digest",
    ] as const) {
      if (key in record && Reflect.get(record, key) !== this.activation[key])
        throw new Error(`controller append ${key} mismatch`);
    }
  }

  private assertOwner(): void {
    const current = [...this.readRecords()]
      .reverse()
      .find((record) => record.type === "controller_activation_started");
    if (
      current?.type !== "controller_activation_started" ||
      current.owner_epoch !== this.activation.owner_epoch ||
      current.activation_id !== this.activation.activation_id ||
      current.definition_digest !== this.activation.definition_digest
    )
      throw new Error("controller owner epoch was replaced or is not durable");
  }
}
