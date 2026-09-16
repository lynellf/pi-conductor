import { describe, expect, it, vi } from "vitest";

import {
  CONTROLLER_JSON_INPUT_MAX_BYTES,
  createControllerCommandRunner,
} from "../../src/host/controller/controller-command-runner.js";

describe("controller fixed-argv command runner", () => {
  it("accepts a JSON request at the one MiB UTF-8 boundary without loading context", () => {
    const loadVerifiedContext = vi.fn();

    createControllerCommandRunner({
      ...options(),
      request: "x".repeat(CONTROLLER_JSON_INPUT_MAX_BYTES - 2),
      loadVerifiedContext,
    });

    expect(loadVerifiedContext).not.toHaveBeenCalled();
  });

  it("rejects a JSON request above the one MiB UTF-8 boundary", () => {
    expect(() =>
      createControllerCommandRunner({
        ...options(),
        request: "x".repeat(CONTROLLER_JSON_INPUT_MAX_BYTES - 1),
      }),
    ).toThrow("controller JSON exceeds 1 MiB");
  });

  it("rejects a request that JSON cannot encode", () => {
    expect(() => createControllerCommandRunner({ ...options(), request: undefined })).toThrow(
      "controller JSON contains an unsupported primitive",
    );
  });

  it.each([
    ["non-finite number", { value: Number.NaN }, "non-finite number"],
    ["non-plain object", { value: new Date(0) }, "plain objects"],
    ["depth above 32", nested(33), "depth limit"],
  ])("rejects %s before sandbox setup", (_name, request, message) => {
    expect(() => createControllerCommandRunner({ ...options(), request })).toThrow(message);
  });

  it("rejects NUL-bearing fixed argv before setup", () => {
    expect(() =>
      createControllerCommandRunner({ ...options(), argv: ["literal\0argument"] }),
    ).toThrow("sandbox argv must be NUL-free");
  });
});

function options() {
  return {
    binaryPath: "/approved/bwrap",
    approvedBuilds: [],
    runStateDir: "/private/run",
    executable: "/bin/controller",
    argv: ["--fixed"] as const,
    request: { protocol_version: 1 },
    loadVerifiedContext: async () => {
      throw new Error("unit test does not prepare the runner");
    },
  };
}

function nested(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = { value };
  return value;
}
