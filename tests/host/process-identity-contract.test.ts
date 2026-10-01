import { describe, expect, it } from "vitest";
import {
  ownsProcessGroup,
  ownsProcessIdentity,
  type ProcessIdentity,
} from "../../src/host/execution/process-identity-contract.js";

const original: ProcessIdentity = { pid: 42, startTime: "100", processGroupId: 42 };

describe.each([
  ["group", ownsProcessGroup],
  ["member", ownsProcessIdentity],
] as const)("%s identity representation", (_kind, owns) => {
  it("preserves historical Linux identities without a time-kind field", () => {
    expect(owns({ ...original }, original)).toBe(true);
  });
  it("accepts an exact original Darwin representation", () => {
    expect(
      owns({ ...original, startTimeKind: "mach" }, { ...original, startTimeKind: "mach" }),
    ).toBe(true);
  });
  it("rejects equal numeric births in a different representation", () => {
    expect(
      owns({ ...original, startTimeKind: "wallclock" }, { ...original, startTimeKind: "mach" }),
    ).toBe(false);
  });
});
