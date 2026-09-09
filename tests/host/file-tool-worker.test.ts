import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertFileToolWorkerRuntime,
  type FileToolWorkerError,
  runFileToolWorker,
} from "../../src/host/execution/file-tool-worker.js";
import { processGroupHasLiveMembers } from "../../src/host/execution/supervised-process-identity.js";

const execFile = promisify(execFileCallback);

describe("runFileToolWorker", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
  });

  async function workspace(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-file-worker-"));
    directories.push(directory);
    return directory;
  }

  function supervision(executionId: string) {
    return {
      executionId,
      timeoutMs: 10_000,
      graceMs: 200,
      onStart: () => undefined,
    };
  }

  it.each([
    ["invalid PI_PACKAGE_DIR", "missing", "package metadata"],
    ["version mismatch", "version", "version mismatch"],
    ["missing root export entry", "entry", "root export is missing"],
  ])("rejects %s during worker preflight", async (_name, fixture, expected) => {
    const root = await workspace();
    const previous = process.env.PI_PACKAGE_DIR;
    try {
      process.env.PI_PACKAGE_DIR = root;
      if (fixture !== "missing") {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({
            name: "@earendil-works/pi-coding-agent",
            version: fixture === "version" ? "0.0.0" : "0.80.6",
            exports: { ".": "./dist/index.js" },
          }),
        );
      }
      await expect(
        Promise.resolve().then(() => assertFileToolWorkerRuntime()),
      ).rejects.toMatchObject({
        code: "file-tool-worker-runtime",
        message: expect.stringContaining(expected),
      } satisfies Partial<FileToolWorkerError>);
    } finally {
      if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
      else process.env.PI_PACKAGE_DIR = previous;
    }
  });

  it("round-trips write and read through the public SDK worker", async () => {
    const cwd = await workspace();
    const content = "quotes: 'single' \"double\"\nsecond line\n";

    const written = await runFileToolWorker({
      toolName: "write",
      toolCallId: "write-1",
      params: { path: "sample.txt", content },
      cwd,
      supervision: supervision("write-1"),
    });
    expect(written.content[0]).toMatchObject({ type: "text" });

    const read = await runFileToolWorker({
      toolName: "read",
      toolCallId: "read-1",
      params: { path: "sample.txt" },
      cwd,
      supervision: supervision("read-1"),
    });
    expect(read.content).toEqual([{ type: "text", text: content }]);
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe(content);
  });

  it("preserves edit details and exposes ls, find, and grep results", async () => {
    const cwd = await workspace();
    await runFileToolWorker({
      toolName: "write",
      toolCallId: "write-2",
      params: { path: "nested.txt", content: "needle\n" },
      cwd,
      supervision: supervision("write-2"),
    });

    const edited = await runFileToolWorker({
      toolName: "edit",
      toolCallId: "edit-1",
      params: { path: "nested.txt", edits: [{ oldText: "needle", newText: "changed" }] },
      cwd,
      supervision: supervision("edit-1"),
    });
    expect(edited.details).toMatchObject({ diff: expect.any(String), patch: expect.any(String) });

    const listing = await runFileToolWorker({
      toolName: "ls",
      toolCallId: "ls-1",
      params: { path: "." },
      cwd,
      supervision: supervision("ls-1"),
    });
    expect(listing.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(listing.content)).toContain("nested.txt");

    const found = await runFileToolWorker({
      toolName: "find",
      toolCallId: "find-1",
      params: { pattern: "*.txt", path: "." },
      cwd,
      supervision: supervision("find-1"),
    });
    expect(JSON.stringify(found.content)).toContain("nested.txt");

    const grepped = await runFileToolWorker({
      toolName: "grep",
      toolCallId: "grep-1",
      params: { pattern: "changed", path: "." },
      cwd,
      supervision: supervision("grep-1"),
    });
    expect(JSON.stringify(grepped.content)).toContain("nested.txt");
  });

  it("fails with a typed error when the SDK tool rejects", async () => {
    const cwd = await workspace();

    await expect(
      runFileToolWorker({
        toolName: "read",
        toolCallId: "missing-1",
        params: { path: "missing.txt" },
        cwd,
        supervision: supervision("missing-1"),
      }),
    ).rejects.toMatchObject({
      code: "file-tool-worker-failed",
    } satisfies Partial<FileToolWorkerError>);
  });

  it("keeps newline and quote framing in a large write", async () => {
    const cwd = await workspace();
    const content = `${"line with 'quotes' and \"newlines\"\n".repeat(1_000)}final\n`;

    await runFileToolWorker({
      toolName: "write",
      toolCallId: "framing-1",
      params: { path: "framing.txt", content },
      cwd,
      supervision: supervision("framing-1"),
    });

    await access(join(cwd, "framing.txt"));
    expect(await readFile(join(cwd, "framing.txt"), "utf8")).toBe(content);
  });

  it("kills a worker blocked in a FIFO write after the SDK write has started", async () => {
    if (process.platform !== "linux") return;
    const cwd = await workspace();
    const fifo = join(cwd, "blocked.fifo");
    await execFile("mkfifo", [fifo]);
    const reader = await open(fifo, constants.O_RDONLY | constants.O_NONBLOCK);

    const worker = runFileToolWorker({
      toolName: "write",
      toolCallId: "fifo-timeout-1",
      params: { path: "blocked.fifo", content: "x".repeat(1_048_576) },
      cwd,
      supervision: {
        executionId: "fifo-timeout-1",
        timeoutMs: 3_000,
        graceMs: 150,
        onStart: () => undefined,
      },
    });

    const probe = Buffer.alloc(1);
    let started = false;
    for (let attempt = 0; attempt < 300 && !started; attempt += 1) {
      try {
        started = (await reader.read(probe, 0, 1, null)).bytesRead > 0;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      }
      if (!started) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const failure = await worker.catch((error: unknown) => error);
    await reader.close();
    expect(failure).toMatchObject({
      code: "supervised-process-timeout",
      cleanup: "confirmed",
    });
    expect(started).toBe(true);
    const identity = (failure as { identity?: { processGroupId: number } }).identity;
    expect(identity).toBeDefined();
    await expect(processGroupHasLiveMembers(identity?.processGroupId ?? -1)).resolves.toBe(false);
  });
});
