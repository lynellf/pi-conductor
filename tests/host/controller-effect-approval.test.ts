/** Operator grants remain independent of repository requests and pinned across resume (#116). */
import { describe, expect, it } from "vitest";
import {
  approveControllerDefinition,
  verifyControllerApproval,
} from "../../src/host/controller/approved-definition.js";
import { validateControllerHostApproval } from "../../src/host/controller/host-approval.js";
import { parseControllerConfig } from "../../src/manifest/controller.js";
import {
  effectRequestSchemaDigest,
  effectRequestSchemaFor,
  effectResultSchemaDigest,
} from "../../src/manifest/controller-effect.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

function fixture() {
  const program = {
    controller_id: "planner",
    runtime_id: "runtime",
    executable: "/bin/bash",
    argv: [],
  };
  const adapter = {
    id: "choose-promotion",
    runtime_id: "runtime",
    executable: "/bin/bash",
    argv: ["/opt/promote.sh"],
    capability: "read_only",
    input_schema_id: "input",
    output_schema_id: "promote-request",
    effect_id: "promote",
    output_consumers: [{ kind: "effect", effect_id: "promote" }],
  };
  const grant = {
    schema_version: 1,
    id: "promote",
    adapter_id: adapter.id,
    implementation_id: "git-promote-v1",
    implementation_digest: "a".repeat(64),
    kind: "git_promote",
    request_schema_id: adapter.output_schema_id,
    request_schema_digest: effectRequestSchemaDigest("git_promote"),
    output_schema_id: "promote-result",
    output_schema_digest: effectResultSchemaDigest("git_promote"),
    repository: { id: "project", canonical_path: "/operator/project", fingerprint: "b".repeat(64) },
    allowed_source_refs: ["refs/heads/reviewed"],
    allowed_target_refs: ["refs/heads/delivery"],
    required_evidence: [{ producer_id: "validate", schema_id: "validation" }],
    max_input_bytes: 65536,
    max_output_bytes: 65536,
    timeout_seconds: 30,
  };
  const inputSchema = { type: "object" };
  const registry = {
    schema_version: 1,
    approval_id: "operator",
    runtimes: [
      {
        runtime_id: "runtime",
        source_root: "/operator/runtime",
        inventory_sha256: "c".repeat(64),
        bootstrap_approval: {
          approvalId: "runtime",
          files: [{ path: "bin/bash", sha256: "d".repeat(64) }],
        },
      },
    ],
    controllers: [program],
    adapters: [adapter],
    schemas: [
      { schema_id: "input", schema_digest: sha256Canonical(inputSchema), schema: inputSchema },
      {
        schema_id: adapter.output_schema_id,
        schema_digest: effectRequestSchemaDigest("git_promote"),
        schema: effectRequestSchemaFor("git_promote"),
      },
    ],
    effects: [grant],
  };
  const config = {
    protocol_version: 1,
    ...program,
    adapters: [adapter],
    delegation: { allowed_subagents: ["worker"], max_parallel: 1, max_children_per_session: 2 },
  };
  return { config, registry };
}
describe("controller effect approval pinning", () => {
  it("pins only used exact effect authority and rejects ref widening on resume", () => {
    const f = fixture();
    const definition = approveControllerDefinition(
      "run",
      parseControllerConfig(f.config),
      validateControllerHostApproval(f.registry),
      1,
    );
    expect(definition.record.pinned_definition).toHaveProperty("effects");
    expect(
      verifyControllerApproval(definition.record, validateControllerHostApproval(f.registry))
        .record,
    ).toEqual(definition.record);
    const grant = f.registry.effects[0];
    if (grant === undefined) throw new Error("missing grant");
    grant.allowed_target_refs.push("refs/heads/main");
    expect(() =>
      verifyControllerApproval(definition.record, validateControllerHostApproval(f.registry)),
    ).toThrow(/changed|revoked/);
  });
  it("rejects missing effect authority before controller execution", () => {
    const f = fixture();
    f.registry.effects = [];
    expect(() => validateControllerHostApproval(f.registry)).toThrow(/effect.*approved/);
  });
  it("rejects an effect adapter that cannot read its own request artifact", () => {
    const f = fixture();
    const adapter = f.registry.adapters[0];
    if (adapter === undefined) throw new Error("missing adapter");
    const { output_consumers: _outputConsumers, ...missingConsumer } = adapter;
    expect(() =>
      validateControllerHostApproval({ ...f.registry, adapters: [missingConsumer] }),
    ).toThrow(/own effect principal/);
  });
  it("rejects a grant schema that differs from the fixed adapter output schema", () => {
    const f = fixture();
    const grant = f.registry.effects[0];
    if (grant === undefined) throw new Error("missing grant");
    grant.request_schema_digest = "e".repeat(64);
    expect(() => validateControllerHostApproval(f.registry)).toThrow(/schema differs/);
  });
  it("does not retain credential file paths in the public pinned definition", () => {
    const f = fixture();
    const approval = validateControllerHostApproval({
      ...f.registry,
      credential_sources: [{ id: "service", path: "/operator/credential-canary" }],
    });
    const definition = approveControllerDefinition(
      "run",
      parseControllerConfig(f.config),
      approval,
      1,
    );
    expect(JSON.stringify(definition.record)).not.toContain("credential-canary");
  });
});
