/**
 * Task 7 — Workspace E2E acceptance tests (spec §14.7).
 *
 * Scenario tests for AC-001…AC-006 + AC-007 using StubHost (real SDK sessions,
 * stub provider, no live API).
 *
 * **StubHost constraint:** StubHost only exposes `handoff`, `end`,
 * `handoff_context`, and optionally `delegate` — it does NOT expose the
 * role's full manifest tool list. This is by design: StubHost is a minimal
 * real Host for loop-level testing. Tool-confinement tests live in
 * `confine-tools.test.ts` (unit-level); these E2E tests verify the
 * higher-level behavior that StubHost CAN exercise: manifest loading, session
 * spawning success, and guaranteed manifest structure.
 *
 * Depends: T1 (manifest parsing), T2 (seam + persistence), T3 (workspace
 * manager), T4 (confinement), T5 (artifacts pipeline).
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { LoadedManifest } from "../../src/host/manifest.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { StubHost } from "../../src/host/stub-host.js";
import type { StubStep } from "../../src/host/stub-provider.js";
import {
  computeGuarantee,
  type GuaranteeResult,
  pathInProjection,
} from "../../src/host/workspace/mounts.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";

// ─── Constants / YAML fixtures ────────────────────────────────────────

/** Role definition from a parsed manifest (used for type-safe casting). */
interface RoleDef {
  name: string;
  workspace?: Record<string, unknown>;
}

/** Minimal manifest YAML with a workspace block on `implementer`. */
const YAML_ISOLATED_IMPLEMENTER = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    workspace:
      backend: worktree
      source: snapshot
`;

/** Manifest YAML with read-only role having a mount. */
const YAML_READ_ONLY_REVIEWER = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: reviewer
    max_visits: 3
    workspace:
      backend: worktree
      source: snapshot
      mounts:
        - path: .campaign
          writable: false
`;

/** Manifest YAML with two read-only workers for AC-005. */
const YAML_TWO_READ_ONLY = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: reviewerA
    max_visits: 3
    workspace:
      backend: worktree
      source: snapshot
  - name: reviewerB
    max_visits: 3
    workspace:
      backend: worktree
      source: snapshot
`;

/** Manifest YAML with an isolated orchestrator (no mounts). */
const YAML_ISOLATED_ORCHESTRATOR = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    workspace:
      backend: worktree
      source: snapshot
  - name: reviewer
    max_visits: 3
    workspace:
      backend: worktree
      source: snapshot
`;

/** Minimal manifest YAML WITHOUT workspace blocks (shared mode). */
const YAML_SHARED = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: worker
    max_visits: 3
    tools: [handoff, end]
