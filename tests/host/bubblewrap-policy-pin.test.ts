import { describe, expect, it } from "vitest";
import {
  assertPinnedSandboxPolicy,
  pinSandboxPolicy,
} from "../../src/host/execution/sandbox/policy-pin.js";

const input = {
  execution: {
    backend: "bubblewrap" as const,
    runtime_root: ".pi/runtime",
    writable_paths: ["src"],
  },
  selectedPaths: ["src/a.ts"],
  trackedPaths: ["src/a.ts", "private/secret.ts"],
};

describe("immutable sandbox policy authority", () => {
  it("resolves defaults and pins the exact projection plus complete tracked set", () => {
    const pin = pinSandboxPolicy(input);
    expect(pin.writableRoots).toEqual([{ path: "src", kind: "directory" }]);
    expect(pin.execution.network).toBe("none");
    expect(pin.toolExecution.timeout_seconds).toBe(300);
    expect(() => assertPinnedSandboxPolicy(JSON.parse(JSON.stringify(pin)))).not.toThrow();
  });

  it("uses canonical authority ordering and ignores caller mutation", () => {
    const mutable = structuredClone(input);
    const pin = pinSandboxPolicy(mutable);
    const reordered = pinSandboxPolicy({
      ...input,
      trackedPaths: [...input.trackedPaths].reverse(),
    });
    mutable.execution.writable_paths.push("private");
    expect(pin.digest).toBe(reordered.digest);
    expect(pin.execution.writable_paths).toEqual(["src"]);
    expect(Object.isFrozen(pin.execution.writable_paths)).toBe(true);
  });

  it.each([
    { execution: { ...input.execution, max_output_bytes: 1024 } },
    { toolExecution: { timeout_seconds: 60 } },
    { selectedPaths: ["src/a.ts", "private/secret.ts"] },
    { trackedPaths: [...input.trackedPaths, "other/file"] },
  ])("binds changed authority to a different digest: %j", (change) => {
    expect(pinSandboxPolicy({ ...input, ...change }).digest).not.toBe(
      pinSandboxPolicy(input).digest,
    );
  });

  it("rejects widening past omitted tracked files and effective projection roots", () => {
    expect(() =>
      pinSandboxPolicy({ ...input, trackedPaths: [...input.trackedPaths, "src/hidden.ts"] }),
    ).toThrow("excluded-descendant");
    expect(() => pinSandboxPolicy({ ...input, projectionRoots: ["src/a.ts"] })).toThrow(
      "outside-projection",
    );
  });

  it.each([
    (pin: ReturnType<typeof pinSandboxPolicy>) => ({ ...pin, extra: true }),
    (pin: ReturnType<typeof pinSandboxPolicy>) => ({
      ...pin,
      execution: { ...pin.execution, network: "host" },
    }),
    (pin: ReturnType<typeof pinSandboxPolicy>) => ({
      ...pin,
      writableRoots: [{ path: "private", kind: "directory" }],
    }),
    (pin: ReturnType<typeof pinSandboxPolicy>) => ({ ...pin, digest: "0".repeat(64) }),
  ])("rejects malformed or changed persisted authority before use", (change) => {
    expect(() => assertPinnedSandboxPolicy(change(pinSandboxPolicy(input)))).toThrow();
  });
});
