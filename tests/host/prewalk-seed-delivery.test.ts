import { describe, expect, it } from "vitest";
import {
  hasDurablePrewalkSeed,
  type PrewalkDeliveryEntry,
  preparePrewalkSeedDelivery,
  recordPrewalkSeedDelivered,
} from "../../src/host/prewalk-seed-delivery.js";
import {
  materializePrewalkRecord,
  type PrewalkRecord,
} from "../../src/persistence/prewalk-records.js";

function fixture() {
  const entries: PrewalkDeliveryEntry[] = [
    { id: "before", message: { role: "user", content: "seed" } },
  ];
  const records: PrewalkRecord[] = [];
  const executor = {
    conversationId: "physical",
    sessionFile: "/session",
    deliveryHistory: () => entries,
  };
  const persist = (record: PrewalkRecord) => records.push(materializePrewalkRecord(record).record);
  const intent = preparePrewalkSeedDelivery({
    executor,
    seed: "seed",
    runId: "run",
    roleSessionId: "logical",
    persist,
  });
  return { entries, records, executor, persist, intent };
}

describe("Prewalk durable seed outbox", () => {
  it("does not mistake identical earlier task text for delivery", () => {
    const f = fixture();
    expect(hasDurablePrewalkSeed(f.executor, "seed", f.intent)).toBe(false);
    expect(() => recordPrewalkSeedDelivered({ ...f, seed: "seed" })).toThrow(
      "without durably storing",
    );
    expect(f.records.map((record) => record.type)).toEqual(["prewalk_executor_seed_intent"]);
  });
  it.each([
    "seed",
    [{ type: "text", text: "seed" }],
  ])("recognizes exact user content after the boundary: %j", (content) => {
    const f = fixture();
    f.entries.push({ id: "accepted", message: { role: "user", content } });
    recordPrewalkSeedDelivered({ ...f, seed: "seed" });
    expect(f.records.at(-1)?.type).toBe("prewalk_executor_seed_delivered");
  });
  it("rejects a changed branch boundary instead of replaying", () => {
    const f = fixture();
    f.entries.splice(0);
    expect(() => hasDurablePrewalkSeed(f.executor, "seed", f.intent)).toThrow("boundary is absent");
  });
  it("rejects duplicate durable delivery", () => {
    const f = fixture();
    for (const id of ["one", "two"])
      f.entries.push({ id, message: { role: "user", content: "seed" } });
    expect(() => hasDurablePrewalkSeed(f.executor, "seed", f.intent)).toThrow("more than once");
  });
});
