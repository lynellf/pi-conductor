import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProductionControllerSession,
  type ProductionControllerSessionOptions,
} from "../../src/host/controller/production-session-factory.js";
import { ProductionDelegationCoordinator } from "../../src/host/delegation/production-delegation.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
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

describe("production controller session assembly", () => {
  it("pins definition and activation before returning an inert non-SDK session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-controller-session-"));
    roots.push(cwd);
    const setup = await controllerSessionInputs(cwd);
    const created = await createProductionControllerSession(setup.options);

    expect(
      setup.log
        .records(setup.options.runId)
        .map((record) => record.type)
        .slice(0, 2),
    ).toEqual(["controller_definition_pinned", "controller_activation_started"]);
    expect(created.session.sessionOrigin?.kind).toBe("controller");
    expect(created.session.model).toBeNull();
    await expect(access(join(setup.runStateDir, "worktrees"))).resolves.toBeUndefined();
    await expect(access(join(setup.runStateDir, "sandbox"))).resolves.toBeUndefined();
    const audit = await readFile(created.session.sessionFile, "utf8");
    expect(audit).toContain('"session_origin":"controller"');
    expect(audit).not.toContain("conversation_id");
    await created.session.dispose();
  });

  it("rejects a symlink substituted for a protected controller workspace root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-controller-session-"));
    roots.push(cwd);
    const setup = await controllerSessionInputs(cwd);
    const outside = join(cwd, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(setup.runStateDir, "worktrees"));

    await expect(createProductionControllerSession(setup.options)).rejects.toThrow(
      "sandbox admission directory is unsafe",
    );
  });
});

async function controllerSessionInputs(cwd: string): Promise<{
  readonly log: InMemoryRecordLog;
  readonly runStateDir: string;
  readonly options: ProductionControllerSessionOptions;
}> {
  const runId = "run-controller";
  const runStateDir = join(cwd, "runs", runId);
  const sessionDir = join(runStateDir, "sessions");
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const log = new InMemoryRecordLog();
  const loadedManifest = loadManifestFromString(manifest);
  const delegation = new ProductionDelegationCoordinator();
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
  const persist = (record: Parameters<InMemoryRecordLog["append"]>[0]) => log.append(record);
  return {
    log,
    runStateDir,
    options: {
      role: "orchestrator",
      visitIndex: 1,
      loadedManifest,
      runId,
      cwd,
      sessionDir,
      log,
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
      loadControllerHostApproval: async () => approval,
      delegateContext: {
        loadedManifest,
        runId,
        cwd,
        agentDir: join(cwd, "agent"),
        sessionDir,
        modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
        displaySink: undefined,
        log,
        delegation,
        runCostSoFar: () => 0,
        persistRecord: persist,
        adaptDelegateToolResult: () => {
          throw new Error("unused");
        },
      },
      persist,
      runCostSoFar: () => 0,
    },
  };
}
