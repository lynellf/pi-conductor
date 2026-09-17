import { describe, expect, it } from "vitest";
import { sourceWorkspaceIntentDigest } from "../../src/persistence/source-workspace.js";
import { assertSourceWorkspaceHistory } from "../../src/persistence/source-workspace-timeline.js";

function records() {
  const identity = {
    run_id: "run",
    controller_id: "controller",
    definition_digest: "a".repeat(64),
    activation_id: "activation",
    owner_epoch: 1,
  };
  const fields = {
    ...identity,
    action_id: "prepare",
    request_sha256: "b".repeat(64),
    source_id: "source",
    source_authority_digest: "c".repeat(64),
    repository_fingerprint: "d".repeat(64),
    requested_ref: "refs/heads/main",
    resolved_base: "e".repeat(40),
    patches: [],
    audience: [{ kind: "controller" as const }],
    policy_digest: "f".repeat(64),
  };
  const workspace_id = sourceWorkspaceIntentDigest(fields);
  const intent = {
    ...fields,
    type: "source_workspace_intent",
    schema_version: 1,
    workspace_id,
    ts: 1,
  };
  const start = {
    ...identity,
    type: "source_workspace_started",
    schema_version: 1,
    workspace_id,
    action_id: "prepare",
    ts: 2,
  };
  const prepared = {
    ...identity,
    type: "source_workspace_prepared",
    schema_version: 1,
    workspace_id,
    intent_digest: workspace_id,
    ref: `source-workspace/v1/${workspace_id}/${"a".repeat(64)}`,
    content: {
      head_commit: "b".repeat(40),
      tree_id: "c".repeat(40),
      inventory_digest: "d".repeat(64),
      byte_length: 12,
      file_count: 1,
    },
    ts: 3,
  };
  return { intent, start, prepared };
}

describe("durable source preparation chronology", () => {
  it("accepts incomplete pinning and started work for conservative recovery", () => {
    const { intent, start, prepared } = records();
    for (const history of [[intent], [intent, start], [intent, start, prepared]])
      expect(() => assertSourceWorkspaceHistory(history)).not.toThrow();
  });
  it.each([
    "no-intent",
    "no-start",
    "duplicate-terminal",
    "wrong-owner",
    "wrong-intent",
    "wrong-ref",
    "repeated-intent",
  ])("rejects %s evidence", (kind) => {
    const { intent, start, prepared } = records();
    const histories: Record<string, unknown[]> = {
      "no-intent": [start],
      "no-start": [intent, prepared],
      "duplicate-terminal": [intent, start, prepared, prepared],
      "wrong-owner": [intent, { ...start, activation_id: "other" }],
      "wrong-intent": [intent, start, { ...prepared, intent_digest: "0".repeat(64) }],
      "wrong-ref": [
        intent,
        start,
        { ...prepared, ref: `source-workspace/v1/${"0".repeat(64)}/${"a".repeat(64)}` },
      ],
      "repeated-intent": [intent, intent],
    };
    expect(() => assertSourceWorkspaceHistory(histories[kind] ?? [])).toThrow();
  });
});
