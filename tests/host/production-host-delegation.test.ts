/**
 * Issue #17 Phase 2 (R2.5) — ProductionHost child-session wiring.
 *
 * Tests that ProductionHost registers the `delegate` tool only for roles
 * that have BOTH:
 *   - a `delegation:` block in the manifest
 *   - `delegate` in the role's `tools:` list
 *
 * Also tests the negative cases:
 *   - Role without delegation block → no delegate tool
 *   - Role with delegation block but without `delegate` in tools → no delegate tool
 *
 * The tests inspect `getActiveToolNames()` on spawned sessions to verify
 * the tool allowlists, and use a stub model registry (no API key needed).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";

import {
  InMemoryRecordLog,
  loadManifestFromString,
  ProductionHost,
  type RoleSession,
} from "../../src/index.js";

// The `RoleSession` interface in `src/host/host.ts` exposes only the loop's
// seam surface. The tests need to read the SDK's `getActiveToolNames()` method
// that the ProductionHost implementation exposes as an extra property.
type FullSession = RoleSession & {
  getActiveToolNames(): string[];
};
function asFull(session: RoleSession): FullSession {
  return session as unknown as FullSession;
}

// ─── Test fixtures ─────────────────────────────────────────────────────

/**
 * Manifest with a worker that has NO delegation block.
 */
const MANIFEST_NO_DELEGATION = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: worker
    max_visits: 3
    models:
      - model: stub:stub-model
        effort: medium
    system_prompt: .pi/roles/worker.md
    tools: [read, edit, write, handoff, end]
`;

// Note: MANIFEST_DELEGATION_NO_TOOL is intentionally unused because the manifest schema
// validates that a role with a delegation block MUST have `delegate` in its tools list.
// We keep it for documentation purposes.
const _MANIFEST_DELEGATION_NO_TOOL = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: worker
    max_visits: 3
    models:
      - model: stub:stub-model
        effort: medium
    system_prompt: .pi/roles/worker.md
    delegation:
      max_parallel: 2
      max_children: 5
      max_depth: 1
      workspace_modes: [read_only, worktree]
      max_child_cost_usd: 0.5
    tools: [read, edit, write, handoff, end]
`;

/**
 * Manifest with a worker that has BOTH delegation block AND delegate in tools.
 */
const MANIFEST_DELEGATION_WITH_TOOL = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: worker
    max_visits: 3
    models:
      - model: stub:stub-model
        effort: medium
    system_prompt: .pi/roles/worker.md
    delegation:
      max_parallel: 2
      max_children: 5
      max_depth: 1
      workspace_modes: [read_only, worktree]
      max_child_cost_usd: 0.5
    tools: [read, edit, write, handoff, end, delegate]
`;

// Note: MANIFEST_READ_ONLY_DELEGATION is kept for potential future expansion
const _MANIFEST_READ_ONLY_DELEGATION = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: reader
    max_visits: 5
    models:
      - model: stub:stub-model
        effort: medium
    system_prompt: .pi/roles/reader.md
    delegation:
      max_parallel: 1
      max_children: 3
      max_depth: 1
      workspace_modes: [read_only]
      max_child_cost_usd: 0.1
    tools: [read, handoff, end, delegate]
`;

// Note: MANIFEST_WORKTREE_DELEGATION is kept for potential future expansion
const _MANIFEST_WORKTREE_DELEGATION = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: builder
    max_visits: 3
    models:
      - model: stub:stub-model
        effort: medium
    system_prompt: .pi/roles/builder.md
    delegation:
      max_parallel: 2
      max_children: 10
      max_depth: 1
      workspace_modes: [worktree]
      max_child_cost_usd: 1.0
    tools: [read, edit, write, handoff, end, delegate]
`;

/**
 * Manifest with a system model path (no models list).
 */
const MANIFEST_SYSTEM_MODEL = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: worker
    max_visits: 3
    system_prompt: .pi/roles/worker.md
    tools: [read, edit, write, handoff, end]
`;

function makeModelRegistry(): ModelRegistry {
  const authStorage = AuthStorage.inMemory();
  const registry = ModelRegistry.inMemory(authStorage);
  const stubModel = makeStubModel();
  registry.registerProvider("stub", {
    api: "anthropic-messages" as const,
    apiKey: "stub-dummy-key-not-used",
    baseUrl: stubModel.baseUrl,
    streamSimple: makeStubStreamFunction({ steps: [] }),
    models: [
      {
        id: stubModel.id,
        name: stubModel.name,
        api: stubModel.api,
        baseUrl: stubModel.baseUrl,
        reasoning: stubModel.reasoning,
        input: [...stubModel.input],
        cost: { ...stubModel.cost },
        contextWindow: stubModel.contextWindow,
        maxTokens: stubModel.maxTokens,
      },
    ],
  });
  return registry;
}

