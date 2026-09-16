import { describe, expect, it } from "vitest";
import { ControllerActivationFence } from "../../src/host/controller/activation-fence.js";
import type { ControllerActivationStartedRecord } from "../../src/persistence/controller-records.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const activation: ControllerActivationStartedRecord = {
  type: "controller_activation_started",
  schema_version: 1,
  run_id: "run",
  controller_id: "controller",
  definition_digest: "a".repeat(64),
  activation_id: "activation-1",
  owner_epoch: 1,
  previous_activation_id: null,
  reason: "start",
  ts: 1,
};

describe("controller activation fence", () => {
  it.each([
    "owner_epoch",
    "controller_id",
    "definition_digest",
  ] as const)("rejects changed %s even when the activation identifier matches", (field) => {
    const fence = new ControllerActivationFence(activation, () => [activation]);
    const invalid = { ...activation, [field]: field === "owner_epoch" ? 2 : "changed" };
    expect(() => fence.assertAppend(invalid)).toThrow(`${field} mismatch`);
  });
  it("allows committed work to settle through reversible finish but never reopens permanent closure", () => {
    const fence = new ControllerActivationFence(activation, () => [activation]);
    fence.finishPending();
    expect(() => fence.assertOpen()).not.toThrow();
    expect(() => fence.assertPlanningOpen()).toThrow();
    fence.reopen();
    expect(() => fence.assertPlanningOpen()).not.toThrow();
    fence.close();
    expect(() => fence.reopen()).toThrow();
    expect(() => fence.assertOpen()).toThrow();
  });
  it("rejects a late callback after durable owner replacement", () => {
    const records: PersistedRecord[] = [activation];
    const fence = new ControllerActivationFence(activation, () => records);
    records.push({
      ...activation,
      activation_id: "activation-2",
      owner_epoch: 2,
      previous_activation_id: activation.activation_id,
      reason: "resume",
    });
    expect(() => fence.assertOpen()).toThrow("owner epoch");
    expect(() => fence.assertAppend(activation)).toThrow("owner epoch");
  });
});
