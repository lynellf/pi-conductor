import { describe, expect, it } from "vitest";
import { getControllerEvents } from "../../src/host/controller/event-page.js";
import type {
  ControllerActionReceiptRecord,
  ControllerActivationStartedRecord,
} from "../../src/persistence/controller-records.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const activation: ControllerActivationStartedRecord = {
  type: "controller_activation_started",
  schema_version: 1,
  run_id: "run",
  controller_id: "controller",
  definition_digest: "a".repeat(64),
  activation_id: "activation",
  owner_epoch: 1,
  reason: "start",
  previous_activation_id: null,
  ts: 1,
};
function readReceipt(index: number): ControllerActionReceiptRecord {
  return {
    type: "controller_action_receipt",
    schema_version: 1,
    run_id: activation.run_id,
    controller_id: activation.controller_id,
    definition_digest: activation.definition_digest,
    activation_id: activation.activation_id,
    owner_epoch: 1,
    action_id: `read-${index}`,
    intent_activation_id: activation.activation_id,
    causal_revision: 1,
    request_sha256: "b".repeat(64),
    kind: "read",
    outcome: "completed",
    operation_id: null,
    result_refs: [],
    diagnostic: null,
    result: { data: "x".repeat(48_000), offset: index },
    ts: index + 2,
  };
}
describe("controller durable event pages", () => {
  it("delivers actual bounded read data across byte-limited pages without dropping facts", () => {
    const records: PersistedRecord[] = [
      activation,
      ...Array.from({ length: 20 }, (_, index) => readReceipt(index)),
    ];
    const first = getControllerEvents(records, activation, null);
    expect(first.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first.events))).toBeLessThan(525_000);
    const second = getControllerEvents(records, activation, first.page_cursor);
    expect(
      [...first.events, ...second.events].filter((event) => event.kind === "action_terminal"),
    ).toHaveLength(20);
    expect(first.events[1]?.payload).toMatchObject({ read_result: { offset: 0 } });
    expect(second.hasMore).toBe(false);
    expect(getControllerEvents(records, activation, second.page_cursor).events).toEqual([]);
  });
  it("rejects a cursor with an altered record digest instead of skipping unconsumed facts", () => {
    expect(() =>
      getControllerEvents([activation], activation, { ordinal: 0, record_digest: "f".repeat(64) }),
    ).toThrow("durable source");
  });
});
