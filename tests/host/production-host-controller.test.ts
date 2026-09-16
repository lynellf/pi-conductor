import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { ProductionHost } from "../../src/host/production-host.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";

const manifest = `
version: 1
controller:
  protocol_version: 1
  controller_id: repo-controller
  runtime_id: runtime-v1
  executable: /opt/controller
  argv: []
  adapters: []
  delegation:
    allowed_subagents: [worker]
    max_children_per_session: 1
    max_parallel: 1
roles:
  - name: orchestrator
    is_orchestrator: true
subagents:
  - name: worker
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: worker.md
`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProductionHost controller branch", () => {
  it("spawns the controller session before any SDK model session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-production-controller-"));
    roots.push(cwd);
    const approval = {
      schema_version: 1 as const,
      approval_id: "controller-authority",
      runtimes: [
        {
          runtime_id: "runtime-v1",
          source_root: "/opt/controller-runtime",
          inventory_sha256: "a".repeat(64),
          bootstrap_approval: {
            approvalId: "runtime-files",
            files: [
              { path: "bin/bash", sha256: "b".repeat(64) },
              { path: "opt/controller", sha256: "c".repeat(64) },
            ],
          },
        },
      ],
      controllers: [
        {
          controller_id: "repo-controller",
          runtime_id: "runtime-v1",
          executable: "/opt/controller",
          argv: [],
        },
      ],
      adapters: [],
      schemas: [],
    };
    const nodeRoleSessionFactory = vi.fn();
    const loadedManifest = loadManifestFromString(manifest);
    const host = new ProductionHost({
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      cwd,
      log: new InMemoryRecordLog(),
      loadedManifest: { ...loadedManifest, manifestDir: cwd },
      runId: "run-controller",
      nodeRoleSessionFactory,
      loadControllerHostApproval: async () => approval,
      sandboxHostApproval: {
        schemaVersion: 1,
        binaryPath: "/opt/bwrap",
        approvedBuilds: [],
        bootstrapApproval: approval.runtimes[0]?.bootstrap_approval ?? {
          approvalId: "runtime-files",
          files: [],
        },
        probeApproval: { approvalId: "probe", sha256: "d".repeat(64) },
      },
    });

    const result = await host.spawnRole("orchestrator", { visitIndex: 4, modelIndex: 99 });

    expect(result.sessionOrigin).toMatchObject({
      kind: "controller",
      controllerId: "repo-controller",
    });
    expect(nodeRoleSessionFactory).not.toHaveBeenCalled();
    expect(host.pendingDelegationTasks(result)).toEqual([]);
    await result.dispose();
  });
});
