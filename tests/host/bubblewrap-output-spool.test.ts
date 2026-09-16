import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { writeOutputMetadata } from "../../src/host/execution/sandbox/output-metadata.js";
import { readSandboxExecutionOutput } from "../../src/host/execution/sandbox/output-retrieval.js";
import {
  createSandboxOutputSpool,
  type SandboxOutputFile,
  SandboxOutputPersistenceError,
} from "../../src/host/execution/sandbox/output-spool.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "conductor-output-"));
  cleanup.push(root);
  const runStateDir = join(root, "run");
  await mkdir(runStateDir, { mode: 0o700 });
  await chmod(runStateDir, 0o700);
  return { root, runStateDir };
}

async function write(stream: NodeJS.WritableStream, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(bytes, (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
}

describe("private sandbox output spool", () => {
  it("retains a controller v2 origin without inventing a child identity", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      controllerOrigin: {
        kind: "controller_operation",
        controller_id: "repo-controller",
        definition_digest: "a".repeat(64),
        activation_id: "activation-1",
        owner_epoch: 1,
        operation_id: "operation-1",
        operation_kind: "planner",
        action_id: null,
        request_sha256: "b".repeat(64),
      },
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 1024,
    });
    spool.stdout.end();
    spool.stderr.end();
    await spool.finalize();

    expect(spool.attribution).toMatchObject({
      schemaVersion: 2,
      controller_origin: { operation_id: "operation-1" },
    });
    expect(spool.attribution).not.toHaveProperty("childId");
  });

  it("rejects a combined output cap above 64 MiB before creating a spool", async () => {
    const value = await fixture();
    await expect(
      createSandboxOutputSpool({
        ...value,
        runId: "run-1",
        childId: "child-1",
        executionId: "execution-1",
        supervisionId: "supervision-1",
        maxBytes: 64 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow("output cap");
  });

  it("retains complete output beyond its bounded preview with private modes", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 1024,
      previewBytes: 4,
    });
    await write(spool.stdout, Buffer.from("abcdefgh"));
    spool.stdout.end();
    spool.stderr.end();
    const final = await spool.finalize();

    expect(final.capture).toBe("complete");
    expect(final.stdout).toMatchObject({ byteCount: 8, retainedVerified: true });
    expect(spool.previews().stdout).toMatchObject({ data: "abcd", truncated: true });
    const directory = join(value.runStateDir, "sandbox-output", spool.outputRef);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, "stdout.bin"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, "stdout.bin"), "utf8")).toBe("abcdefgh");
  });

  it("enforces one combined cap across concurrent streams and reports capture failure", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 5,
    });
    await Promise.all([
      write(spool.stdout, Buffer.from("abcd")),
      write(spool.stderr, Buffer.from("WXYZ")),
    ]);
    spool.stdout.end();
    spool.stderr.end();
    const final = await spool.finalize();

    expect(final.capture).toBe("incomplete");
    expect(final.stdout.byteCount + final.stderr.byteCount).toBe(5);
    expect(final.stdout).toMatchObject({ retainedVerified: true });
    expect(final.stderr).toMatchObject({ retainedVerified: true });
    await expect(spool.captureFailure).resolves.toBe("cap");
  });

  it("loops partial writes without losing bytes", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 64,
      testWrapFile: (file) => partialFile(file, 2),
    });
    await write(spool.stdout, Buffer.from("partial"));
    spool.stdout.end();
    spool.stderr.end();
    const final = await spool.finalize();
    expect(final.stdout.byteCount).toBe(7);
    expect(final.capture).toBe("complete");
  });

  it("treats impossible write progress as storage failure", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 64,
      testWrapFile: (file, stream) =>
        stream === "stdout" ? { ...file, write: async () => ({ bytesWritten: 1000 }) } : file,
    });
    spool.stdout.end(Buffer.from("short"));
    spool.stderr.end();
    await expect(spool.finalize()).resolves.toMatchObject({ capture: "incomplete" });
    await expect(spool.captureFailure).resolves.toBe("storage");
  });

  it("marks storage failure incomplete, drains, and verifies the actual retained prefix", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 64,
      testWrapFile: (file, stream) => (stream === "stdout" ? failingFile(file) : file),
    });
    await write(spool.stdout, Buffer.from("lost"));
    await write(spool.stdout, Buffer.alloc(1024));
    spool.stdout.end();
    spool.stderr.end();
    const final = await spool.finalize();
    expect(final).toMatchObject({ capture: "incomplete", failure: { category: "storage" } });
    expect(final.stdout).toMatchObject({ retainedVerified: true, byteCount: 0 });
    await expect(spool.captureFailure).resolves.toBe("storage");
  });

  it("finalizes realistic 200 KiB output while keeping previews out of metadata", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 300 * 1024,
    });
    spool.stdout.end(Buffer.alloc(200 * 1024, 97));
    spool.stderr.end();
    const final = await spool.finalize();
    const metadata = await readFile(
      join(value.runStateDir, "sandbox-output", spool.outputRef, "final.json"),
      "utf8",
    );
    expect(final.stdout.byteCount).toBe(200 * 1024);
    expect(spool.previews().stdout.byteCount).toBe(64 * 1024);
    expect(metadata).not.toContain("preview");
  });

  it("validates attribution before filesystem creation", async () => {
    const value = await fixture();
    await expect(
      createSandboxOutputSpool({
        ...value,
        runId: "",
        childId: "child-1",
        executionId: "execution-1",
        supervisionId: "supervision-1",
        maxBytes: 64,
      }),
    ).rejects.toThrow("attribution");
    await expect(lstat(join(value.runStateDir, "sandbox-output"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports cap failure independently of durable settlement", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 1,
    });
    spool.stdout.end(Buffer.from("too long"));
    spool.stderr.end();
    await expect(spool.captureFailure).resolves.toBe("cap");
    await expect(spool.finalize()).resolves.toMatchObject({ capture: "incomplete" });
    await expect(
      readFile(join(value.runStateDir, "sandbox-output", spool.outputRef, "final.json"), "utf8"),
    ).resolves.toContain('"capture":"incomplete"');
  });

  it("returns a typed failure and reports storage failure when final metadata is not durable", async () => {
    const value = await fixture();
    let metadataWrites = 0;
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 64,
      testWriteMetadata: async (path, record) => {
        metadataWrites += 1;
        if (metadataWrites === 2) throw new Error("metadata disk failure");
        await writeOutputMetadata(path, record);
      },
    });
    spool.stdout.end(Buffer.from("retained"));
    spool.stderr.end();
    const failure = await spool.finalize().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SandboxOutputPersistenceError);
    expect(failure).toMatchObject({
      outputRef: spool.outputRef,
      retainedByteCounts: { stdout: 8, stderr: 0 },
    });
    await expect(spool.captureFailure).resolves.toBe("storage");
  });
});

