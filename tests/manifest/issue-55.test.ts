import { describe, expect, it } from "vitest";

import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

function manifestWithProjection(projection: string): string {
  return `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: parent
    max_visits: 1
subagents:
  - name: focused
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/focused.md
    workspace:
      projection:
${projection}
`;
}

describe("Issue #55 subagent projection manifest policy", () => {
  it("parses and freezes a valid profile projection policy", () => {
    const manifest = parseManifest(
      manifestWithProjection(`
        required: false
        allowed_paths: [src, tests]
        default_paths: [src/manifest, tests/manifest]`),
    );
    const projection = manifest.subagents?.[0]?.workspace?.projection;

    expect(projection).toEqual({
      required: false,
      allowed_paths: ["src", "tests"],
      default_paths: ["src/manifest", "tests/manifest"],
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection?.allowed_paths)).toBe(true);
    expect(Object.isFrozen(projection?.default_paths)).toBe(true);
    expect(validateManifest(manifest).errors).toEqual([]);
  });

  it("keeps a profile without workspace projection policy unchanged", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: parent
    max_visits: 1
subagents:
  - name: legacy
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/legacy.md
`);

    expect(manifest.subagents?.[0]?.workspace).toBeUndefined();
  });

  it.each([
    ["omitted required", "        allowed_paths: [src]"],
    ["non-boolean required", "        required: yes\n        allowed_paths: [src]"],
    ["missing allowed paths", "        required: true"],
    ["non-array allowed paths", "        required: true\n        allowed_paths: src"],
    ["workspace backend", "      backend: worktree"],
    [
      "additional workspace field",
      "      projection: { required: true, allowed_paths: [src] }\n      shell: none",
    ],
    [
      "additional projection field",
      "        required: true\n        allowed_paths: [src]\n        backend: worktree",
    ],
  ])("rejects ill-shaped %s profile workspace during parsing", (_name, projection) => {
    expect(() => parseManifest(manifestWithProjection(`\n${projection}`))).toThrow(
      ManifestParseError,
    );
  });

  it.each([
    [
      "empty allowed paths",
      "subagent-projection-empty-allowed-paths",
      "required: true\n        allowed_paths: []",
    ],
    [
      "duplicate allowed path",
      "subagent-projection-duplicate-allowed-path",
      "required: true\n        allowed_paths: [src, src]",
    ],
    [
      "unsafe allowed path",
      "subagent-projection-unsafe-allowed-path",
      "required: true\n        allowed_paths: [../secret]",
    ],
    [
      "required policy with defaults",
      "subagent-projection-required-with-defaults",
      "required: true\n        allowed_paths: [src]\n        default_paths: [src]",
    ],
    [
      "unsafe defaults on a required policy",
      "subagent-projection-unsafe-default-path",
      "required: true\n        allowed_paths: [src]\n        default_paths: [../secret]",
    ],
    [
      "non-required policy without defaults",
      "subagent-projection-missing-default-paths",
      "required: false\n        allowed_paths: [src]",
    ],
    [
      "empty defaults",
      "subagent-projection-empty-default-paths",
      "required: false\n        allowed_paths: [src]\n        default_paths: []",
    ],
    [
      "duplicate default path",
      "subagent-projection-duplicate-default-path",
      "required: false\n        allowed_paths: [src]\n        default_paths: [src/a, src/a]",
    ],
    [
      "unsafe default path",
      "subagent-projection-unsafe-default-path",
      "required: false\n        allowed_paths: [src]\n        default_paths: [src/*.ts]",
    ],
    [
      "default outside allowed authority",
      "subagent-projection-default-outside-allowed",
      "required: false\n        allowed_paths: [src]\n        default_paths: [tests]",
    ],
    [
      "over-64 allowed path list",
      "subagent-projection-too-many-allowed-paths",
      `required: true\n        allowed_paths: [${Array.from({ length: 65 }, (_, index) => `path-${index}`).join(", ")}]`,
    ],
    [
      "over-64 default path list",
      "subagent-projection-too-many-default-paths",
      `required: false\n        allowed_paths: [src]\n        default_paths: [${Array.from({ length: 65 }, (_, index) => `src/path-${index}`).join(", ")}]`,
    ],
  ])("reports %s with a typed validation error", (_name, code, projection) => {
    const manifest = parseManifest(manifestWithProjection(`\n        ${projection}`));

    expect(validateManifest(manifest).errors.map((error) => error.code)).toContain(code);
  });
});
