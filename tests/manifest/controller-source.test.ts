import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { controllerActionSchema } from "../../src/manifest/controller-protocol.js";
import {
  controllerFileInputRefSchema,
  controllerSourcePolicySchema,
  isSafeControllerRepositoryRef,
  isSafeControllerSourcePath,
  sourceRepositoryGrantSchema,
  sourceWorkspaceRefSchema,
  sourceWorkspaceReservationBytes,
  validateControllerFileInputRef,
  validateSourceRepositoryGrant,
} from "../../src/manifest/controller-source.js";

const grant = {
  schema_version: 1,
  id: "repo-source",
  repository: {
    id: "repo",
    canonical_path: "/srv/repos/repo",
    fingerprint: "a".repeat(64),
  },
  allowed_refs: ["refs/heads/main"],
  allowed_paths: ["src", "tests/unit"],
  audience: [{ kind: "controller" }],
  isolated_git_view: true,
  max_source_bytes: 1_048_576,
  max_source_files: 100,
  max_patch_bytes: 65_536,
  max_patch_files: 32,
  max_workspaces: 2,
  max_total_bytes: 128 * 1024 * 1024,
  max_parallel_preparations: 1,
  timeout_ms: 30_000,
} as const;

describe("controller source contracts", () => {
  it("accepts a bounded repository grant and fixed source workspace identity", () => {
    expect(sourceWorkspaceReservationBytes(2 * 1024 * 1024, 100)).toBe(66 * 1024 * 1024);
    expect(Value.Check(sourceRepositoryGrantSchema, grant)).toBe(true);
    expect(
      Value.Check(
        sourceWorkspaceRefSchema,
        `source-workspace/v1/${"a".repeat(64)}/${"b".repeat(64)}`,
      ),
    ).toBe(true);
    expect(
      Value.Check(controllerSourcePolicySchema, {
        source_ids: ["repo-source"],
        max_scratch_bytes: 4096,
        max_file_input_bytes: 65_536,
        max_file_input_files: 4,
        timeout_ms: 30_000,
      }),
    ).toBe(true);
    expect(validateSourceRepositoryGrant(grant)).toEqual([]);
  });

  it.each([
    "../escape",
    "/absolute",
    "foo/../bar",
    "foo/.git/config",
    "foo/*",
    "foo\\bar",
  ])("rejects unsafe source path %s", (path) => {
    expect(isSafeControllerSourcePath(path)).toBe(false);
    expect(validateControllerFileInputRef({ ref: "artifact/v1/x", path })).not.toEqual([]);
  });

  it("rejects duplicate or unsafe grant paths", () => {
    expect(validateSourceRepositoryGrant({ ...grant, allowed_paths: ["src", "src"] })).toContain(
      "source repository grant repeats an allowed path",
    );
    expect(Value.Check(controllerFileInputRefSchema, { ref: "x", path: "../x" })).toBe(false);
  });

  it.each([
    "refs/heads/../secret",
    "refs//main",
    "refs/heads/*",
    "refs/heads\\main",
  ])("rejects unsafe Git ref %s", (ref) => {
    expect(isSafeControllerRepositoryRef(ref)).toBe(false);
    expect(validateSourceRepositoryGrant({ ...grant, allowed_refs: [ref] })).not.toEqual([]);
  });

  it("keeps source identities and input paths opaque to the planner", () => {
    const workspace = `source-workspace/v1/${"a".repeat(64)}/${"b".repeat(64)}`;
    expect(
      Value.Check(controllerActionSchema, {
        kind: "adapter",
        action_id: "validate",
        adapter_id: "adapter",
        input_refs: [],
        source_workspace_ref: workspace,
        file_input_refs: [{ ref: "artifact/v1/a", path: "request/input.json" }],
      }),
    ).toBe(true);
    expect(
      Value.Check(controllerActionSchema, {
        kind: "prepare_source",
        action_id: "prepare",
        source_id: "repo-source",
        repository_ref: "refs/heads/main",
      }),
    ).toBe(true);
    expect(
      Value.Check(controllerActionSchema, {
        kind: "adapter",
        action_id: "validate",
        adapter_id: "adapter",
        input_refs: [],
        file_input_refs: [{ ref: "artifact/v1/a", path: "../escape" }],
      }),
    ).toBe(false);
  });
});