describe("child-scoped sandbox output retrieval", () => {
  it("survives restart and reports a split UTF-8 chunk as base64", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 64,
    });
    await write(spool.stdout, Buffer.from("A😀B"));
    spool.stdout.end();
    spool.stderr.end();
    await spool.finalize();

    const chunk = await readSandboxExecutionOutput({
      runStateDir: value.runStateDir,
      expectedRunId: "run-1",
      expectedChildId: "child-1",
      outputRef: spool.outputRef,
      stream: "stdout",
      offset: 1,
      maxBytes: 2,
    });
    expect(chunk).toMatchObject({
      encoding: "base64",
      data: Buffer.from("😀").subarray(0, 2).toString("base64"),
      byteCount: 2,
      nextOffset: 3,
      eof: false,
    });
  });

  it("retrieves a verified retained prefix after a combined-cap failure", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 5,
    });
    spool.stdout.end(Buffer.from("abcdefgh"));
    spool.stderr.end();
    const final = await spool.finalize();
    expect(final).toMatchObject({
      capture: "incomplete",
      stdout: { byteCount: 5, retainedVerified: true },
    });
    await expect(
      readSandboxExecutionOutput({
        runStateDir: value.runStateDir,
        expectedRunId: "run-1",
        expectedChildId: "child-1",
        outputRef: spool.outputRef,
        stream: "stdout",
        offset: 0,
        maxBytes: 64,
      }),
    ).resolves.toMatchObject({
      encoding: "utf8",
      data: "abcde",
      capture: "incomplete",
      retainedByteCount: 5,
      eof: true,
    });
  });

  it("rejects cross-child, malformed, corrupt, and symlink references", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 64,
    });
    spool.stdout.end(Buffer.from("safe"));
    spool.stderr.end();
    await spool.finalize();
    const base = {
      runStateDir: value.runStateDir,
      expectedRunId: "run-1",
      expectedChildId: "child-1",
      stream: "stdout" as const,
      offset: 0,
      maxBytes: 64,
    };
    await expect(
      readSandboxExecutionOutput({
        ...base,
        expectedChildId: "child-2",
        outputRef: spool.outputRef,
      }),
    ).rejects.toThrow("attribution");
    await expect(
      readSandboxExecutionOutput({ ...base, outputRef: "../../escape" }),
    ).rejects.toThrow("reference");

    const directory = join(value.runStateDir, "sandbox-output", spool.outputRef);
    await rm(join(directory, "stdout.bin"));
    await symlink("/etc/passwd", join(directory, "stdout.bin"));
    await expect(
      readSandboxExecutionOutput({ ...base, outputRef: spool.outputRef }),
    ).rejects.toThrow();
  });

  it("rejects retained bytes whose digest no longer matches metadata", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 64,
    });
    spool.stdout.end(Buffer.from("safe"));
    spool.stderr.end();
    await spool.finalize();
    const path = join(value.runStateDir, "sandbox-output", spool.outputRef, "stdout.bin");
    await chmod(path, 0o600);
    const handle = await import("node:fs/promises").then(({ open }) => open(path, "r+"));
    await handle.write(Buffer.from("evil"), 0, 4, 0);
    await handle.close();
    await expect(
      readSandboxExecutionOutput({
        runStateDir: value.runStateDir,
        expectedRunId: "run-1",
        expectedChildId: "child-1",
        outputRef: spool.outputRef,
        stream: "stdout",
        offset: 0,
        maxBytes: 64,
      }),
    ).rejects.toThrow("digest");
  });

  it("rejects malformed strict metadata and unsafe run-state ancestry", async () => {
    const value = await fixture();
    const spool = await createSandboxOutputSpool({
      ...value,
      runId: "run-1",
      childId: "child-1",
      executionId: "execution-1",
      supervisionId: "supervision-1",
      maxBytes: 64,
    });
    spool.stdout.end();
    spool.stderr.end();
    await spool.finalize();
    const attribution = join(
      value.runStateDir,
      "sandbox-output",
      spool.outputRef,
      "attribution.json",
    );
    const parsed = JSON.parse(await readFile(attribution, "utf8")) as Record<string, unknown>;
    parsed.unexpected = true;
    await writeFile(attribution, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    await expect(
      readSandboxExecutionOutput({
        runStateDir: value.runStateDir,
        expectedRunId: "run-1",
        expectedChildId: "child-1",
        outputRef: spool.outputRef,
        stream: "stdout",
        offset: 0,
        maxBytes: 64,
      }),
    ).rejects.toThrow("attribution");

    const unsafe = await fixture();
    await chmod(unsafe.root, 0o777);
    await expect(
      createSandboxOutputSpool({
        ...unsafe,
        runId: "run-1",
        childId: "child-1",
        executionId: "execution-1",
        supervisionId: "supervision-1",
        maxBytes: 64,
      }),
    ).rejects.toThrow("unsafe");
  });
});

function partialFile(file: SandboxOutputFile, max: number): SandboxOutputFile {
  return {
    ...file,
    write: (bytes, offset, length, position) =>
      file.write(bytes, offset, Math.min(max, length), position),
  };
}

function failingFile(file: SandboxOutputFile): SandboxOutputFile {
  let failed = false;
  return {
    ...file,
    write: async (bytes, offset, length, position) => {
      if (!failed) {
        failed = true;
        throw new Error("disk full");
      }
      return file.write(bytes, offset, length, position);
    },
  };
}
