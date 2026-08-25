/**
 * Tests for `confine-tools.ts` — T4 confinement factory.
 *
 * Verifies:
 *   1. Only declared tools are exposed (filtering).
 *   2. Read-only roles get no edit/write tools.
 *   3. Paths outside the workspace are rejected (absolute, `..`, symlink escape).
 *   4. Workspace-relative paths succeed.
 *   5. Declared mounts are reachable only through `mounts/<index>/...`.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildConfinedTools,
  ROLE_FILE_TOOL_NAMES,
} from "../../src/host/workspace/confine-tools.js";
import type { Projection } from "../../src/host/workspace/mounts.js";

// ─── Test infrastructure ──────────────────────────────────────────────

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-conductor-confine-tools-"));
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  try {
    await rm(sandbox, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
});

function buildProjection(workspaceRoot: string, mountPaths: string[] = []): Projection {
  return {
    workspaceRoot,
    mounts: mountPaths.map((p) => ({ path: p, writable: true })),
  };
}

function testTools(projection: Projection, declaredTools: readonly string[]) {
  return buildConfinedTools(projection, declaredTools);
}

// ─── Unit tests: filtering ────────────────────────────────────────────

describe("buildConfinedTools — tool filtering", () => {
  it("exposes only file tools from the role's declared set", () => {
    const projection = buildProjection(sandbox);
    const result = testTools(projection, ["read", "grep"]);

    expect(result.activeNames).toEqual(["read", "grep"]);
    expect(result.tools.length).toBe(2);
    expect(result.isReadOnly).toBe(true);
  });

  it("exposes all file tools when role declares them all", () => {
    const projection = buildProjection(sandbox);
    const result = testTools(projection, [...ROLE_FILE_TOOL_NAMES]);

    expect(result.activeNames).toEqual([...ROLE_FILE_TOOL_NAMES]);
    expect(result.tools.length).toBe(ROLE_FILE_TOOL_NAMES.length);
    expect(result.isReadOnly).toBe(false);
  });

  it("returns empty when no file tools are declared", () => {
    const projection = buildProjection(sandbox);
    const result = testTools(projection, ["handoff", "end"]);

    expect(result.activeNames).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.isReadOnly).toBe(true);
  });

  it("returns empty when no tools are declared", () => {
    const projection = buildProjection(sandbox);
    const result = testTools(projection, []);

    expect(result.activeNames).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.isReadOnly).toBe(true);
  });

  it("filters mixed declared tools (file + non-file)", () => {
    const projection = buildProjection(sandbox);
    const result = testTools(projection, ["read", "write", "handoff", "end", "ask_user"]);

    expect(result.activeNames).toEqual(["read", "write"]);
    expect(result.tools.length).toBe(2);
    expect(result.isReadOnly).toBe(false);
  });

  it("identifies read-only when only read/grep/find/ls declared", () => {
    const projection = buildProjection(sandbox);
    const result = testTools(projection, ["read", "grep", "find", "ls"]);

    expect(result.isReadOnly).toBe(true);
  });

  it("identifies writable when edit or write declared", () => {
    const projection = buildProjection(sandbox);

    const editResult = testTools(projection, ["read", "edit"]);
    expect(editResult.isReadOnly).toBe(false);

    const writeResult = testTools(projection, ["read", "write"]);
    expect(writeResult.isReadOnly).toBe(false);
  });
});

// ─── Integration tests: path confinement ───────────────────────────────

async function createFile(subpath: string, content = "test content"): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  const full = join(sandbox, subpath);
  await writeFile(full, content, "utf8");
  return full;
}

async function createDir(subpath: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(sandbox, subpath), { recursive: true });
}

async function getActiveTool(
  result: ReturnType<typeof buildConfinedTools>,
  toolName: string,
): Promise<((...args: never[]) => Promise<AgentToolResult<unknown>>) | null> {
  const tool = result.tools.find((t) => t.name === toolName);
  if (tool === undefined) return null;
  // Narrow: execute is async, always returns a Promise; cast to erase
  // the SDK's generic TDetails/TState from the type.
  return tool.execute as ((...args: never[]) => Promise<AgentToolResult<unknown>>) | null;
}

describe("buildConfinedTools — path confinement", () => {
  let projection: Projection;

  beforeEach(async () => {
    await createFile("inside.txt", "inside content");
    await createDir("subdir");
    await createFile("subdir/nested.txt", "nested content");
    projection = buildProjection(sandbox);
  });

  async function readToolExecute(params: { path: string }): Promise<AgentToolResult<unknown>> {
    const result = buildConfinedTools(projection, ["read"]);
    const readTool = await getActiveTool(result, "read");
    if (readTool === null) throw new Error("read tool not found");
    return (readTool as (...args: unknown[]) => Promise<AgentToolResult<unknown>>)(
      "tool-call-id",
      params,
    );
  }

  async function writeToolExecute(params: {
    path: string;
    content: string;
  }): Promise<AgentToolResult<unknown>> {
    const result = buildConfinedTools(projection, ["write"]);
    const writeTool = await getActiveTool(result, "write");
    if (writeTool === null) throw new Error("write tool not found");
    return (writeTool as (...args: unknown[]) => Promise<AgentToolResult<unknown>>)(
      "tool-call-id",
      params,
    );
  }

  it("succeeds for a path inside the workspace root", async () => {
    const result = await readToolExecute({ path: "inside.txt" });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("inside content"),
      }),
    ]);
  });

  it("succeeds for a path inside a subdirectory", async () => {
    const result = await readToolExecute({ path: "subdir/nested.txt" });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("nested content"),
      }),
    ]);
  });

  it("rejects an absolute path", async () => {
    const result = await readToolExecute({ path: "/etc/passwd" });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("path must be relative"),
      }),
    ]);
  });

  it("rejects a rooted Windows path", async () => {
    const result = await readToolExecute({ path: "\\\\host\\share\\secret.txt" });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("path must be relative"),
      }),
    ]);
  });

  it("rejects a path with `..` traversal", async () => {
    const result = await readToolExecute({ path: "../outside" });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("path must be relative"),
      }),
    ]);
  });

  it("rejects a path escaping via sibling worktree", async () => {
    // Create a sibling directory and try to escape the sandbox.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const sibling = join(tmpdir(), `pi-conductor-sibling-${Date.now()}`);
    await mkdir(sibling);
    await writeFile(join(sibling, "sibling.txt"), "sibling content");

    const result = await readToolExecute({ path: `${sibling}/sibling.txt` });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("path must be relative"),
      }),
    ]);
  });

  it("writes a workspace-relative path", async () => {
    await writeToolExecute({ path: "subdir/written.txt", content: "workspace mutation" });

    const { readFile } = await import("node:fs/promises");
    await expect(readFile(join(sandbox, "subdir/written.txt"), "utf8")).resolves.toBe(
      "workspace mutation",
    );
  });

  it("rejects a path that escapes via `..` to outside the workspace", async () => {
    const result = await writeToolExecute({
      path: "../outside-esc.txt",
      content: "should fail",
    });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("path must be relative"),
      }),
    ]);
  });
});

// ─── Explicit virtual mount routing tests ──────────────────────────────

describe("buildConfinedTools — declared mount routing", () => {
  let mountDir: string;
  let outsideDir: string;
  let projection: Projection;

  beforeEach(async () => {
    const { writeFile } = await import("node:fs/promises");
    mountDir = await mkdtemp(join(tmpdir(), "pi-conductor-declared-mount-"));
    outsideDir = await mkdtemp(join(tmpdir(), "pi-conductor-mount-outside-"));
    await createFile("workspace.txt", "workspace content");
    await writeFile(join(mountDir, "mounted.txt"), "mounted content");
    await writeFile(join(outsideDir, "secret.txt"), "outside content");
    projection = {
      workspaceRoot: sandbox,
      mounts: [{ path: mountDir, writable: false }],
    };
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(mountDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  async function executeTool(
    toolName: "read" | "write",
    params: { path: string; content?: string },
  ): Promise<AgentToolResult<unknown>> {
    const result = buildConfinedTools(projection, [toolName]);
    const tool = await getActiveTool(result, toolName);
    if (tool === null) throw new Error(`${toolName} tool not found`);
    return (tool as (...args: unknown[]) => Promise<AgentToolResult<unknown>>)(
      "tool-call-id",
      params,
    );
  }

  it("reads a separate declared mount only through its virtual prefix", async () => {
    const result = await executeTool("read", { path: "mounts/0/mounted.txt" });

    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("mounted content") }),
    ]);
  });

  it("rejects a declared mount's host absolute path", async () => {
    const result = await executeTool("read", { path: join(mountDir, "mounted.txt") });

    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("path must be relative") }),
    ]);
  });

  it("rejects traversal from a declared mount", async () => {
    const result = await executeTool("read", { path: "mounts/0/../mounted.txt" });

    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("path must be relative") }),
    ]);
  });

  it("refuses a write to a read-only declared mount without changing its file", async () => {
    const result = await executeTool("write", {
      path: "mounts/0/mounted.txt",
      content: "must not be written",
    });

    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("read-only mount") }),
    ]);
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(join(mountDir, "mounted.txt"), "utf8")).resolves.toBe("mounted content");
    await expect(
      readFile(join(sandbox, "mounts", "0", "mounted.txt"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes through a writable declared mount", async () => {
    projection = {
      ...projection,
      mounts: [{ path: mountDir, writable: true }],
    };

    await executeTool("write", {
      path: "mounts/0/mounted.txt",
      content: "mounted mutation",
    });

    const { readFile } = await import("node:fs/promises");
    await expect(readFile(join(mountDir, "mounted.txt"), "utf8")).resolves.toBe("mounted mutation");
  });

  it("rejects a symlink escape from a declared mount", async () => {
    const { symlink } = await import("node:fs/promises");
    await symlink(outsideDir, join(mountDir, "escape"));

    const result = await executeTool("read", { path: "mounts/0/escape/secret.txt" });

    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("outside the projection") }),
    ]);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────

describe("buildConfinedTools — edge cases", () => {
  it("handles a declaration with duplicate file tool names (deduplicates)", () => {
    const projection = buildProjection(sandbox);
    const result = testTools(projection, ["read", "read", "grep"]);

    // The underlying SDK creates two tool entries, but the active names
    // deduplicates via our filter. The factory shouldn't crash.
    expect(result.activeNames).toEqual(["read", "grep"]);
  });

  it("handles declared tools with trailing/leading whitespace (passes through)", () => {
    const projection = buildProjection(sandbox);
    const result = testTools(projection, ["read ", " grep"]);

    // Non-matching tool names are silently filtered out.
    expect(result.activeNames).toEqual([]);
  });
});
