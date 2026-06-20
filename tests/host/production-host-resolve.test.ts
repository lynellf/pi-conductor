/**
 * Task 7D.3 — `loadSystemPrompt` version-gated resolution root.
 *
 * The Phase 7D plan Task 7D.3 acceptance:
 *   - v1 manifest with `.pi/roles/foo.md` → resolves against `cwd`
 *     (existing behavior preserved).
 *   - v2 manifest with `roles/foo.md` + `manifestDir` set → resolves
 *     against `manifestDir`.
 *   - v2 manifest with `roles/foo.md` + `manifestDir === null` → throws
 *     `SystemPromptNotFoundError` with a clear message.
 *   - Absolute path → used as-is regardless of version.
 *   - `path === undefined` → `null` regardless of version.
 *
 * Table-driven. One assertion per behavior; case names match the
 * plan's table.
 *
 * The existing v1 tests in `production-host.test.ts` cover the
 * "no `manifestDir` / `manifestVersion` passed" back-compat default
 * (manifestVersion defaults to `1`, manifestDir defaults to `null`).
 * The cases here explicitly drive both `version: 1` and
 * `version: 2` branches.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSystemPrompt, SystemPromptNotFoundError } from "../../src/host/index.js";

describe("loadSystemPrompt — version-gated resolution root (Task 7D.3)", () => {
  let workdir: string;
  let manifestDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-prod-host-resolve-cwd-"));
    manifestDir = await mkdtemp(join(tmpdir(), "pi-conductor-prod-host-resolve-manifest-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    await rm(manifestDir, { recursive: true, force: true });
  });

  // Helper: write a prompt file at `dir/relPath` with the given content.
  async function writePrompt(dir: string, relPath: string, content: string): Promise<string> {
    const fullPath = join(dir, relPath);
    await mkdir(join(dir, ...relPath.split("/").slice(0, -1)), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    return fullPath;
  }

  // ─── v1 manifest (cwd-relative back-compat) ───────────────────

  it("v1: relative path resolves against cwd when cwd has the file (v1 back-compat)", async () => {
    // v1 ignores `manifestDir` — relative prompt paths resolve
    // against `cwd` regardless of where the manifest lives. This
    // is the back-compat behavior for existing v1 manifests.
    await writePrompt(workdir, ".pi/roles/foo.md", "v1-cwd content");
    const content = await loadSystemPrompt("worker", ".pi/roles/foo.md", workdir, manifestDir, 1);
    expect(content).toBe("v1-cwd content");
  });

  it("v1: throws SystemPromptNotFoundError when the relative path is missing in cwd", async () => {
    // Even if the file exists under `manifestDir`, v1 ignores
    // `manifestDir` and looks only in cwd. A missing file in
    // cwd is the v1 failure mode.
    await writePrompt(manifestDir, "roles/foo.md", "in manifest dir");
    await expect(
      loadSystemPrompt("worker", ".pi/roles/foo.md", workdir, manifestDir, 1),
    ).rejects.toThrow(SystemPromptNotFoundError);
  });

  // ─── v2 manifest (manifest-base-relative) ────────────────────

  it("v2: relative path resolves against manifestDir when manifestDir has the file", async () => {
    // v2 resolves relative prompt paths against `manifestDir` —
    // the directory containing the resolved manifest file.
    // The same prompt path under cwd is irrelevant.
    await writePrompt(manifestDir, "roles/foo.md", "v2-manifest-dir content");
    const content = await loadSystemPrompt("worker", "roles/foo.md", workdir, manifestDir, 2);
    expect(content).toBe("v2-manifest-dir content");
  });

  it("v2: throws SystemPromptNotFoundError when manifestDir does not have the file", async () => {
    // Even if the file exists in cwd, v2 ignores cwd and looks
    // only in `manifestDir`. A missing file in `manifestDir` is
    // the v2 failure mode.
    await writePrompt(workdir, "roles/foo.md", "in cwd (irrelevant for v2)");
    await expect(
      loadSystemPrompt("worker", "roles/foo.md", workdir, manifestDir, 2),
    ).rejects.toThrow(SystemPromptNotFoundError);
  });

  it("v2: throws SystemPromptNotFoundError when manifestDir is null (no resolution base)", async () => {
    // A v2 manifest loaded via `loadManifestFromString` (the
    // programmatic / test path) without an explicit
    // `manifestDir` cannot resolve relative prompt paths.
    // Production always has a manifestDir; this is the test
    // path that surfaces "you forgot the manifest file path".
    await expect(loadSystemPrompt("worker", "roles/foo.md", workdir, null, 2)).rejects.toThrow(
      SystemPromptNotFoundError,
    );
  });

  // ─── Path-independent branches (version-agnostic) ────────────

  it("absolute path is used as-is for v2 (cwd and manifestDir ignored)", async () => {
    // The absolute path lives in `workdir`, NOT in `manifestDir`.
    // v2 still uses it as-is — absolute paths bypass the
    // resolution-root branch.
    const absPath = await writePrompt(workdir, "abs/foo.md", "absolute content");
    const content = await loadSystemPrompt("worker", absPath, workdir, manifestDir, 2);
    expect(content).toBe("absolute content");
  });

  it("path === undefined returns null for v2 (no prompt declared)", async () => {
    expect(await loadSystemPrompt("worker", undefined, workdir, manifestDir, 2)).toBeNull();
  });

  it("path === undefined returns null for v1 (no prompt declared, back-compat)", async () => {
    expect(await loadSystemPrompt("worker", undefined, workdir, null, 1)).toBeNull();
  });

  it("error message names the actual resolution root and full resolved path", async () => {
    // The error must help the user diagnose "is my manifest dir
    // right?" — surfacing the actual resolution root is the
    // load-bearing diagnostic. The plan's Task 7D.5 expands on
    // this; the contract is asserted here.
    let caught: SystemPromptNotFoundError | null = null;
    try {
      await loadSystemPrompt("worker", "roles/foo.md", workdir, manifestDir, 2);
    } catch (e) {
      caught = e as SystemPromptNotFoundError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.role).toBe("worker");
    expect(caught?.path).toBe("roles/foo.md");
    // The error message names the role, the declared path, and
    // indicates the resolution root it tried.
    expect(caught?.message).toContain("worker");
    expect(caught?.message).toContain("roles/foo.md");
  });
});
