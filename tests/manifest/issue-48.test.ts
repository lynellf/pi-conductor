/**
 * Issue #48 T1 tests — manifest `workspace` + `artifacts` contract.
 *
 * Table-driven tests for every §4 rule (parsing + validation):
 *   Rule 1: absent = shared (defaults, backward compat).
 *   Rule 2: backend: container requires image.
 *   Rule 3: isolated role (≠ shared, ≠ container) with bash/run is a hard error.
 *   Rule 4: shell: container requires backend: container.
 *   Rule 5: backend: copy with auto_patch: true is a hard error.
 *   Rule 6: mount paths non-empty, no duplicates (parse time).
 *   Rule 7: writable absolute mount → warning, capped at `confined`.
 *   Rule 8: artifacts.* values out of range → error.
 *   Backward compat: manifests without workspace/artifacts parse identically.
 */

import { describe, expect, it } from "vitest";

import { parseManifest } from "../../src/manifest/parse.js";
import type { Manifest, RoleConfig } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

// ─── Helpers ────────────────────────────────────────────────────────────

function m(roles: RoleConfig[], version = 1): Manifest {
  return { version, roles };
}

// Base manifest (no workspace/artifacts) — byte-identical baseline.
const BASE_MANIFEST: Manifest = {
  version: 1,
  roles: [
    { name: "orch", is_orchestrator: true, tools: ["read", "bash", "handoff", "end"] },
    { name: "worker", max_visits: 3, tools: ["read", "edit", "handoff", "end"] },
  ],
};

// ─── Parse: workspace and artifacts present ─────────────────────────────

