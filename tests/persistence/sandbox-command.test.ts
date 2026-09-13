import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertSandboxExecutionTerminal,
  type SandboxExecutionTerminal,
} from "../../src/persistence/sandbox-command.js";

const ref = "22222222-2222-4222-8222-222222222222";
const stream = {
  byteCount: 0,
  retainedVerified: true as const,
  sha256: createHash("sha256").digest("hex"),
};
const complete: SandboxExecutionTerminal = {
  category: "command_status",
  normalized_status: 137,
  signal: "unknown",
  termination_requested: false,
  cleanup: "confirmed",
  output_ref: ref,
  output: { schemaVersion: 1, outputRef: ref, capture: "complete", stdout: stream, stderr: stream },
};
describe("sandbox command terminal evidence", () => {
  it("retains numeric status 137 without claiming a signal", () =>
    expect(() => assertSandboxExecutionTerminal(complete)).not.toThrow());
  it.each([
    ["guessed signal", { ...complete, signal: "SIGKILL" }],
    ["missing status", { ...complete, normalized_status: null }],
    ["extra command data", { ...complete, command: "private command" }],
    ["mismatched ref", { ...complete, output_ref: "33333333-3333-4333-8333-333333333333" }],
    ["unknown cleanup mislabeled complete", { ...complete, cleanup: "unconfirmed" }],
    ["missing retained output", { ...complete, output: undefined }],
  ])("rejects %s", (_name, value) => expect(() => assertSandboxExecutionTerminal(value)).toThrow());
});
