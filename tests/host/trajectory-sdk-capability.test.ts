import { describe, expect, it } from "vitest";

import { TrajectoryHandoffError } from "../../src/host/trajectory-admission.js";
import { assertTrajectorySdkSupported } from "../../src/host/trajectory-sdk-capability.js";

describe("Issue #63 trajectory SDK capability", () => {
  it("accepts only the SDK version exercised by the acknowledged spike", () => {
    expect(() => assertTrajectorySdkSupported("0.80.6")).not.toThrow();
  });

  it("fails closed before trajectory transport on an unproven SDK version", () => {
    expect(() => assertTrajectorySdkSupported("0.80.7")).toThrow(TrajectoryHandoffError);
    expect(() => assertTrajectorySdkSupported("0.80.7")).toThrow(
      "trajectory requires @earendil-works/pi-coding-agent 0.80.6",
    );
  });
});