describe("parseManifest: workspace + artifacts (T1 parse)", () => {
  it("parses workspace fields (backend, source, mounts, shell, image, network)", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: implementer
    max_visits: 3
    workspace:
      backend: worktree
      source: ref:feature-branch
      mounts:
        - path: .campaign
          writable: false
        - path: /data/out
          writable: true
      shell: container
      image: docker.io/example/sandbox:latest
      network: none
`);

    const impl = manifest.roles[1];
    expect(impl?.workspace?.backend).toBe("worktree");
    expect(impl?.workspace?.source).toBe("ref:feature-branch");
    const mounts = impl?.workspace?.mounts;
    expect(mounts).toHaveLength(2);
    expect(mounts?.[0]?.path).toBe(".campaign");
    expect(mounts?.[0]?.writable).toBe(false);
    expect(mounts?.[1]?.path).toBe("/data/out");
    expect(mounts?.[1]?.writable).toBe(true);
    expect(impl?.workspace?.shell).toBe("container");
    expect(impl?.workspace?.image).toBe("docker.io/example/sandbox:latest");
    expect(impl?.workspace?.network).toBe("none");
  });

  it("parses artifacts fields (auto_patch, max_file_bytes, max_files)", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: implementer
    max_visits: 3
    artifacts:
      auto_patch: true
      max_file_bytes: 2097152
      max_files: 16
`);

    const impl = manifest.roles[1];
    expect(impl?.artifacts?.auto_patch).toBe(true);
    expect(impl?.artifacts?.max_file_bytes).toBe(2097152);
    expect(impl?.artifacts?.max_files).toBe(16);
  });

  it("parses workspace with defaults (backend: shared, source: snapshot) — missing shell/network omitted", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    workspace:
      mounts:
        - path: .data
          writable: true
`);

    const w = manifest.roles[1];
    expect(w?.workspace?.backend).toBe("shared");
    expect(w?.workspace?.source).toBe("snapshot");
    expect(w?.workspace?.shell).toBeUndefined(); // omitted → defaults to 'none' at runtime
    expect(w?.workspace?.network).toBeUndefined(); // omitted → defaults to 'bridge' at runtime
  });

  it("parses artifacts with non-integer values (parser accepts, validator enforces bounds)", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    artifacts:
      max_file_bytes: 0
      max_files: 100
`);
    const w = manifest.roles[1];
    expect(w?.artifacts?.max_file_bytes).toBe(0); // parser accepts 0
    expect(w?.artifacts?.max_files).toBe(100); // parser accepts 100
  });

  it("rejects workspace with duplicate mount paths", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    workspace:
      mounts:
        - path: .data
          writable: true
        - path: .data
          writable: false
`),
    ).toThrow("duplicate path");
  });

  it("rejects workspace with empty mount path", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    workspace:
      mounts:
        - path: ""
          writable: true
`),
    ).toThrow("must be a non-empty string");
  });

  it("rejects workspace with non-boolean writable", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    workspace:
      mounts:
        - path: .data
          writable: "yes"
`),
    ).toThrow("must be a boolean");
  });

  it("rejects invalid workspace backend", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    workspace:
      backend: workspace
`),
    ).toThrow("must be one of shared, worktree, copy, or container");
  });

  it("rejects invalid workspace source", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    workspace:
      source: fresh
`),
    ).toThrow('must be "snapshot" or "ref:<git-ref>"');
  });

  it("rejects invalid shell policy", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    workspace:
      shell: interactive
`),
    ).toThrow('must be "none" or "container"');
  });

  it("rejects invalid network policy", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    workspace:
      network: host
`),
    ).toThrow('must be "bridge" or "none"');
  });

  // Note: parser accepts max_files values; validation enforces the 64 cap.
  // Covered by the validation test "rule 8: max_files > 64 is an error".
  it("accepts artifacts with max_files > 64 (parser), caught by validator", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    artifacts:
      max_files: 100
`);
    expect(manifest.roles[1]?.artifacts?.max_files).toBe(100);
  });

  // Note: parser accepts artifact values (finite int); validation enforces bounds.
  // Tests for parse-time rejections (invalid types) remain:
  it("rejects artifacts with non-integer max_file_bytes", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    artifacts:
      max_file_bytes: 1.5
`),
    ).toThrow("must be a non-negative integer");
  });

  it("rejects artifacts with non-integer max_files", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    artifacts:
      max_files: 3.5
`),
    ).toThrow("must be a non-negative integer");
  });

  it("omits optional artifacts fields when absent", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    artifacts:
      max_files: 8
`);

    const w = manifest.roles[1];
    expect(w?.artifacts?.auto_patch).toBeUndefined();
    expect(w?.artifacts?.max_file_bytes).toBeUndefined();
    expect(w?.artifacts?.max_files).toBe(8);
  });
});

// ─── Validate: §4 rules (T1 validation) ─────────────────────────────────

describe("validateManifest: issue #48 rules (§4)", () => {
  it("rule 1: manifest without workspace/artifacts is valid (shared defaults)", () => {
    const r = validateManifest(BASE_MANIFEST);
    expect(r.errors).toEqual([]);
  });

  it("rule 2: backend: container without image is a hard error", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        workspace: { backend: "container" },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("container-backend-missing-image");
  });

  it("rule 2: backend: container with image is valid", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        workspace: { backend: "container", image: "docker.io/example/s:latest" },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors).toEqual([]);
  });

  it("rule 3: isolated (worktree) role with bash in tools is a hard error", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        tools: ["read", "edit", "bash", "handoff", "end"],
        workspace: { backend: "worktree" },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("isolated-role-shell-on-non-container");
  });

  it("rule 3: isolated (copy) role with run in tools is a hard error", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        tools: ["read", "edit", "run", "handoff", "end"],
        workspace: { backend: "copy" },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("isolated-role-shell-on-non-container");
  });

  it("rule 3: isolated (worktree) role without bash/run is valid", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "reviewer",
        max_visits: 3,
        tools: ["read", "grep", "handoff", "end"],
        workspace: { backend: "worktree" },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors).toEqual([]);
  });

  it("rule 4: shell: container with backend: worktree is a hard error", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        workspace: { backend: "worktree", shell: "container" },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("container-shell-on-non-container-backend");
  });

  it("rule 4: shell: container with backend: container is valid", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        workspace: { backend: "container", shell: "container", image: "img:latest" },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors).toEqual([]);
  });

  it("rule 5: backend: copy with auto_patch: true is a hard error", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        workspace: { backend: "copy" },
        artifacts: { auto_patch: true },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("copy-backend-auto-patch");
  });

  it("rule 5: backend: copy with auto_patch: false is valid", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        workspace: { backend: "copy" },
        artifacts: { auto_patch: false },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors).toEqual([]);
  });

  it("rule 5: backend: copy with no auto_patch (undefined) is valid", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        workspace: { backend: "copy" },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors).toEqual([]);
  });

  it("rule 6: mount paths non-empty — validated in parser", () => {
    // Handled by parser tests above.
  });

  it("rule 7: writable absolute (host) mount → warning, capped at confined", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        workspace: {
          backend: "worktree",
          mounts: [{ path: "/data/out", writable: true }],
        },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.warnings.map((w) => w.code)).toContain("isolated-role-writable-host-mount");
    expect(r.errors).toEqual([]);
  });

  it("rule 7: read-only absolute (host) mount does NOT trigger warning", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "reviewer",
        max_visits: 3,
        workspace: {
          backend: "worktree",
          mounts: [{ path: "/data/out", writable: false }],
        },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.warnings).toEqual([]);
  });

  it("rule 7: relative writable mount does NOT trigger warning", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        workspace: {
          backend: "worktree",
          mounts: [{ path: ".campaign", writable: true }],
        },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.warnings).toEqual([]);
  });

  it("rule 8: max_file_bytes < 1 is an error (parser accepts, validator enforces)", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        artifacts: { max_file_bytes: 0 },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("invalid-artifact-config");
  });

  it("rule 8: max_files > 64 is an error (parser accepts, validator enforces)", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        artifacts: { max_files: 100 },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("invalid-artifact-config");
  });

  it("rule 8: max_files < 1 is an error (parser accepts, validator enforces)", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        artifacts: { max_files: 0 },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("invalid-artifact-config");
  });

  it("rule 8: valid artifact config is error-free", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "bash", "handoff", "end"],
      },
      {
        name: "implementer",
        max_visits: 3,
        artifacts: { max_file_bytes: 1048576, max_files: 32 },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors).toEqual([]);
  });

  it("backward compat: manifest without workspace/artifacts is valid", () => {
    const r = validateManifest(BASE_MANIFEST);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});
