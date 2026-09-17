import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { controllerActionSchema } from "../../src/manifest/controller-protocol.js";
import {
  controllerFileInputRefSchema,
  controllerSourcePolicySchema,
  isSafeControllerRepositoryRef,
  isSafeControllerSourcePath,
  type SourceRepositoryGrant,
  sourceRepositoryGrantSchema,
  sourceWorkspaceAggregateBytes,
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

describe("source workspace aggregate reservation", () => {
  const repository = {
    id: "repo",
    canonical_path: "/srv/repos/repo",
    fingerprint: "a".repeat(64),
  };
  const baseExtras = {
    schema_version: 1 as const,
    id: "repo-source",
    repository,
    allowed_refs: ["refs/heads/main"],
    allowed_paths: ["src"],
    audience: [{ kind: "controller" }],
    isolated_git_view: true,
    max_patch_bytes: 65_536,
    max_patch_files: 32,
    max_parallel_preparations: 1,
    timeout_ms: 30_000,
  };

  it("accepts the 3.515625 GiB aggregate reservation example", () => {
    const example = {
      ...baseExtras,
      max_source_bytes: 64 * 1024 * 1024,
      max_source_files: 776,
      max_workspaces: 4,
      max_total_bytes: 3_600 * 1024 * 1024,
    } as SourceRepositoryGrant;
    const perWorkspace = sourceWorkspaceReservationBytes(
      example.max_source_bytes,
      example.max_source_files,
    );
    const aggregate = sourceWorkspaceAggregateBytes(example);
    expect(perWorkspace).toBe(900 * 1024 * 1024);
    expect(aggregate).toBe(3_600 * 1024 * 1024);
    expect(Number.isSafeInteger(aggregate)).toBe(true);
    expect(validateSourceRepositoryGrant(example)).toEqual([]);
  });

  it("accepts the 1 MiB boundary where max_total_bytes equals the aggregate reservation", () => {
    const minimal = {
      ...grant,
      max_source_bytes: 1_048_576,
      max_source_files: 1,
      max_workspaces: 1,
      max_total_bytes: sourceWorkspaceReservationBytes(1_048_576, 1) * 1,
    } as unknown as SourceRepositoryGrant;
    const aggregate = sourceWorkspaceAggregateBytes(minimal);
    expect(aggregate).toBe(minimal.max_total_bytes);
    expect(Number.isSafeInteger(aggregate)).toBe(true);
    expect(validateSourceRepositoryGrant(minimal)).toEqual([]);
  });

  it("rejects an aggregate reservation that exceeds Number.MAX_SAFE_INTEGER", () => {
    // Schema bounds cannot produce an unsafe aggregate; bypass the schema to
    // verify the aggregate guard fires for any input whose product overflows.
    const unsafe = {
      ...baseExtras,
      max_source_bytes: 1_048_576,
      max_source_files: 1,
      max_workspaces: 1_010_640_541,
      max_total_bytes: Number.MAX_SAFE_INTEGER,
    } as unknown as SourceRepositoryGrant;
    expect(() => sourceWorkspaceAggregateBytes(unsafe)).toThrow(
      "source repository grant aggregate reservation is unsafe",
    );
    expect(validateSourceRepositoryGrant(unsafe)).toEqual([
      "source repository grant aggregate reservation is unsafe",
    ]);
  });

  it("emits the exact diagnostic string for an unsafe aggregate", () => {
    const unsafe = {
      ...baseExtras,
      max_source_bytes: 1_048_576,
      max_source_files: 1,
      max_workspaces: 1_010_640_541,
      max_total_bytes: Number.MAX_SAFE_INTEGER,
    } as unknown as SourceRepositoryGrant;
    let captured: unknown;
    try {
      sourceWorkspaceAggregateBytes(unsafe);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(RangeError);
    expect((captured as RangeError).message).toBe(
      "source repository grant aggregate reservation is unsafe",
    );
  });

  it("rejects grants where max_total_bytes is below the safe aggregate", () => {
    const underfunded = {
      ...grant,
      max_total_bytes:
        sourceWorkspaceReservationBytes(grant.max_source_bytes, grant.max_source_files) *
          grant.max_workspaces -
        1,
    };
    expect(validateSourceRepositoryGrant(underfunded)).toContain(
      "source repository grant aggregate bytes do not cover retained workspace reservations",
    );
  });
});
