import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceInvocation } from "../../src/host/controller/executable-host-adapter.js";
import { parseControllerConfig } from "../../src/manifest/controller.js";
import type { ControllerAction } from "../../src/manifest/controller-protocol.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("source-aware executable adapter", () => {
  it("rejects a source identity that changes between resolution and launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-adapter-launch-"));
    roots.push(root);
    const adapter = sourceAdapter();
    const action = sourceAction();
    let current = sourceDescriptor(root, "head-a");
    const openSourceWorkspace = vi.fn(async () => current);
    const invocation = await sourceInvocation(
      {
        runStateDir: root,
        openSourceWorkspace,
        resolveRef: async () => fileOutput(),
      },
      adapter,
      action,
    );
    if (invocation === undefined) throw new Error("source invocation was not resolved");

    expect(invocation.inputAudience).toEqual([{ kind: "adapter", adapter_id: "validate" }]);
    await expect(invocation.verify()).resolves.toBeUndefined();
    current = sourceDescriptor(root, "head-b");
    await expect(invocation.verify()).rejects.toThrow(/changed before launch or publication/);
    await invocation.dispose();
  });
});

function sourceAdapter() {
  const config = parseControllerConfig({
    protocol_version: 1,
    controller_id: "controller",
    runtime_id: "runtime",
    executable: "/bin/controller",
    argv: [],
    source_repositories: ["source"],
    adapters: [
      {
        id: "validate",
        runtime_id: "runtime",
        executable: "/bin/validate",
        argv: [],
        input_schema_id: "input",
        output_schema_id: "output",
        capability: "read_only",
        source_policy: {
          source_ids: ["source"],
          max_scratch_bytes: 4096,
          max_file_input_bytes: 4096,
          max_file_input_files: 1,
          timeout_ms: 30000,
        },
      },
    ],
    delegation: { allowed_subagents: ["worker"], max_children_per_session: 1, max_parallel: 1 },
  });
  const adapter = config.adapters[0];
  if (adapter === undefined) throw new Error("source adapter fixture is missing");
  return adapter;
}

function sourceAction(): Extract<ControllerAction, { readonly kind: "adapter" }> {
  return {
    kind: "adapter",
    action_id: "validate-a",
    adapter_id: "validate",
    input_refs: [],
    source_workspace_ref: `source-workspace/v1/${"a".repeat(64)}/${"b".repeat(64)}`,
    file_input_refs: [{ ref: "artifact/v1/file", path: "request.json" }],
  };
}

function sourceDescriptor(root: string, headCommit: string) {
  return {
    ref: `source-workspace/v1/${"a".repeat(64)}/${"b".repeat(64)}`,
    sourceId: "source",
    sourcePath: root,
    checkoutPath: root,
    baseCommit: "base",
    headCommit,
    treeId: "tree",
    inventoryDigest: "inventory",
    audience: [
      { kind: "controller" as const },
      { kind: "adapter" as const, adapter_id: "validate" },
    ],
    allowGitView: false,
    policyDigest: "policy",
  };
}

function fileOutput() {
  const bytes = Buffer.from("{}\n");
  return {
    ref: "artifact/v1/file",
    format: "artifact/v1" as const,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    mediaType: "application/json",
    audience: [
      { kind: "adapter" as const, adapter_id: "validate" },
      { kind: "native" as const, profile_id: "worker" },
    ],
  };
}
