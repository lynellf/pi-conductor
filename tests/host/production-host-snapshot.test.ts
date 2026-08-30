/** Issue #48 R2 immutable snapshot pin behavior. */

import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRecordLog, loadManifestFromString, ProductionHost } from "../../src/index.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import {
  commitFile,
  gitRevision,
  initializeGitFixture,
  isolatedRolesManifest,
} from "./production-host-snapshot-fixture.js";
import { createAutomaticIsolatedRoleSessionFactory } from "./rpc/host-rpc-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const execFileAsync = promisify(execFile);

describe("ProductionHost.spawnRole — Issue #48 R2 immutable snapshot pin", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-r2a-pin-"));
    await initializeGitFixture(workdir);
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  for (const scenario of [
    {
      name: "snapshot after HEAD moves",
      source: "snapshot",
      prepare: async () => {},
      moveSource: async (dir: string) => commitFile(dir, "moved-head.txt", "moved HEAD\n"),
    },
    {
      name: "ref after the named ref moves",
      source: "ref:moving-ref",
      prepare: async (dir: string) => {
        await execFileAsync("git", ["branch", "moving-ref"], { cwd: dir });
      },
      moveSource: async (dir: string) => {
        await commitFile(dir, "moved-ref.txt", "moved ref\n");
        await execFileAsync("git", ["branch", "-f", "moving-ref", "HEAD"], { cwd: dir });
      },
    },
  ] as const) {
    it(`pins once and reuses the original commit for later and resumed isolated spawns (${scenario.name})`, async () => {
      const runId = `r2a-${scenario.source.replace(/[^a-z]/g, "-")}`;
      const log = new InMemoryRecordLog();
      await scenario.prepare(workdir);
      const initialCommit = await gitRevision(workdir, "HEAD");
      const manifest = loadManifestFromString(isolatedRolesManifest(scenario.source));
      const host = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub(),
        cwd: workdir,
        log,
        loadedManifest: manifest,
        runId,
        nodeRoleSessionFactory: createAutomaticIsolatedRoleSessionFactory(),
        // Issue #70: isolate from `~/.pi/agent` so user extensions never
        // load into this test's extension runner.
        agentDir: makeAndTrackIsolatedAgentDir(),
      });

      const first = await host.spawnRole("implementer", { visitIndex: 1 });
      await first.dispose();
      await scenario.moveSource(workdir);
      expect(
        await gitRevision(
          workdir,
          scenario.source === "snapshot" ? "HEAD" : scenario.source.slice("ref:".length),
        ),
      ).not.toBe(initialCommit);
      const later = await host.spawnRole("reviewer", { visitIndex: 1 });
      await later.dispose();
      const resumed = await new ProductionHost({
        modelRegistry: makeModelRegistryWithStub(),
        cwd: workdir,
        log,
        loadedManifest: manifest,
        runId,
        nodeRoleSessionFactory: createAutomaticIsolatedRoleSessionFactory(),
        // Issue #70: isolate from `~/.pi/agent` so user extensions never
        // load into this test's extension runner.
        agentDir: makeAndTrackIsolatedAgentDir(),
      }).spawnRole("auditor", { visitIndex: 1 });
      await resumed.dispose();

      const records = log.records(runId);
      const pins = records.filter((record) => record.type === "snapshot_pinned");
      const workspaces = records.filter((record) => record.type === "workspace_provisioned");
      expect(pins).toHaveLength(1);
      const pin = pins[0];
      if (pin === undefined) throw new Error("expected the persisted snapshot pin");
      expect(pin.commit).toBe(initialCommit);
      await expect(
        gitRevision(
          join(workdir, ".pi-conductor", "runs", runId, "snapshots", pin.commit.slice(0, 8)),
          "HEAD",
        ),
      ).resolves.toBe(pin.commit);
      expect(workspaces.map((record) => record.snapshot_commit)).toEqual([
        pin.commit,
        pin.commit,
        pin.commit,
      ]);
      await expect(
        Promise.all(workspaces.map((record) => gitRevision(record.workspace_path, "HEAD"))),
      ).resolves.toEqual([pin.commit, pin.commit, pin.commit]);
    });
  }

  it("keeps the first isolated role's ref pin when later roles declare moving snapshot sources", async () => {
    const runId = "r2a-first-isolated-source-wins";
    const log = new InMemoryRecordLog();
    const initialCommit = await gitRevision(workdir, "HEAD");
    await execFileAsync("git", ["branch", "pinned-ref"], { cwd: workdir });
    const manifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
    workspace: { backend: worktree, source: ref:pinned-ref }
  - name: reviewer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
    workspace: { backend: worktree, source: snapshot }
  - name: auditor
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
    workspace: { backend: worktree, source: snapshot }
`);
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      nodeRoleSessionFactory: createAutomaticIsolatedRoleSessionFactory(),
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
    });

    await (await host.spawnRole("implementer", { visitIndex: 1 })).dispose();
    await commitFile(workdir, "moved-head.txt", "moving snapshot source\n");
    expect(await gitRevision(workdir, "HEAD")).not.toBe(initialCommit);
    await (await host.spawnRole("reviewer", { visitIndex: 1 })).dispose();
    await (
      await new ProductionHost({
        modelRegistry: makeModelRegistryWithStub(),
        cwd: workdir,
        log,
        loadedManifest: manifest,
        runId,
        nodeRoleSessionFactory: createAutomaticIsolatedRoleSessionFactory(),
        // Issue #70: isolate from `~/.pi/agent` so user extensions never
        // load into this test's extension runner.
        agentDir: makeAndTrackIsolatedAgentDir(),
      }).spawnRole("auditor", { visitIndex: 1 })
    ).dispose();

    const pins = log.records(runId).filter((record) => record.type === "snapshot_pinned");
    const workspaces = log
      .records(runId)
      .filter((record) => record.type === "workspace_provisioned");
    expect(pins).toEqual([
      expect.objectContaining({ source: "ref:pinned-ref", commit: initialCommit }),
    ]);
    await expect(
      Promise.all(workspaces.map((record) => gitRevision(record.workspace_path, "HEAD"))),
    ).resolves.toEqual([initialCommit, initialCommit, initialCommit]);
  });

  it("persists one pin for concurrent isolated spawns and provisions every workspace at that commit", async () => {
    const runId = "r2a-concurrent-isolated-spawns";
    const log = new InMemoryRecordLog();
    const initialCommit = await gitRevision(workdir, "HEAD");
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: loadManifestFromString(isolatedRolesManifest("snapshot")),
      runId,
      nodeRoleSessionFactory: createAutomaticIsolatedRoleSessionFactory(),
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
    });

    const sessions = await Promise.all([
      host.spawnRole("implementer", { visitIndex: 1 }),
      host.spawnRole("reviewer", { visitIndex: 1 }),
    ]);
    await Promise.all(sessions.map((session) => session.dispose()));

    const pins = log.records(runId).filter((record) => record.type === "snapshot_pinned");
    const workspaces = log
      .records(runId)
      .filter((record) => record.type === "workspace_provisioned");
    expect(pins).toHaveLength(1);
    const pin = pins[0];
    if (pin === undefined) throw new Error("expected the persisted snapshot pin");
    expect(pin.commit).toBe(initialCommit);
    expect(workspaces).toHaveLength(2);
    expect(workspaces.map((record) => record.snapshot_commit)).toEqual([pin.commit, pin.commit]);
    await expect(
      Promise.all(workspaces.map((record) => gitRevision(record.workspace_path, "HEAD"))),
    ).resolves.toEqual([pin.commit, pin.commit]);
  });

  for (const fixture of [
    {
      name: "duplicate pins",
      records: (runId: string, commit: string) => [
        { type: "snapshot_pinned" as const, run_id: runId, source: "snapshot", commit, ts: 1 },
        { type: "snapshot_pinned" as const, run_id: runId, source: "snapshot", commit, ts: 2 },
      ],
    },
    {
      name: "a cross-run pin in the requested record stream",
      records: (_runId: string, commit: string) => [
        {
          type: "snapshot_pinned" as const,
          run_id: "different-run",
          source: "snapshot",
          commit,
          ts: 1,
        },
      ],
    },
    {
      name: "a malformed source",
      records: (runId: string, commit: string) => [
        { type: "snapshot_pinned" as const, run_id: runId, source: "ref:", commit, ts: 1 },
      ],
    },
    {
      name: "a malformed SHA",
      records: (runId: string) => [
        {
          type: "snapshot_pinned" as const,
          run_id: runId,
          source: "snapshot",
          commit: "not-a-commit",
          ts: 1,
        },
      ],
    },
    {
      name: "a syntactically valid but non-resolving SHA",
      records: (runId: string) => [
        {
          type: "snapshot_pinned" as const,
          run_id: runId,
          source: "snapshot",
          commit: "f".repeat(40),
          ts: 1,
        },
      ],
    },
  ] as const) {
    it(`rejects ${fixture.name} with a typed workspace error before checkout or provisioning`, async () => {
      const runId = `r2a-invalid-pin-${fixture.name.replaceAll(" ", "-")}`;
      const log = new InMemoryRecordLog();
      vi.spyOn(log, "records").mockReturnValue(
        fixture.records(runId, await gitRevision(workdir, "HEAD")),
      );
      const host = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub(),
        cwd: workdir,
        log,
        loadedManifest: loadManifestFromString(isolatedRolesManifest("snapshot")),
        runId,
        // Issue #70: isolate from `~/.pi/agent` so user extensions never
        // load into this test's extension runner.
        agentDir: makeAndTrackIsolatedAgentDir(),
      });

      await expect(host.spawnRole("implementer", { visitIndex: 1 })).rejects.toMatchObject({
        name: "WorkspaceError",
        code: "snapshot-pin-invalid",
      });
      await expect(
        stat(join(workdir, ".pi-conductor", "runs", runId, "snapshots")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        stat(join(workdir, ".pi-conductor", "runs", runId, "workspaces")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  }
});
