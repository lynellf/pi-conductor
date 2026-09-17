import { describe, expect, it } from "vitest";
import {
  approveControllerDefinition,
  verifyControllerApproval,
} from "../../src/host/controller/approved-definition.js";
import {
  type ControllerHostApproval,
  validateControllerHostApproval,
} from "../../src/host/controller/host-approval.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const registeredSchema = { type: "object", additionalProperties: false };

function sourceGrant(fingerprint = "a".repeat(64)) {
  return {
    schema_version: 1 as const,
    id: "repo-source",
    repository: {
      id: "repo",
      canonical_path: "/srv/repos/repo",
      fingerprint,
    },
    allowed_refs: ["refs/heads/main"],
    allowed_paths: ["src"],
    audience: [{ kind: "controller" }],
    isolated_git_view: true,
    max_source_bytes: 1_048_576,
    max_source_files: 1000,
    max_patch_bytes: 65_536,
    max_patch_files: 32,
    max_workspaces: 2,
    max_total_bytes: 2_097_152,
    max_parallel_preparations: 1,
    timeout_ms: 30_000,
  };
}

function approval(fingerprint = "a".repeat(64)): ControllerHostApproval {
  const adapter = {
    id: "prepare",
    runtime_id: "runtime",
    executable: "/bin/bash",
    argv: ["/opt/prepare.sh"],
    input_schema_id: "packet",
    output_schema_id: "packet",
    capability: "read_only" as const,
    source_policy: {
      source_ids: ["repo-source"],
      max_scratch_bytes: 4096,
      max_file_input_bytes: 65_536,
      max_file_input_files: 4,
      timeout_ms: 30_000,
    },
  };
  return validateControllerHostApproval({
    schema_version: 1,
    approval_id: "controller-test-v1",
    runtimes: [
      {
        runtime_id: "runtime",
        source_root: "/operator/controller-runtime",
        inventory_sha256: "a".repeat(64),
        bootstrap_approval: {
          approvalId: "runtime-v1",
          files: [{ path: "bin/bash", sha256: "b".repeat(64) }],
        },
      },
    ],
    controllers: [
      {
        controller_id: "planner",
        runtime_id: "runtime",
        executable: "/bin/bash",
        argv: ["/opt/planner.sh"],
      },
    ],
    adapters: [adapter],
    schemas: [
      {
        schema_id: "packet",
        schema_digest: sha256Canonical(registeredSchema),
        schema: registeredSchema,
      },
    ],
    source_repositories: [sourceGrant(fingerprint)],
  });
}

function config() {
  return {
    protocol_version: 1 as const,
    controller_id: "planner",
    runtime_id: "runtime",
    executable: "/bin/bash",
    argv: ["/opt/planner.sh"],
    source_repositories: ["repo-source"],
    adapters: [
      {
        id: "prepare",
        runtime_id: "runtime",
        executable: "/bin/bash",
        argv: ["/opt/prepare.sh"],
        input_schema_id: "packet",
        output_schema_id: "packet",
        capability: "read_only" as const,
        source_policy: {
          source_ids: ["repo-source"],
          max_scratch_bytes: 4096,
          max_file_input_bytes: 65_536,
          max_file_input_files: 4,
          timeout_ms: 30_000,
        },
      },
    ],
    delegation: { allowed_subagents: ["worker"], max_children_per_session: 1, max_parallel: 1 },
  };
}

describe("source authority pinning", () => {
  it("pins the selected source grant into the controller definition", () => {
    const approved = approveControllerDefinition("run-source", config(), approval(), 1);
    const pinned = approved.record.pinned_definition as {
      source_repositories?: readonly unknown[];
    };
    expect(pinned.source_repositories).toHaveLength(1);
  });

  it("rejects a changed or revoked selected grant on verification", () => {
    const current = approval();
    const approved = approveControllerDefinition("run-source", config(), current, 1);
    const changed = approval("c".repeat(64));
    expect(() => verifyControllerApproval(approved.record, changed)).toThrow(/changed|revoked/);
    const revoked = { ...current, source_repositories: [] };
    expect(() => verifyControllerApproval(approved.record, revoked)).toThrow(/not approved/);
  });
});
