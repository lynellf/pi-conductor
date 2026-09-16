import { Value } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ControllerMetricsSnapshot,
  controllerResponseSchema,
  encodeControllerRequest,
  validateControllerHostApproval,
} from "../src/host/index.js";
import {
  CONTROLLER_JSON_MAX_BYTES,
  controllerConfigSchema,
  controllerRequestSchema,
  loadControllerHostApproval,
  reconcileControllerActionEffects,
} from "../src/index.js";

describe("controller public API", () => {
  it("exports configuration, protocol, authority, and repair boundaries", () => {
    expect(
      Value.Check(controllerConfigSchema, {
        protocol_version: 1,
        controller_id: "planner",
        runtime_id: "runtime",
        executable: "/bin/planner",
        argv: [],
        adapters: [],
        delegation: {
          allowed_subagents: ["worker"],
          max_children_per_session: 1,
          max_parallel: 1,
        },
      }),
    ).toBe(true);
    expect(controllerRequestSchema).toBeDefined();
    expect(controllerResponseSchema).toBeDefined();
    expect(CONTROLLER_JSON_MAX_BYTES).toBe(1024 * 1024);
    expect(encodeControllerRequest).toBeTypeOf("function");
    expect(loadControllerHostApproval).toBeTypeOf("function");
    expect(validateControllerHostApproval).toBeTypeOf("function");
    expect(reconcileControllerActionEffects).toBeTypeOf("function");
    expectTypeOf<ControllerMetricsSnapshot["coordinatorModelTurns"]>().toEqualTypeOf<0>();
  });
});
