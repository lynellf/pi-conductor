/** Issue #106 §6 — pure trusted-bootstrap protocol contract. */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  BUBBLEWRAP_BOOTSTRAP_SOURCE,
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

  it("closes inherited high descriptors before READY and before executing the command", async () => {
    const launched = launchDirectBootstrap(
      BUBBLEWRAP_BOOTSTRAP_SOURCE,
      [
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        'for descriptor in 3 4 5 6 255; do test ! -e "/proc/self/fd/$descriptor" || exit 91; done',
      ],
      true,
    );
    try {
      await launched.ready;
      expect(await readdir(`/proc/${launched.child.pid}/fd`)).toEqual(["0", "1", "2", "3", "4"]);
      await end(launched.release, BUBBLEWRAP_RELEASE_FRAME);
      await expect(launched.close).resolves.toEqual({ code: 0, signal: null });
    } finally {
      await settleDirectBootstrap(launched);
    }
  });

  it("preserves hostile and empty argv values through the inner bootstrap", async () => {
    const hostile = "spaces ' double-quote \" and newline\n";
    const launched = launchDirectBootstrap(BUBBLEWRAP_BOOTSTRAP_SOURCE, [
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      `test "$0" = "command zero" && test "$1" = ${bashSingleQuote(hostile)} && test "$2" = ""`,
      "command zero",
      hostile,
      "",
    ]);
    try {
      await launched.ready;
      await end(launched.release, BUBBLEWRAP_RELEASE_FRAME);
      await expect(launched.close).resolves.toEqual({ code: 0, signal: null });
    } finally {
      await settleDirectBootstrap(launched);
    }
  });

  it("fails closed before READY when descriptor enumeration is unavailable", async () => {
    const launched = launchDirectBootstrap(
      BUBBLEWRAP_BOOTSTRAP_SOURCE.replaceAll("/proc/self/fd", "/missing/proc/self/fd"),
      ["/bin/bash", "-c", "exit 91"],
    );
    try {
      await expect(launched.ready).rejects.toThrow("bootstrap closed READY pipe before READY");
      await expect(launched.close).resolves.toEqual({ code: 82, signal: null });
    } finally {
      await settleDirectBootstrap(launched);
    }
  });
});

interface LaunchedDirectBootstrap {
  readonly child: ReturnType<typeof spawn> & { readonly pid: number };
  readonly release: Writable;
  readonly ready: Promise<void>;
  readonly close: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

function launchDirectBootstrap(
  source: string,
  command: readonly [string, ...string[]],
  injectHighDescriptor: boolean = false,
): LaunchedDirectBootstrap {
  const args = injectHighDescriptor
    ? [
        "--noprofile",
        "--norc",
        "-c",
        `exec 255</dev/null; exec /bin/bash --noprofile --norc -c "$1" bootstrap "\${@:2}"`,
        "bootstrap-wrapper",
        source,
        ...command,
      ]
    : ["--noprofile", "--norc", "-c", source, "bootstrap", ...command];
  const child = spawn("/bin/bash", args, {
    env: {},
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  if (child.pid === undefined) throw new Error("bootstrap test spawn returned no PID");
  const typedChild = child as ReturnType<typeof spawn> & { readonly pid: number };
  const stdio: readonly (Readable | Writable | null | undefined)[] = child.stdio;
  const release = stdio[3];
  const ready = stdio[4];
  if (!(release instanceof Writable) || !(ready instanceof Readable)) {
    child.kill("SIGKILL");
    throw new Error("bootstrap test controls are missing");
  }
  child.stdout?.resume();
  child.stderr?.resume();
  return { child: typedChild, release, ready: waitForReady(ready), close: waitForClose(child) };
}

async function settleDirectBootstrap(launched: LaunchedDirectBootstrap): Promise<void> {
  if (launched.child.exitCode === null && launched.child.signalCode === null)
    launched.child.kill("SIGKILL");
  await launched.close.catch(() => undefined);
}

function bashSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function waitForReady(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      frame += chunk;
      if (frame === BUBBLEWRAP_READY_FRAME) resolve();
      else if (!BUBBLEWRAP_READY_FRAME.startsWith(frame))
        reject(new Error(`invalid bootstrap READY frame '${frame}'`));
    });
    stream.once("error", reject);
    stream.once("end", () => reject(new Error("bootstrap closed READY pipe before READY")));
  });
}

function end(stream: Writable, frame: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end(frame, (error?: Error | null) => (error === null ? resolve() : reject(error)));
  });
}

function waitForClose(
  child: ReturnType<typeof spawn>,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