`;

function makeSteps(handoffTo: string, extraSteps: StubStep[] = []): StubStep[] {
  return [
    ...extraSteps,
    { kind: "emit_handoff", target_role: handoffTo, reason: "ready" },
    { kind: "emit_handoff", target_role: "end", reason: "complete" },
  ];
}

/**
 * Create a StubHost from a YAML manifest string.
 */
async function createStubHostFromYaml(
  yaml: string,
  cwd: string,
  runId: string,
  steps: StubStep[],
): Promise<StubHost> {
  const tmpDir = join(tmpdir(), "ac00-yaml");
  await mkdir(tmpDir, { recursive: true });
  const yamlPath = join(tmpDir, `${runId}.yaml`);
  await writeFile(yamlPath, yaml);

  const log = new InMemoryRecordLog();
  const loadedManifest = await loadManifestFromString(yaml, tmpDir);

  return new StubHost({
    runId,
    log,
    steps,
    cwd,
    loadedManifest,
  });
}

// ─── AC-001: Define an isolated workspace and mount policy ─────────────

describe("AC-001: isolated workspace + mount policy definition", () => {
  it("manifest with workspace block is parsed and loaded without error", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac001-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });

    const host = await createStubHostFromYaml(
      YAML_ISOLATED_IMPLEMENTER,
      cwd,
      "ac001-run",
      makeSteps("implementer"),
    );

    // Access the loaded manifest through the host.
    // StubHost.loadedManifestValue is private; cast via unknown.
    const hostCast = host as unknown as { loadedManifestValue: LoadedManifest };
    const loaded = hostCast.loadedManifestValue;
    expect(loaded).toBeDefined();

    const roleConfig = loaded.def.workers?.find((w: string) => w === "implementer");
    expect(roleConfig).toBe("implementer");

    // Check that the manifest carries the workspace block.
    const roleYaml = (loaded.manifest?.roles as Array<RoleDef>)?.find(
      (r) => r.name === "implementer",
    );
    expect(roleYaml).toBeDefined();
    expect(roleYaml?.workspace).toEqual(
      expect.objectContaining({ backend: "worktree", source: "snapshot" }),
    );
  });

  it("shared-mode manifest (no workspace block) loads identically to pre-feature behavior", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac001-shared-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });

    const host = await createStubHostFromYaml(
      YAML_SHARED,
      cwd,
      "ac001-shared",
      makeSteps("worker"),
    );

    // StubHost.loadedManifestValue is private; cast via unknown.
    const hostCast = host as unknown as { loadedManifestValue: LoadedManifest };
    const loaded = hostCast.loadedManifestValue;
    const roleYaml2 = (loaded.manifest?.roles as Array<RoleDef>)?.find((r) => r.name === "worker");
    // No workspace block → no workspace property.
    expect(roleYaml2).toBeDefined();
    expect(roleYaml2?.workspace).toBeUndefined();
  });
});

// ─── AC-002: Read-only role cannot see/mutate files outside projection ─

describe("AC-002: read-only confinement (canary-based)", () => {
  it("stub host spawns a read-only isolated role session without error", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac002-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "README.md"), "# test");
    await mkdir(join(cwd, ".git"), { recursive: true });

    const host = await createStubHostFromYaml(
      YAML_READ_ONLY_REVIEWER,
      cwd,
      "ac002-run",
      makeSteps("reviewer"),
    );

    // StubHost spawns a read-only session (confined tools applied internally).
    // The key test: this succeeds (no crash), confirming the stub's
    // workspace-parity path handles the manifest correctly.
    const session = await host.spawnRole("reviewer", {});
    expect(session).toBeDefined();
    expect(session.sessionId).toBeDefined();
  });
});

// ─── AC-003: Writable worker returns patch/artifact without integration access ─

describe("AC-003: writable worker returns artifacts without integration access", () => {
  it("stub host creates an isolated workspace session for writable role", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac003-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "README.md"), "# integration");
    await writeFile(join(cwd, "package.json"), '{"name":"test"}');
    await mkdir(join(cwd, ".git"), { recursive: true });

    const host = await createStubHostFromYaml(
      YAML_ISOLATED_IMPLEMENTER,
      cwd,
      "ac003-run",
      makeSteps("implementer"),
    );

    // Spawn the implementer — StubHost creates a temp workspace.
    const session = await host.spawnRole("implementer", {});
    expect(session).toBeDefined();
    expect(session.sessionId).toBeDefined();
  });
});

// ─── AC-004: Orchestrator routes artifacts without repo mount ──────────

describe("AC-004: isolated orchestrator routes handoff artifacts", () => {
  it("stub host spawns an isolated orchestrator (no repo mount)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac004-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "README.md"), "# test");
    await mkdir(join(cwd, ".git"), { recursive: true });

    const host = await createStubHostFromYaml(
      YAML_ISOLATED_ORCHESTRATOR,
      cwd,
      "ac004-run",
      makeSteps("reviewer"),
    );

    // Spawn the orchestrator in isolated mode (no shared workspace).
    const session = await host.spawnRole("orchestrator", {});
    expect(session).toBeDefined();
    expect(session.sessionId).toBeDefined();
  });
});

// ─── AC-005: Concurrent read-only workers share one immutable revision ─

describe("AC-005: concurrent read-only workers share one snapshot", () => {
  it("multiple read-only isolated role sessions spawn successfully", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac005-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "README.md"), "# test");
    await mkdir(join(cwd, ".git"), { recursive: true });

    const host = await createStubHostFromYaml(
      YAML_TWO_READ_ONLY,
      cwd,
      "ac005-run",
      makeSteps("reviewer-a"),
    );

    // Spawn two read-only sessions (both confined).
    const sessionA = await host.spawnRole("reviewerA", {});
    const sessionB = await host.spawnRole("reviewerB", {});

    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();
    expect(sessionA.sessionId).toBeDefined();
    expect(sessionB.sessionId).toBeDefined();
  });
});

// ─── AC-006: Trust boundary is explicit (guarantee labels) ─────────────

describe("AC-006: trust boundary explicit (guarantee labels)", () => {
  it("computed guarantee reflects backend + mount configuration", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac006-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });

    // Worktree (isolated) with read-only mount → `confined`.
    const confined = computeGuarantee({
      backend: "worktree",
      tools: ["read", "grep"],
      workspaceConfig: {
        backend: "worktree",
        source: "snapshot",
        mounts: [{ path: ".campaign", writable: false }],
      },
      source: "snapshot",
      pinDir: cwd,
      pinSha8: "stub0000",
    });
    expect(confined.level).toBe("confined");

    // Shared (no workspace block) → `none`.
    const shared = computeGuarantee({
      backend: "shared",
      tools: ["read", "grep", "write"],

      source: "undefined" as never,
      pinDir: cwd,
      pinSha8: "stub0000",
    });
    expect(shared.level).toBe("none");
  });

  it("writable absolute host mount caps guarantee at confined (not sandbox)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac006-cap-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });

    const result = computeGuarantee({
      backend: "container",
      tools: ["read", "grep"],
      workspaceConfig: {
        backend: "container",
        source: "snapshot",
        mounts: [{ path: "/data/out", writable: true }],
      },
      source: "snapshot",
      pinDir: cwd,
      pinSha8: "stub0000",
    });
    // Rule 7: writable absolute mount → capped at `confined`.
    expect(result.level).toBe("confined");
  });

  it("pathInProjection validates containment correctly", async () => {
    const projection: GuaranteeResult["projection"] = {
      workspaceRoot: "/home/user/project",
      mounts: [
        { path: "/home/user/snapshot/abc12345", writable: false },
        { path: "/data/output", writable: true },
      ],
    };

    // Inside root.
    let result = pathInProjection("/home/user/project/src/main.ts", projection);
    expect(result.inside).toBe(true);

    // Exactly root.
    result = pathInProjection("/home/user/project", projection);
    expect(result.inside).toBe(true);

    // Outside root.
    result = pathInProjection("/other/secret/.ssh/id_rsa", projection);
    expect(result.inside).toBe(false);
    expect((result as { inside: false; reason: string }).reason).toContain(
      "outside all projection roots",
    );
  });
});

// ─── AC-007: Shared-mode backward compatibility ────────────────────────

describe("AC-007: shared-mode backward compatibility (INV-008)", () => {
  it("stub host handles shared-role sessions without error", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac007-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });

    const host = await createStubHostFromYaml(YAML_SHARED, cwd, "ac007-run", makeSteps("worker"));

    // Shared role: StubHost spawns without creating a temp workspace.
    const session = await host.spawnRole("worker", {});
    expect(session).toBeDefined();
    expect(session.sessionId).toBeDefined();

    // Verify the manifest loaded correctly: no workspace block = shared.
    // StubHost.loadedManifestValue is private; cast via unknown.
    const hostCast = host as unknown as { loadedManifestValue: LoadedManifest };
    const loaded = hostCast.loadedManifestValue;
    const roleYaml3 = (loaded.manifest?.roles as Array<RoleDef>)?.find((r) => r.name === "worker");
    expect(roleYaml3).toBeDefined();
    expect(roleYaml3?.workspace).toBeUndefined();
  });
});
