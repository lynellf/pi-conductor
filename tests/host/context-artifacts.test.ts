import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  type ResolveContextArtifactBatchOptions,
  resolveContextArtifactBatch,
} from "../../src/host/delegation/context-artifacts.js";
import { DEFAULT_CONTEXT_ARTIFACT_LIMITS } from "../../src/manifest/context-artifact-limits.js";
import type { ContextArtifacts } from "../../src/seam/schema.js";

const execFileAsync = promisify(execFile);
const repositories: string[] = [];

interface Repository {
  readonly path: string;
  readonly baseCommit: string;
  readonly materializedPaths: readonly string[];
}

afterEach(async () => {
  await Promise.all(repositories.map((path) => rm(path, { recursive: true, force: true })));
  repositories.length = 0;
});

async function repository(
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<Repository> {
  const path = await mkdtemp(join(tmpdir(), "pi-conductor-context-artifacts-"));
  repositories.push(path);
  await execFileAsync("git", ["init"], { cwd: path });
  await execFileAsync("git", ["config", "user.email", "issue-60@example.test"], { cwd: path });
  await execFileAsync("git", ["config", "user.name", "Issue 60 Test"], { cwd: path });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(path, ...file.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(path, file), content);
  }
  await execFileAsync("git", ["add", "."], { cwd: path });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: path });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: path });
  return {
    path,
    baseCommit: stdout.trim(),
    materializedPaths: Object.keys(files).sort(),
  };
}

function options(
  repo: Repository,
  artifacts: ContextArtifacts | undefined,
  overrides: Partial<ResolveContextArtifactBatchOptions> = {},
): ResolveContextArtifactBatchOptions {
  return {
    primaryCheckout: repo.path,
    baseCommit: repo.baseCommit,
    materializedParentPaths: repo.materializedPaths,
    limits: DEFAULT_CONTEXT_ARTIFACT_LIMITS,
    tasks: [{ taskId: "task-1", ...(artifacts === undefined ? {} : { artifacts }) }],
    ...overrides,
  };
}

function artifacts(result: Awaited<ReturnType<typeof resolveContextArtifactBatch>>) {
  if (!result.valid) throw new Error(`expected valid resolution: ${JSON.stringify(result.errors)}`);
  return result.tasks[0]?.artifacts ?? [];
}

function codes(result: Awaited<ReturnType<typeof resolveContextArtifactBatch>>): string[] {
  return result.valid ? [] : result.errors.map((error) => error.code);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256")
    .update("pi-conductor/context-artifact/v1\0", "utf8")
    .update(bytes)
    .digest("hex");
}

describe("Issue #60 context artifact canonical resolution", () => {
  it("preserves order, exact text, UTF-8 byte lengths, empty content, and domain-separated digests", async () => {
    const repo = await repository({ "empty.txt": "", "contract.txt": "\uFEFFé\r\n" });
    const result = await resolveContextArtifactBatch(
      options(repo, [
        { id: "inline", source: "inline", text: "e\u0301\r\n" },
        { id: "empty", source: "file", path: "empty.txt" },
        { id: "file", source: "file", path: "contract.txt" },
      ]),
    );
    const resolved = artifacts(result);

    expect(resolved.map((artifact) => artifact.id)).toEqual(["inline", "empty", "file"]);
    expect(resolved.map((artifact) => artifact.text)).toEqual(["e\u0301\r\n", "", "\uFEFFé\r\n"]);
    expect(resolved.map((artifact) => artifact.byte_length)).toEqual([5, 0, 7]);
    expect(resolved.map((artifact) => artifact.sha256)).toEqual([
      digest(new TextEncoder().encode("e\u0301\r\n")),
      digest(new Uint8Array()),
      digest(new TextEncoder().encode("\uFEFFé\r\n")),
    ]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolved.every((artifact) => Object.isFrozen(artifact))).toBe(true);
  });

  it.each([
    ["empty list", [] as unknown as ContextArtifacts, "context-artifact-empty-list"],
    [
      "duplicate IDs",
      [
        { id: "same", source: "inline", text: "a" },
        { id: "same", source: "inline", text: "b" },
      ] as ContextArtifacts,
      "duplicate-context-artifact-id",
    ],
    [
      "duplicate file sources",
      [
        { id: "one", source: "file", path: "contract.txt" },
        { id: "two", source: "file", path: "contract.txt" },
      ] as ContextArtifacts,
      "duplicate-context-artifact-file-source",
    ],
    [
      "unsafe path",
      [{ id: "bad", source: "file", path: "../contract.txt" }] as ContextArtifacts,
      "unsafe-context-artifact-path",
    ],
    [
      "not materialized",
      [{ id: "absent", source: "file", path: "absent.txt" }] as ContextArtifacts,
      "context-artifact-not-materialized",
    ],
    [
      "lone high surrogate",
      [{ id: "bad", source: "inline", text: "\uD800" }] as ContextArtifacts,
      "context-artifact-invalid-inline-text",
    ],
    [
      "lone low surrogate",
      [{ id: "bad", source: "inline", text: "\uDC00" }] as ContextArtifacts,
      "context-artifact-invalid-inline-text",
    ],
  ])("rejects %s with the stable code", async (_name, input, code) => {
    const repo = await repository({ "contract.txt": "contract" });
    expect(codes(await resolveContextArtifactBatch(options(repo, input)))).toContain(code);
  });

  it("applies per-item and aggregate UTF-8 byte limits without truncation", async () => {
    const repo = await repository({ "contract.txt": "contract" });
    const limits = { max_items: 8, max_item_utf8_bytes: 4, max_total_utf8_bytes: 6 };

    const item = await resolveContextArtifactBatch(
      options(repo, [{ id: "large", source: "inline", text: "ééé" }], { limits }),
    );
    const total = await resolveContextArtifactBatch(
      options(
        repo,
        [
          { id: "one", source: "inline", text: "éé" },
          { id: "two", source: "inline", text: "éé" },
        ],
        { limits },
      ),
    );

    expect(codes(item)).toContain("context-artifact-oversized");
    expect(codes(total)).toContain("context-artifact-total-oversized");
  });
});

