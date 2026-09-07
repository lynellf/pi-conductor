import { describe, expect, it } from "vitest";

import {
  PrewalkTransformUnsupportedError,
  selectTransferMode,
} from "../../src/manifest/prewalk-transfer.js";
import type { PrewalkConfig } from "../../src/manifest/types.js";

const config = {
  transfer: "native",
  on_preflight_failure: "project",
} as Pick<PrewalkConfig, "transfer" | "on_preflight_failure">;

describe("selectTransferMode", () => {
  it("selects native for a passing cross-vendor preflight", () => {
    expect(selectTransferMode(config, { ok: true }, { transcript_fits: true })).toBe("native");
  });

  it("projects an unrepairable preflight failure under the default policy", () => {
    expect(selectTransferMode(config, { ok: false }, { transcript_fits: true })).toBe("projection");
  });

  it("fails with the stable transform code under the fail policy", () => {
    expect(() =>
      selectTransferMode(
        { ...config, on_preflight_failure: "fail" },
        { ok: false },
        { transcript_fits: true },
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "PrewalkTransformUnsupportedError",
        code: "prewalk_transform_unsupported",
      }),
    );
  });

  it("projects an oversized transcript regardless of failure policy", () => {
    expect(
      selectTransferMode(
        { ...config, on_preflight_failure: "fail" },
        { ok: true },
        { transcript_fits: false },
      ),
    ).toBe("projection");
  });

  it("honors an explicit projection even when native preflight passes", () => {
    expect(
      selectTransferMode(
        { ...config, transfer: "projection" },
        { ok: true },
        { transcript_fits: true },
      ),
    ).toBe("projection");
  });

  it("exports a typed transform failure", () => {
    const error = new PrewalkTransformUnsupportedError();
    expect(error.message).toContain("preflight");
  });
});
