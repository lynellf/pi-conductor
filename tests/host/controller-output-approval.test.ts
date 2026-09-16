/** Pinned child-output consumer authority — issue #116 capability A. */
import { describe, expect, it } from "vitest";
import {
  approveControllerDefinition,
  verifyControllerApproval,
} from "../../src/host/controller/approved-definition.js";
import { validateControllerHostApproval } from "../../src/host/controller/host-approval.js";
import { parseControllerConfig } from "../../src/manifest/controller.js";

function policy() {
  return {
    profile_id: "reviewer",
    reports: [
      {
        id: "review",
        path: "review.json",
        media_type: "application/json",
        max_bytes: 4096,
        consumers: [{ kind: "native", profile_id: "integrator" }],
      },
    ],
  };
}
function inputs() {
  const program = {
    controller_id: "planner",
    runtime_id: "runtime",
    executable: "/bin/bash",
    argv: [],
  };
  return {
    request: {
      protocol_version: 1,
      ...program,
      adapters: [],
      child_outputs: [policy()],
      delegation: {
        allowed_subagents: ["reviewer", "integrator"],
        max_children_per_session: 4,
        max_parallel: 2,
      },
    },
    registry: {
      schema_version: 1,
      approval_id: "approval",
      controllers: [program],
      adapters: [],
      schemas: [],
      child_outputs: [policy()],
      runtimes: [
        {
          runtime_id: "runtime",
          source_root: "/operator/runtime",
          inventory_sha256: "a".repeat(64),
          bootstrap_approval: {
            approvalId: "runtime-v1",
            files: [{ path: "bin/bash", sha256: "b".repeat(64) }],
          },
        },
      ],
    },
  };
}

describe("controller native-output authority", () => {
  it("pins the exact operator-approved private output policy", () => {
    const { request, registry } = inputs();
    const approved = approveControllerDefinition(
      "run",
      parseControllerConfig(request),
      validateControllerHostApproval(registry),
      1,
    );
    expect(approved.config).toMatchObject({ child_outputs: [policy()] });
    expect(
      verifyControllerApproval(approved.record, validateControllerHostApproval(registry)).record,
    ).toEqual(approved.record);
  });

  it("rejects a repository policy that broadens an approved consumer audience", () => {
    const { request, registry } = inputs();
    const original = request.child_outputs[0];
    if (original === undefined) throw new Error("missing policy");
    original.reports[0]?.consumers.push({ kind: "native", profile_id: "reviewer" });
    expect(() =>
      approveControllerDefinition(
        "run",
        parseControllerConfig(request),
        validateControllerHostApproval(registry),
        1,
      ),
    ).toThrow(/output.*not approved/);
  });

  it("rejects resume after the pinned output grant is revoked", () => {
    const { request, registry } = inputs();
    const approved = approveControllerDefinition(
      "run",
      parseControllerConfig(request),
      validateControllerHostApproval(registry),
      1,
    );
    registry.child_outputs = [];
    expect(() =>
      verifyControllerApproval(approved.record, validateControllerHostApproval(registry)),
    ).toThrow(/output.*not approved/);
  });

  it("rejects duplicate output producers before pinning", () => {
    const { request, registry } = inputs();
    request.child_outputs.push(policy());
    expect(() => parseControllerConfig(request)).toThrow(/duplicates/);
    registry.child_outputs.push(policy());
    expect(() => validateControllerHostApproval(registry)).toThrow(/duplicates/);
  });

  it("retains the legacy definition shape when no output policy is configured", () => {
    const { request, registry } = inputs();
    const { child_outputs: _requested, ...legacyRequest } = request;
    const { child_outputs: _registered, ...legacyRegistry } = registry;
    const approved = approveControllerDefinition(
      "run",
      parseControllerConfig(legacyRequest),
      validateControllerHostApproval(legacyRegistry),
      1,
    );
    expect(approved.config).not.toHaveProperty("child_outputs");
    expect(approved.record.pinned_definition).not.toHaveProperty("child_outputs");
  });
});
