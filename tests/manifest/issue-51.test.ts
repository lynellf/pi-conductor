import { describe, expect, it } from "vitest";

import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

function manifestWithProgressiveDisclosure(
  options: {
    readonly backend?: string;
    readonly tools?: readonly string[];
    readonly initialPaths?: readonly string[];
    readonly allowedPaths?: readonly string[];
  } = {},
) {
  const backend = options.backend ?? "worktree";
  const tools = options.tools ?? ["read", "request_files", "handoff", "end"];
  const initialPaths = options.initialPaths ?? ["src/manifest/types.ts"];
  const allowedPaths = options.allowedPaths ?? ["src/manifest"];

  return parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [read, handoff, end]
  - name: implementer
    max_visits: 1
    tools: [${tools.join(", ")}]
    workspace:
      backend: ${backend}
      progressive_disclosure:
        initial_paths: ${JSON.stringify(initialPaths)}
        allowed_paths: ${JSON.stringify(allowedPaths)}
`);
}

describe("Issue #51 progressive disclosure manifest policy", () => {
  it("parses and freezes a valid worktree policy", () => {
    const manifest = manifestWithProgressiveDisclosure();
    const workspace = manifest.roles[1]?.workspace;
    const policy = workspace?.progressive_disclosure;

    expect(policy).toEqual({
      initial_paths: ["src/manifest/types.ts"],
      allowed_paths: ["src/manifest"],
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy?.initial_paths)).toBe(true);
    expect(Object.isFrozen(policy?.allowed_paths)).toBe(true);
    expect(validateManifest(manifest).errors).toEqual([]);
  });

  it.each([
    [
      "empty initial paths",
      { initialPaths: [], allowedPaths: ["src"] },
      "progressive-disclosure-empty-initial-paths",
    ],
    [
      "empty allowed paths",
      { initialPaths: ["src"], allowedPaths: [] },
      "progressive-disclosure-empty-allowed-paths",
    ],
    [
      "duplicate initial path",
      { initialPaths: ["src", "src"], allowedPaths: ["src"] },
      "progressive-disclosure-duplicate-initial-path",
    ],
    [
      "duplicate allowed path",
      { initialPaths: ["src"], allowedPaths: ["src", "src"] },
      "progressive-disclosure-duplicate-allowed-path",
    ],
    [
      "unsafe initial path",
      { initialPaths: ["../secrets"], allowedPaths: ["src"] },
      "progressive-disclosure-unsafe-initial-path",
    ],
    [
      "unsafe allowed path",
      { initialPaths: ["src"], allowedPaths: ["src/*.ts"] },
      "progressive-disclosure-unsafe-allowed-path",
    ],
    [
      "Windows drive-relative initial path",
      { initialPaths: ["C:..\\outside"], allowedPaths: ["src"] },
      "progressive-disclosure-unsafe-initial-path",
    ],
    [
      "Windows drive-relative allowed path",
      { initialPaths: ["src"], allowedPaths: ["C:..\\outside"] },
      "progressive-disclosure-unsafe-allowed-path",
    ],
    ["non-worktree backend", { backend: "copy" }, "progressive-disclosure-non-worktree-backend"],
  ])("rejects %s with a typed validation error", (_name, options, expectedCode) => {
    const manifest = manifestWithProgressiveDisclosure(options);
    const codes = validateManifest(manifest).errors.map((error) => error.code);

    expect(codes).toContain(expectedCode);
  });

  it("accepts a static progressive projection without the optional request_files capability", () => {
    const manifest = manifestWithProgressiveDisclosure({
      tools: ["read", "handoff", "end"],
    });

    expect(validateManifest(manifest).errors).toEqual([]);
  });

  it.each([
    ["absolute", "/outside"],
    ["home", "~other/project"],
    ["traversal", "src/../secrets"],
    ["glob", "src/*.ts"],
    ["root", "."],
  ])("rejects %s policy-root forms", (_kind, path) => {
    const manifest = manifestWithProgressiveDisclosure({
      initialPaths: ["src"],
      allowedPaths: [path],
    });
    const codes = validateManifest(manifest).errors.map((error) => error.code);

    expect(codes).toContain("progressive-disclosure-unsafe-allowed-path");
  });

  it("rejects a non-array path list during parsing", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: implementer
    max_visits: 1
    tools: [read, request_files]
    workspace:
      backend: worktree
      progressive_disclosure:
        initial_paths: src/manifest/types.ts
        allowed_paths: [src/manifest]
`),
    ).toThrow(ManifestParseError);
  });

  it("leaves a workspace without progressive disclosure unchanged", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: implementer
    max_visits: 1
    workspace:
      backend: worktree
`);

    expect(manifest.roles[1]?.workspace).toEqual({
      backend: "worktree",
      source: "snapshot",
    });
    expect(validateManifest(manifest).errors).toEqual([]);
  });
});
