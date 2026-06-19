/**
 * Tests for `extensions/manifest.ts` — manifest path
 * resolution (Phase 7B Task 7B.2 acceptance).
 *
 * Resolution order:
 *   1. `--conduct-manifest` flag value (string).
 *   2. `<cwd>/.pi/conductor.yaml` default.
 *   3. `null` when neither file exists.
 *
 * The tests cover each branch + the absolute-path branch
 * + the empty-string flag value (treated as "not set" —
 * the extension's `--string` flag could be passed as
 * `--string ""`; we shouldn't treat that as a real path).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_MANIFEST_PATH, resolveManifestPath } from "../../extensions/manifest.js";

describe("resolveManifestPath", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-ext-manifest-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("returns the flag value when the flag points to an existing file", async () => {
    const customPath = join(cwd, "custom.yaml");
    await writeFile(customPath, "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath(customPath, cwd)).toBe(customPath);
  });

  it("returns null when the flag value does not exist on disk", async () => {
    expect(resolveManifestPath(join(cwd, "missing.yaml"), cwd)).toBeNull();
  });

  it("treats an empty-string flag as not set and falls back to the default", async () => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, DEFAULT_MANIFEST_PATH), "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath("", cwd)).toBe(join(cwd, DEFAULT_MANIFEST_PATH));
  });

  it("falls back to <cwd>/.pi/conductor.yaml when the flag is undefined", async () => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, DEFAULT_MANIFEST_PATH), "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath(undefined, cwd)).toBe(join(cwd, DEFAULT_MANIFEST_PATH));
  });

  it("returns null when neither the flag nor the default exists", () => {
    expect(resolveManifestPath(undefined, cwd)).toBeNull();
  });

  it("resolves a relative flag value against cwd", async () => {
    // The flag value `custom.yaml` is relative; resolution joins
    // it against `cwd`. The test writes the file and asserts
    // the joined absolute path comes back.
    const customPath = join(cwd, "custom.yaml");
    await writeFile(customPath, "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath("custom.yaml", cwd)).toBe(customPath);
  });

  it("returns an absolute flag value unchanged", async () => {
    const absolutePath = join(cwd, "abs.yaml");
    await writeFile(absolutePath, "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath(absolutePath, cwd)).toBe(absolutePath);
  });
});
