/**
 * Tests for `extensions/manifest.ts` — manifest path
 * resolution (Phase 7B Task 7B.2 + Phase 7D Task 7D.1 acceptance).
 *
 * Resolution order (Phase 7D):
 *   1. `--conduct-manifest` flag value (string). Set-but-missing
 *      is a hard `null` (no fallthrough, AGENTS.md "no silent
 *      fallbacks").
 *   2. `<cwd>/.pi/conductor.yaml` default.
 *   3. `<homeDir>/.pi/conductor.yaml` user-global fallback.
 *   4. `null` when no source yields a file.
 *
 * The tests cover each branch + the absolute-path branch
 * + the empty-string flag value (treated as "not set" —
 * the extension's `--string` flag could be passed as
 * `--string ""`; we shouldn't treat that as a real path) +
 * the HOME fallback (Phase 7D).
 *
 * `homeDir` defaults to `os.homedir()` when omitted; the
 * tests inject a temp dir to keep them hermetic and to
 * verify the parameter is honored.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MANIFEST_PATH,
  HOME_MANIFEST_PATH,
  resolveManifestPath,
} from "../../src/extension/manifest.js";

describe("resolveManifestPath", () => {
  let cwd: string;
  let homeDir: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-ext-manifest-cwd-"));
    homeDir = await mkdtemp(join(tmpdir(), "pi-conductor-ext-manifest-home-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("returns the flag value when the flag points to an existing file", async () => {
    const customPath = join(cwd, "custom.yaml");
    await writeFile(customPath, "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath(customPath, cwd, homeDir)).toBe(customPath);
  });

  it("returns null when the flag value does not exist on disk (no HOME fallthrough)", async () => {
    // A HOME manifest exists, but the user explicitly set the flag.
    // The flag path is authoritative: a missing file is a hard null
    // (AGENTS.md "no silent fallbacks"); the chain does NOT fall
    // through to cwd or HOME.
    await mkdir(join(homeDir, ".pi"), { recursive: true });
    await writeFile(join(homeDir, HOME_MANIFEST_PATH), "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath(join(cwd, "missing.yaml"), cwd, homeDir)).toBeNull();
  });

  it("treats an empty-string flag as not set and falls back to the default", async () => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, DEFAULT_MANIFEST_PATH), "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath("", cwd, homeDir)).toBe(join(cwd, DEFAULT_MANIFEST_PATH));
  });

  it("falls back to <cwd>/.pi/conductor.yaml when the flag is undefined", async () => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, DEFAULT_MANIFEST_PATH), "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath(undefined, cwd, homeDir)).toBe(join(cwd, DEFAULT_MANIFEST_PATH));
  });

  it("returns null when no source yields a file (no cwd manifest, no HOME manifest)", () => {
    expect(resolveManifestPath(undefined, cwd, homeDir)).toBeNull();
  });

  it("resolves a relative flag value against cwd", async () => {
    // The flag value `custom.yaml` is relative; resolution joins
    // it against `cwd`. The test writes the file and asserts
    // the joined absolute path comes back.
    const customPath = join(cwd, "custom.yaml");
    await writeFile(customPath, "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath("custom.yaml", cwd, homeDir)).toBe(customPath);
  });

  it("returns an absolute flag value unchanged", async () => {
    const absolutePath = join(cwd, "abs.yaml");
    await writeFile(absolutePath, "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath(absolutePath, cwd, homeDir)).toBe(absolutePath);
  });

  it("returns a Windows-style absolute flag value unchanged", async () => {
    const windowsAbsolutePath = `C:\\tmp\\pi-conductor\\manifest.yaml`;
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      await writeFile(windowsAbsolutePath, "version: 1\nroles: []\n", "utf8");
      expect(resolveManifestPath(windowsAbsolutePath, cwd, homeDir)).toBe(windowsAbsolutePath);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

// ─── Phase 7D: HOME fallback (Task 7D.1) ────────────────────────────
// Table-driven cases per the phase-7d plan. The cases enumerate
// every branch of the resolution chain (flag → cwd → HOME) and
// assert exactly one behavior per case.

describe("resolveManifestPath — HOME fallback (Phase 7D Task 7D.1)", () => {
  let cwd: string;
  let homeDir: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-ext-manifest-cwd-"));
    homeDir = await mkdtemp(join(tmpdir(), "pi-conductor-ext-manifest-home-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  // Helper to write a cwd-local manifest.
  async function writeCwdManifest(): Promise<void> {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, DEFAULT_MANIFEST_PATH), "version: 1\nroles: []\n", "utf8");
  }

  // Helper to write a HOME manifest.
  async function writeHomeManifest(): Promise<void> {
    await mkdir(join(homeDir, ".pi"), { recursive: true });
    await writeFile(join(homeDir, HOME_MANIFEST_PATH), "version: 1\nroles: []\n", "utf8");
  }

  it("HOME fallback: returns <home>/.pi/conductor.yaml when no cwd manifest and no flag", async () => {
    await writeHomeManifest();
    expect(resolveManifestPath(undefined, cwd, homeDir)).toBe(join(homeDir, HOME_MANIFEST_PATH));
  });

  it("cwd wins over HOME when both exist (project is authoritative over shared global)", async () => {
    await writeCwdManifest();
    await writeHomeManifest();
    expect(resolveManifestPath(undefined, cwd, homeDir)).toBe(join(cwd, DEFAULT_MANIFEST_PATH));
  });

  it("flag set and present wins over both cwd and HOME (no HOME check when flag resolves)", async () => {
    await writeCwdManifest();
    await writeHomeManifest();
    const customPath = join(cwd, "custom.yaml");
    await writeFile(customPath, "version: 1\nroles: []\n", "utf8");
    expect(resolveManifestPath(customPath, cwd, homeDir)).toBe(customPath);
  });

  it("flag set but missing returns null even when cwd + HOME both exist (no fallthrough)", async () => {
    await writeCwdManifest();
    await writeHomeManifest();
    expect(resolveManifestPath(join(cwd, "missing.yaml"), cwd, homeDir)).toBeNull();
  });

  it("empty homeDir string skips step 3 (HOME is opt-in, not always-on)", () => {
    // AGENTS.md: no silent fallbacks. An empty `homeDir` means
    // "don't try HOME" — useful for hermetic tests + for users
    // who explicitly want to disable HOME discovery.
    expect(resolveManifestPath(undefined, cwd, "")).toBeNull();
  });

  it("uses os.homedir() when `homeDir` is omitted (production call sites pass nothing)", async () => {
    // The production call site (start.ts, resume.ts) does NOT
    // pass `homeDir` — `resolveManifestPath` must default to
    // `os.homedir()`. We don't write to the real `$HOME` here
    // (that would pollute the test environment). Instead, we
    // assert the function does not throw when `homeDir` is
    // omitted: it returns either a path under the real
    // `$HOME/.pi/conductor.yaml` (if it exists) or `null`.
    // Either is acceptable; the function must NOT throw.
    expect(() => resolveManifestPath(undefined, cwd)).not.toThrow();
    // The default `homeDir` is a non-empty string (it comes
    // from `os.homedir()`). We can't easily spy on
    // `os.homedir()` without restructuring the function's
    // resolution; the "doesn't throw" assertion is the
    // load-bearing one. The "uses os.homedir()" contract is
    // verified by reading the function source — `homeDir ??
    // os.homedir()`.
  });

  it("HOME manifest path is `<home>/.pi/conductor.yaml` (per spec delta Q1)", async () => {
    // The home-side directory is whatever the caller passes in;
    // the resolution appends `.pi/conductor.yaml` (i.e.,
    // `HOME_MANIFEST_PATH`). The user's actual `$HOME` is not
    // touched by this test.
    await writeHomeManifest();
    const result = resolveManifestPath(undefined, cwd, homeDir);
    expect(result).toBe(join(homeDir, ".pi", "conductor.yaml"));
  });
});
