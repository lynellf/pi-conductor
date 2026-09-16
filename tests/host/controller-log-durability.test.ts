import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("flushes directory ancestry at controller promotion even when legacy records created the log", async () => {
  const root = await mkdtemp(join(tmpdir(), "controller-directory-barrier-"));
  const file = join(root, "run.jsonl");
  await writeFile(file, '{"legacy":true}\n');
  try {
    // Isolate built-in instrumentation from Vitest's shared module cache. The helper
    // has only Node imports, so the supported Node runtime can strip its TS directly.
    const code = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.fsyncSync;
      let calls = [];
      fs.fsyncSync = (fd) => {
        calls.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
        original(fd);
      };
      syncBuiltinESMExports();
      const { appendControllerLogRecord } = await import(process.argv[1]);
      appendControllerLogRecord(process.argv[2], '{"controller":true}', true);
      const first = calls;
      calls = [];
      appendControllerLogRecord(process.argv[2], '{"next":true}');
      process.stdout.write(JSON.stringify({ first, next: calls }));
    `;
    const result = await promisify(execFile)(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      code,
      new URL("../../src/host/controller/log-append.ts", import.meta.url).href,
      file,
    ]);
    const observed: { first: string[]; next: string[] } = JSON.parse(result.stdout);
    expect(observed.first[0]).toBe("file");
    expect(observed.first.slice(1).length).toBeGreaterThanOrEqual(2);
    expect(observed.first.slice(1).every((kind) => kind === "directory")).toBe(true);
    expect(observed.next).toEqual(["file"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