function makeHost(
  workdir: string,
  manifestYaml: string,
  runId = "test-run-delegation",
): ProductionHost {
  const manifest = loadManifestFromString(manifestYaml);
  return new ProductionHost({
    modelRegistry: makeModelRegistry(),
    cwd: workdir,
    log: new InMemoryRecordLog(),
    loadedManifest: manifest,
    runId,
  });
}

// ─── ProductionHost — delegation wiring (R2.5) ─────────────────────

describe("ProductionHost — delegation wiring (R2.5)", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-prod-host-delegation-"));
    // Create prompt files for all roles
    await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
    await writeFile(
      join(workdir, ".pi/roles/worker.md"),
      "You are the worker. Worker prompt.",
      "utf8",
    );
    await writeFile(
      join(workdir, ".pi/roles/reader.md"),
      "You are the reader. Reader prompt.",
      "utf8",
    );
    await writeFile(
      join(workdir, ".pi/roles/builder.md"),
      "You are the builder. Builder prompt.",
      "utf8",
    );
    await writeFile(
      join(workdir, ".pi/roles/orchestrator.md"),
      "You are the orchestrator. Orchestrator prompt.",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  describe("delegate tool registration gate", () => {
    it("does NOT register delegate tool for role without delegation block", async () => {
      const host = makeHost(workdir, MANIFEST_NO_DELEGATION);
      const session = await host.spawnRole("worker");
      const toolNames = asFull(session).getActiveToolNames();
      expect(toolNames).not.toContain("delegate");
      await session.dispose();
    });

    // Note: The manifest schema validates that a role with a delegation block
    // MUST have `delegate` in its tools list (error: delegation-without-delegate-tool).
    // So the case "delegation block without delegate in tools" is rejected at
    // manifest load time, not at host spawn time.

    it("registers delegate tool for role with BOTH delegation block AND delegate in tools", async () => {
      const host = makeHost(workdir, MANIFEST_DELEGATION_WITH_TOOL);
      const session = await host.spawnRole("worker");
      const toolNames = asFull(session).getActiveToolNames();
      expect(toolNames).toContain("delegate");
      await session.dispose();
    });
  });

  describe("orchestrator role never gets delegate tool", () => {
    it("orchestrator without delegation block has no delegate tool", async () => {
      const host = makeHost(workdir, MANIFEST_NO_DELEGATION);
      const session = await host.spawnRole("orchestrator");
      const toolNames = asFull(session).getActiveToolNames();
      expect(toolNames).not.toContain("delegate");
      await session.dispose();
    });

    // Note: orchestrators with delegation blocks are also tested - the
    // orchestrator role in MANIFEST_DELEGATION_WITH_TOOL doesn't have
    // a delegation block, so it won't get the delegate tool.
    it("orchestrator in a manifest with another delegating role does not itself get delegate", async () => {
      const host = makeHost(workdir, MANIFEST_DELEGATION_WITH_TOOL);
      const session = await host.spawnRole("orchestrator");
      const toolNames = asFull(session).getActiveToolNames();
      expect(toolNames).not.toContain("delegate");
      await session.dispose();
    });
  });

  describe("tool allowlist composition", () => {
    it("role with delegation still gets handoff, end, and ask_user tools", async () => {
      const host = makeHost(workdir, MANIFEST_DELEGATION_WITH_TOOL);
      const session = await host.spawnRole("worker");
      const toolNames = asFull(session).getActiveToolNames();
      expect(toolNames).toContain("handoff");
      expect(toolNames).toContain("end");
      expect(toolNames).toContain("ask_user");
      await session.dispose();
    });

    it("role with delegation dedupes tools (no duplicate handoff/end entries)", async () => {
      const host = makeHost(workdir, MANIFEST_DELEGATION_WITH_TOOL);
      const session = await host.spawnRole("worker");
      const toolNames = asFull(session).getActiveToolNames();
      // Should have exactly one of each
      const handoffCount = toolNames.filter((t) => t === "handoff").length;
      const endCount = toolNames.filter((t) => t === "end").length;
      expect(handoffCount).toBe(1);
      expect(endCount).toBe(1);
      await session.dispose();
    });
  });

  describe("session file and metadata", () => {
    it("spawns a session with a non-empty sessionId", async () => {
      const host = makeHost(workdir, MANIFEST_NO_DELEGATION);
      const session = await host.spawnRole("worker");
      expect(session.sessionId).toBeTruthy();
      expect(session.sessionId.length).toBeGreaterThan(0);
      await session.dispose();
    });

    it("spawned session exposes the role name", async () => {
      const host = makeHost(workdir, MANIFEST_DELEGATION_WITH_TOOL);
      const session = await host.spawnRole("worker");
      expect((session as unknown as { role: string }).role).toBe("worker");
      await session.dispose();
    });

    it("spawned session has logical model for models list", async () => {
      const host = makeHost(workdir, MANIFEST_DELEGATION_WITH_TOOL);
      const session = await host.spawnRole("worker");
      // Worker has models list with stub:stub-model
      expect(session.model).toBe("stub:stub-model");
      await session.dispose();
    });

    it("spawned session has null model for system model path", async () => {
      const host = makeHost(workdir, MANIFEST_SYSTEM_MODEL);
      const session = await host.spawnRole("worker");
      // Worker has no models list, so model should be null
      expect(session.model).toBeNull();
      await session.dispose();
    });
  });

  describe("role without delegation does not affect other roles", () => {
    it("worker without delegation does not affect orchestrator", async () => {
      const host = makeHost(workdir, MANIFEST_NO_DELEGATION);
      const [workerSession, orchestratorSession] = await Promise.all([
        host.spawnRole("worker"),
        host.spawnRole("orchestrator"),
      ]);

      const workerTools = asFull(workerSession).getActiveToolNames();
      const orchestratorTools = asFull(orchestratorSession).getActiveToolNames();

      expect(workerTools).not.toContain("delegate");
      expect(orchestratorTools).not.toContain("delegate");

      await Promise.all([workerSession.dispose(), orchestratorSession.dispose()]);
    });

    it("worker with delegation does not affect other roles", async () => {
      const host = makeHost(workdir, MANIFEST_DELEGATION_WITH_TOOL);
      const [workerSession, orchestratorSession] = await Promise.all([
        host.spawnRole("worker"),
        host.spawnRole("orchestrator"),
      ]);

      const workerTools = asFull(workerSession).getActiveToolNames();
      const orchestratorTools = asFull(orchestratorSession).getActiveToolNames();

      expect(workerTools).toContain("delegate");
      expect(orchestratorTools).not.toContain("delegate");

      await Promise.all([workerSession.dispose(), orchestratorSession.dispose()]);
    });
  });

  describe("multiple role spawning", () => {
    it("same role spawned twice gets delegate tool on both sessions", async () => {
      const host = makeHost(workdir, MANIFEST_DELEGATION_WITH_TOOL);
      const [session1, session2] = await Promise.all([
        host.spawnRole("worker"),
        host.spawnRole("worker"),
      ]);

      const tools1 = asFull(session1).getActiveToolNames();
      const tools2 = asFull(session2).getActiveToolNames();

      expect(tools1).toContain("delegate");
      expect(tools2).toContain("delegate");
      // Sessions should have different IDs
      expect(session1.sessionId).not.toBe(session2.sessionId);

      await Promise.all([session1.dispose(), session2.dispose()]);
    });
  });

  describe("HandoffContext injection", () => {
    it("role with handoff_context_ref receives handoff_context tool along with delegate", async () => {
      const host = makeHost(workdir, MANIFEST_DELEGATION_WITH_TOOL);
      const session = await host.spawnRole("worker", {
        handoffContextRef: {
          run_id: "test-run",
          source_role: "orchestrator",
          source_session_file: "/tmp/orch-session.jsonl",
        },
      });
      const toolNames = asFull(session).getActiveToolNames();
      expect(toolNames).toContain("delegate");
      expect(toolNames).toContain("handoff_context");
      await session.dispose();
    });

    it("role without handoff_context_ref does not receive handoff_context tool", async () => {
      const host = makeHost(workdir, MANIFEST_DELEGATION_WITH_TOOL);
      const session = await host.spawnRole("worker");
      const toolNames = asFull(session).getActiveToolNames();
      expect(toolNames).toContain("delegate");
      expect(toolNames).not.toContain("handoff_context");
      await session.dispose();
    });
  });
});

describe("ProductionHost — production host exports (R2.5)", () => {
  it("ProductionHost is exported from the host barrel", async () => {
    // This is a compile-time check: if ProductionHost is not exported,
    // importing it from index.js would fail.
    const { ProductionHost: ImportedHost } = await import("../../src/host/index.js");
    expect(ImportedHost).toBeDefined();
  });

  it("ProductionHost is exported from the root barrel", async () => {
    const { ProductionHost: RootHost } = await import("../../src/index.js");
    expect(RootHost).toBeDefined();
  });
});
