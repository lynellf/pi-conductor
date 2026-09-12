/** Issue #106 §6 — pure trusted-bootstrap protocol contract. */
import { describe, expect, it } from "vitest";

import {
  BUBBLEWRAP_READY_FRAME,
  BUBBLEWRAP_RELEASE_FRAME,
  BubblewrapStatusParser,
  releaseAfterSandboxReady,
} from "../../src/host/execution/sandbox/bootstrap.js";
import { buildBubblewrapBootstrapArgs } from "../../src/host/execution/sandbox/bootstrap-launcher.js";

class ReleaseWriter {
  readonly frames: string[] = [];
  closed = false;

  constructor(private readonly fail: boolean = false) {}

  async end(frame: string): Promise<void> {
    this.frames.push(frame);
    this.closed = true;
    if (this.fail) throw new Error("release write failed");
  }
}

describe("Bubblewrap trusted bootstrap", () => {
  it("parses status JSON split across arbitrary chunks", () => {
    const parser = new BubblewrapStatusParser();

    expect(parser.push('{ "child-pid": 42, "pid-namespace": 99')).toEqual([]);
    expect(parser.push(' }\n{ "exit-code": 0 }\n')).toEqual([
      { "child-pid": 42, "pid-namespace": 99 },
      { "exit-code": 0 },
    ]);
    expect(parser.finish()).toEqual([]);
  });

  it("rejects an incomplete status frame at EOF", () => {
    const parser = new BubblewrapStatusParser();
    parser.push('{ "child-pid": 42 }');

    expect(() => parser.finish()).toThrow("incomplete Bubblewrap JSON status frame");
  });

  it.each([
    ["malformed JSON", "not-json\n", "invalid Bubblewrap JSON status frame"],
    ["an empty frame", "\n", "empty Bubblewrap JSON status frame"],
  ])("rejects %s", (_name, frame, message) => {
    const parser = new BubblewrapStatusParser();

    expect(() => parser.push(frame)).toThrow(message);
  });

  it.each([
    ["ASCII", "x".repeat(64 * 1024 + 1)],
    ["multibyte UTF-8", "é".repeat(32 * 1024 + 1)],
  ])("bounds partial status frames in bytes with %s input", (_name, frame) => {
    const parser = new BubblewrapStatusParser();

    expect(() => parser.push(frame)).toThrow("Bubblewrap JSON status frame exceeds maximum size");
  });

  it("does not release when durable sandbox-ready persistence fails", async () => {
    const writer = new ReleaseWriter();

    await expect(
      releaseAfterSandboxReady(writer, async () => {
        throw new Error("record append failed");
      }),
    ).rejects.toThrow("record append failed");
    expect(writer.frames).toEqual([""]);
    expect(writer.closed).toBe(true);
  });

  it("releases the exact frame only after persistence succeeds", async () => {
    const writer = new ReleaseWriter();
    const events: string[] = [];

    await releaseAfterSandboxReady(writer, async () => {
      events.push("persisted");
    });

    expect(events).toEqual(["persisted"]);
    expect(writer.frames).toEqual([BUBBLEWRAP_RELEASE_FRAME]);
    expect(writer.closed).toBe(true);
  });

  it("closes the release pipe if writing the release frame fails", async () => {
    const writer = new ReleaseWriter(true);

    await expect(releaseAfterSandboxReady(writer, async () => undefined)).rejects.toThrow(
      "release write failed",
    );
    expect(writer.frames).toEqual([BUBBLEWRAP_RELEASE_FRAME, ""]);
    expect(writer.closed).toBe(true);
  });

  it("builds strict Bubblewrap control-FD arguments without block-fd", () => {
    const args = buildBubblewrapBootstrapArgs({
      runtimePath: "/private/runtime",
      bootstrapPath: "/private/bootstrap.sh",
      writablePath: "/private/writable",
      command: ["/bin/bash", "--noprofile", "--norc", "-c", "printf safe"],
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--json-status-fd",
        "5",
        "--unshare-user",
        "--disable-userns",
        "--unshare-pid",
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--",
        "/bin/bash",
        "/bootstrap.sh",
        "/bin/bash",
      ]),
    );
    expect(args).not.toContain("--block-fd");
    expect(args.slice(args.indexOf("--") + 1)).toEqual([
      "/bin/bash",
      "/bootstrap.sh",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      "printf safe",
    ]);
  });

  it("uses a fixed READY marker distinct from the release frame", () => {
    expect(BUBBLEWRAP_READY_FRAME).toBe("READY\n");
    expect(BUBBLEWRAP_RELEASE_FRAME).toBe("PI_CONDUCTOR_BOOTSTRAP_RELEASE_V1");
  });

  it("preserves an empty non-leading user argv value", () => {
    const args = buildBubblewrapBootstrapArgs({
      runtimePath: "/private/runtime",
      bootstrapPath: "/private/bootstrap.sh",
      writablePath: "/private/writable",
      command: ["/bin/bash", "-c", "", "empty argument"],
    });

    expect(args.slice(args.indexOf("--") + 1)).toEqual([
      "/bin/bash",
      "/bootstrap.sh",
      "/bin/bash",
      "-c",
      "",
      "empty argument",
    ]);
  });
});