describe("Issue #60 file source classification and race checks", () => {
  it("rejects missing, symlink, non-regular, invalid UTF-8, and oversized sources", async () => {
    const missing = await repository({ "source.txt": "source" });
    await unlink(join(missing.path, "source.txt"));

    const symlinkRepo = await repository({ "source.txt": "source", "target.txt": "target" });
    await unlink(join(symlinkRepo.path, "source.txt"));
    await symlink("target.txt", join(symlinkRepo.path, "source.txt"));

    const directoryRepo = await repository({ "source.txt": "source" });
    await unlink(join(directoryRepo.path, "source.txt"));
    await mkdir(join(directoryRepo.path, "source.txt"));

    const invalid = await repository({ "source.txt": new Uint8Array([0xff]) });
    const oversized = await repository({ "source.txt": "12345" });
    const descriptor = [{ id: "source", source: "file", path: "source.txt" }] as ContextArtifacts;

    expect(codes(await resolveContextArtifactBatch(options(missing, descriptor)))).toContain(
      "context-artifact-missing",
    );
    expect(codes(await resolveContextArtifactBatch(options(symlinkRepo, descriptor)))).toContain(
      "context-artifact-symlink",
    );
    expect(codes(await resolveContextArtifactBatch(options(directoryRepo, descriptor)))).toContain(
      "context-artifact-not-regular-file",
    );
    expect(codes(await resolveContextArtifactBatch(options(invalid, descriptor)))).toContain(
      "context-artifact-invalid-utf8",
    );
    expect(
      codes(
        await resolveContextArtifactBatch(
          options(oversized, descriptor, {
            limits: { max_items: 8, max_item_utf8_bytes: 4, max_total_utf8_bytes: 4 },
          }),
        ),
      ),
    ).toContain("context-artifact-oversized");
  });

  it("rejects an ancestor symlink and a controlled realpath escape", async () => {
    const ancestor = await repository({ "dir/source.txt": "source", "outside.txt": "outside" });
    await rm(join(ancestor.path, "dir"), { recursive: true });
    await symlink(ancestor.path, join(ancestor.path, "dir"));

    const escaping = await repository({ "source.txt": "source" });
    const descriptor = [{ id: "source", source: "file", path: "source.txt" }] as ContextArtifacts;
    const escaped = await resolveContextArtifactBatch(
      options(escaping, descriptor, {
        testHook: async (stage) => {
          if (stage === "after-source-lstat") {
            await unlink(join(escaping.path, "source.txt"));
            await symlink("/etc/hosts", join(escaping.path, "source.txt"));
          }
        },
      }),
    );

    expect(
      codes(
        await resolveContextArtifactBatch(
          options(ancestor, [{ id: "source", source: "file", path: "dir/source.txt" }], {
            materializedParentPaths: ["dir/source.txt", "outside.txt"],
          }),
        ),
      ),
    ).toContain("context-artifact-symlink");
    expect(codes(escaped)).toContain("context-artifact-realpath-escape");
  });

  it("maps an unavailable pinned Git object to unreadable without OS details", async () => {
    const repo = await repository({ "source.txt": "source" });
    const result = await resolveContextArtifactBatch(
      options(repo, [{ id: "source", source: "file", path: "source.txt" }], {
        baseCommit: "0".repeat(40),
      }),
    );
    if (result.valid) throw new Error("expected unreadable source");
    const unreadable = result.errors.find((error) => error.code === "context-artifact-unreadable");

    expect(unreadable).toEqual({
      code: "context-artifact-unreadable",
      message: "context-artifact-unreadable",
      task_id: "task-1",
      artifact_id: "source",
      path: "source.txt",
    });
  });

  it("detects source identity and clean parent mutations after immutable resolution", async () => {
    const sourceRepo = await repository({ "source.txt": "pinned" });
    const sourceChanged = await resolveContextArtifactBatch(
      options(sourceRepo, [{ id: "source", source: "file", path: "source.txt" }], {
        testHook: async (stage) => {
          if (stage === "before-final-check") {
            await writeFile(join(sourceRepo.path, "source.txt"), "changed");
          }
        },
      }),
    );
    const parentRepo = await repository({ "source.txt": "pinned" });
    const parentChanged = await resolveContextArtifactBatch(
      options(parentRepo, [{ id: "inline", source: "inline", text: "contract" }], {
        testHook: async (stage) => {
          if (stage === "before-final-check") {
            await writeFile(join(parentRepo.path, "untracked.txt"), "changed");
          }
        },
      }),
    );

    expect(codes(sourceChanged)).toContain("context-artifact-changed");
    expect(codes(parentChanged)).toContain("context-artifact-changed");
  });
});
