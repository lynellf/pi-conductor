import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../../src/bin/cli-main.js";

const createHost = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("../../src/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/index.js")>("../../src/index.js");
  return { ...actual, createProductionHost: createHost };
});

const roots: string[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.doMock("../../src/index.js", async () => {
    const actual = await vi.importActual<typeof import("../../src/index.js")>("../../src/index.js");
    return { ...actual, createProductionHost: createHost };
  });
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.doUnmock("../../src/index.js");
  vi.resetModules();
  createHost.mockReset();
});

function deps(root: string, startRun: CliDeps["startRun"]): CliDeps {
  return {
    startRun,
    modelRegistry: {} as never,
    console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    exit: vi.fn(),
    cwd: root,
  };
}

describe("CLI sandbox approval option", () => {
  it("rejects an invalid approval before startRun", async () => {
    const { runCli } = await import("../../src/bin/cli-main.js");
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-cli-approval-"));
    roots.push(root);
    await writeFile(join(root, "manifest.yaml"), "version: 1\n");
    await writeFile(join(root, "approval.json"), "{}", { mode: 0o600 });
    const startRun = vi.fn();
    const code = await runCli(
      ["--sandbox-approval", "approval.json", "manifest.yaml", "goal"],
      deps(root, startRun),
    );
    expect(code).toBe(1);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("rejects a missing approval flag value", async () => {
    const { runCli } = await import("../../src/bin/cli-main.js");
    const startRun = vi.fn();
    const code = await runCli(["--sandbox-approval"], deps(process.cwd(), startRun));
    expect(code).toBe(2);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("passes valid approval metadata through the host factory", async () => {
    const { runCli } = await import("../../src/bin/cli-main.js");
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-cli-approval-"));
    roots.push(root);
    await writeFile(join(root, "manifest.yaml"), "version: 1\n");
    const approval = {
      schemaVersion: 1,
      binaryPath: "/opt/bwrap",
      approvedBuilds: [
        {
          kind: "upstream-release",
          release: "0.12.0",
          binaryIdentity: {
            device: 1,
            inode: 2,
            mode: 493,
            uid: 0,
            gid: 0,
            size: 1,
            mtimeMs: 1,
            ctimeMs: 1,
          },
          sha256: "a".repeat(64),
          approvalId: "bwrap",
        },
      ],
      bootstrapApproval: {
        approvalId: "runtime",
        files: [
          { path: "bin/bash", sha256: "b".repeat(64) },
          { path: "opt/pi-conductor/probes/capability-probe-v1", sha256: "c".repeat(64) },
        ],
      },
      probeApproval: { approvalId: "probe", sha256: "c".repeat(64) },
    };
    const approvalPath = join(root, "approval.json");
    await writeFile(approvalPath, JSON.stringify(approval), { mode: 0o600 });
    const startRun: CliDeps["startRun"] = vi.fn(async (_path, options) => {
      options.hostFactory({
        runId: "run-1",
        log: {},
        loadedManifest: { manifestDir: root },
      } as never);
      return {
        runId: "run-1",
        completion: async () => ({
          finalCheckpoint: { current_role: "done" },
          exitReason: "done",
        }),
        runStats: () => ({}),
        loadedManifest: { warnings: [] },
        latestResponse: () => null,
      } as never;
    });
    await runCli(
      ["--sandbox-approval", approvalPath, "manifest.yaml", "goal"],
      deps(root, startRun),
    );
    expect(createHost).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: expect.objectContaining({ sandboxHostApproval: approval }),
      }),
    );
  });
});
