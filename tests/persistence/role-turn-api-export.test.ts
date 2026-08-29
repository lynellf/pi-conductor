/**
 * Public-barrel export guard for the Issue #68 role-turn additions.
 *
 * `RoleTurnRecord` and `RoleTurnTelemetryOptions` are type-only public exports, so
 * this test proves the surface two ways:
 *   - the typed `RoleTurnRecord` / `RoleTurnTelemetryLimits` identifiers resolve at
 *     compile time (see `type Assertions` below), and
 *   - the error classes are exported as runtime values from the public barrel.
 *
 * Keeping the value-level assertions here means a later re-export deletion is caught
 * as a runtime failure, not a silent type-only gap.
 */

import { describe, expect, it } from "vitest";
import type { RoleTurnRecord, RoleTurnTelemetryLimits } from "../../src/index.js";
import {
  RoleTurnConfigurationError,
  RoleTurnRunMismatchError,
  RoleTurnTelemetryLogError,
} from "../../src/index.js";

// Compile-time: these type identifiers must resolve off the public barrel. The values
// are never referenced (they are type-only), so this line exists purely to fail
// typecheck if the public type export is dropped.
type _PublicTypeAssertions = {
  readonly record: RoleTurnRecord;
  readonly limits: RoleTurnTelemetryLimits;
};

describe("Issue #68 public barrel exports", () => {
  it("exports the role-turn error classes as runtime values", () => {
    expect(typeof RoleTurnConfigurationError).toBe("function");
    expect(typeof RoleTurnTelemetryLogError).toBe("function");
    expect(typeof RoleTurnRunMismatchError).toBe("function");
    // They carry the documented names so consumers can discriminate by `instanceof`.
    expect(new RoleTurnConfigurationError("x")).toBeInstanceOf(Error);
    expect(new RoleTurnTelemetryLogError("x")).toBeInstanceOf(Error);
    expect(new RoleTurnRunMismatchError("x")).toBeInstanceOf(Error);
  });

  it("keeps the error classes distinct (no accidental aliasing)", () => {
    expect(RoleTurnConfigurationError).not.toBe(RoleTurnTelemetryLogError);
    expect(RoleTurnTelemetryLogError).not.toBe(RoleTurnRunMismatchError);
    expect(RoleTurnConfigurationError).not.toBe(RoleTurnRunMismatchError);
  });
});
