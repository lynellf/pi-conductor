import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  observeMacWorkloadOutcome,
  parseMacWorkloadOutcome,
} from "../../src/host/execution/macos/command-transport.js";

const exited = { version: 1, kind: "exited", exitCode: 0, signal: null };

describe("private Darwin workload outcome protocol", () => {
  it.each([
    { frame: exited, expected: { kind: "exited", exitCode: 0, signal: null } },
    { frame: { ...exited, exitCode: 7 }, expected: { kind: "exited", exitCode: 7, signal: null } },
    {
      frame: { ...exited, exitCode: null, signal: "SIGPIPE" },
      expected: { kind: "exited", exitCode: null, signal: "SIGPIPE" },
    },
    { frame: { version: 1, kind: "spawn_failed" }, expected: { kind: "spawn_failed" } },
  ])("accepts one closed frame: $frame", ({ frame, expected }) => {
    expect(parseMacWorkloadOutcome(frame)).toEqual(expected);
  });

  it.each([
    null,
    [],
    {},
    { ...exited, version: 2 },
    { ...exited, kind: "other" },
    { ...exited, extra: true },
    { __proto__: { version: 1 }, kind: "exited", exitCode: 0, signal: null, extra: true },
    { ...exited, exitCode: -1 },
    { ...exited, exitCode: 256 },
    { ...exited, exitCode: 0.5 },
    { ...exited, exitCode: "0" },
    { ...exited, exitCode: null },
    { ...exited, signal: "SIGPIPE" },
    { ...exited, exitCode: null, signal: "INVALID" },
    { version: 1, kind: "spawn_failed", extra: true },
  ])("rejects an ambiguous or malformed frame: %j", (frame) => {
    expect(parseMacWorkloadOutcome(frame)).toBeNull();
  });

  // Only the five stdio slots are used; an actual child is unnecessary for stream decoding.
  function capture() {
    const status = new PassThrough();
    const child = {
      stdio: [null, null, null, null, status],
    } as unknown as ChildProcessWithoutNullStreams;
    return { status, outcome: observeMacWorkloadOutcome(child) };
  }

  it("waits for EOF and decodes a split private frame", async () => {
    const { status, outcome } = capture();
    status.write('{"version":1,"kind":"exited",');
    expect(outcome()).toBeNull();
    status.end('"exitCode":0,"signal":null}');
    await new Promise<void>((resolve) => status.once("end", resolve));
    expect(outcome()).toEqual({ kind: "exited", exitCode: 0, signal: null });
  });

  it.each([
    "",
    "spawn_failed",
    "{}",
    `${JSON.stringify(exited)}${JSON.stringify(exited)}`,
    " ".repeat(1025) + JSON.stringify(exited),
  ])("never turns missing, malformed, duplicate, or oversized status into success", async (payload) => {
    const { status, outcome } = capture();
    status.end(payload);
    await new Promise<void>((resolve) => status.once("end", resolve));
    expect(outcome()).toBeNull();
  });
});
