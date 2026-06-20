/**
 * Task 7A.3 — ProductionHost.spawnRole wiring.
 *
 * Covers Task 7A.3's acceptance criteria:
 *   - `systemPromptOverride` is invoked through the resource loader
 *     path. (Asserted by reading `session.systemPrompt` after spawn;
 *     the SDK's `systemPrompt` getter returns the loader's
 *     `getSystemPrompt()`, which uses the override closure.)
 *   - `tools` contains role-declared tools plus force-injected
 *     `handoff` and `end` exactly once. (Asserted via
 *     `session.getActiveToolNames()` + the pure `buildToolsAllowlist`
 *     test.)
 *   - Role session files are created under a per-run conductor
 *     directory, not under pi's own session tree
 *     (`~/.pi/agent/sessions/<encoded-cwd>/`). (Asserted by
 *     checking the `sessionFile` path is under the host's
 *     `sessionDir`.)
 *   - No `ExtensionCommandContext.newSession()` / session-tree
 *     replacement surface is used. (Code-level: the implementation
 *     only calls `createAgentSession` + `SessionManager.create`,
 *     never `ctx.newSession`. The grep guard on `src/core` +
 *     `src/manifest` + `src/seam` + `src/cost` still holds; the
 *     production host stays in `src/host/` per invariant #1.)
 *
 * Splits from `production-host.test.ts` (which has the 7A.1 + 7A.2
 * tests) because the spawn test setup is heavier (real SDK session,
 * real model registry with a registered stub model) and the file
 * was approaching the 400-LOC ceiling.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import {
  buildToolsAllowlist,
  InMemoryRecordLog,
  type LoadedManifest,
  loadManifestFromString,
  ProductionHost,
  type RoleSession,
} from "../../src/index.js";

// ─── Test fixture ─────────────────────────────────────────────────────

/**
 * Manifest that uses the stub provider for the implementer role.
 * The stub provider must be registered with a `models` entry so
 * `ModelRegistry.find("stub", "stub-model")` returns the model —
 * `registerProvider` without a `models` list leaves the registry
 * with no models for that provider (the e2e test bypasses `find`
 * entirely by passing `model` directly; the production host goes
 * through `find` so we need the entry).
 */
const STUB_MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: implementer
    max_visits: 3
    models: [stub:stub-model]
    system_prompt: .pi/roles/implementer.md
    tools: [read, edit, handoff, end]
`;

function makeLoadedManifest(): LoadedManifest {
  return loadManifestFromString(STUB_MANIFEST);
}

function makeModelRegistryWithStub(): ModelRegistry {
  const authStorage = AuthStorage.inMemory();
  const registry = ModelRegistry.inMemory(authStorage);
  const stubModel = makeStubModel();
  // Steps: empty script → stream() emits a single
  // `done { reason: "stop", message }` (no tool call). The test
  // never invokes `session.prompt()`, so the script content is
  // inert — we only need the session to be constructible.
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
  cwd: string,
  overrides: { sessionDir?: string; agentDir?: string } = {},
): ProductionHost {
  return new ProductionHost({
    modelRegistry: makeModelRegistryWithStub(),
    cwd,
    log: new InMemoryRecordLog(),
    loadedManifest: makeLoadedManifest(),
    runId: "test-run-1",
    ...(overrides.sessionDir !== undefined && { sessionDir: overrides.sessionDir }),
    ...(overrides.agentDir !== undefined && { agentDir: overrides.agentDir }),
  });
}

// ─── buildToolsAllowlist — pure helper ────────────────────────────────

describe("buildToolsAllowlist — Task 7A.3", () => {
  it("returns just [handoff, end, ask_user] when the role declares no tools", () => {
    expect(buildToolsAllowlist(undefined)).toEqual(["handoff", "end", "ask_user"]);
    expect(buildToolsAllowlist([])).toEqual(["handoff", "end", "ask_user"]);
  });

  it("returns the role's tools plus handoff, end, and ask_user, in declared order", () => {
    const result = buildToolsAllowlist(["read", "edit", "bash"]);
    // Order: declared tools first (in order), then handoff, then end.
    expect(result).toEqual(["read", "edit", "bash", "handoff", "end", "ask_user"]);
  });

  it("deduplicates when the role already declares handoff, end, or ask_user exactly once", () => {
    const result = buildToolsAllowlist(["read", "handoff", "end", "ask_user"]);
    expect(result).toEqual(["read", "handoff", "end", "ask_user"]);
    expect(result.filter((n) => n === "handoff")).toHaveLength(1);
    expect(result.filter((n) => n === "end")).toHaveLength(1);
    expect(result.filter((n) => n === "ask_user")).toHaveLength(1);
  });
});

// ─── ProductionHost.spawnRole — Task 7A.3 wiring ─────────────────────

describe("ProductionHost.spawnRole — Task 7A.3 wiring", () => {
  let workdir: string;
  let rolePromptPath: string;
  let rolePromptMarker: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-prod-host-spawn-"));
    await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
    rolePromptPath = join(workdir, ".pi/roles/implementer.md");
    rolePromptMarker = "PROMPT_MARKER_spawn_test_7A3";
    await writeFile(
      rolePromptPath,
      `You are the implementer. ${rolePromptMarker}\nFollow the user's plan.`,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("invokes systemPromptOverride through the resource loader path (session.systemPrompt contains the loaded file)", async () => {
    const host = makeHost(workdir);
    const session = await host.spawnRole("implementer", { modelIndex: 0 });

    // The SDK's `AgentSession.systemPrompt` is sourced from the
    // resource loader's `getSystemPrompt()`, which uses our
    // `systemPromptOverride` closure. Asserting the marker is
    // present verifies the override was wired correctly.
    expect(asFull(session).systemPrompt).toContain(rolePromptMarker);

    await session.dispose();
  });

  it("creates the session file under a per-run conductor directory, not under pi's session tree", async () => {
    const host = makeHost(workdir);
    const session = await host.spawnRole("implementer", { modelIndex: 0 });

    // Plan: "rooted under the conductor run log directory rather
    // than pi's own session tree." Default `sessionDir` is
    // `<cwd>/.pi-conductor/runs/<runId>/sessions`.
    expect(session.sessionFile).toBeTruthy();
    expect(session.sessionFile).toContain(
      join(workdir, ".pi-conductor", "runs", host.runId, "sessions"),
    );
    // The path must NOT live under pi's default session tree
    // (~/.pi/agent/sessions/<encoded-cwd>/). The SessionManager's
    // default would be in `getSessionDir() = ~/.pi/agent/sessions/...`.
    // We can't predict the home path, so we assert the inverse:
    // the file is NOT under `~/.pi/agent/...`.
    const homePi = join(process.env.HOME ?? "/tmp", ".pi", "agent", "sessions");
    expect(session.sessionFile).not.toContain(homePi);

    await session.dispose();
  });

  it("force-includes handoff, end, and ask_user in the session's active tools exactly once", async () => {
    const host = makeHost(workdir);
    const session = await host.spawnRole("implementer", { modelIndex: 0 });
    const toolNames = asFull(session).getActiveToolNames();

    // The session is constructed with the custom handoff + end
    // tools and the `tools` allowlist. All should appear in
    // the active set. The role manifest already declares
    // [read, edit, handoff, end]; the `buildToolsAllowlist`
    // dedup keeps them exactly once each, and force-injects
    // ask_user for every role.
    expect(toolNames).toContain("handoff");
    expect(toolNames).toContain("end");
    expect(toolNames).toContain("ask_user");
    expect(toolNames.filter((n) => n === "handoff")).toHaveLength(1);
    expect(toolNames.filter((n) => n === "end")).toHaveLength(1);
    expect(toolNames.filter((n) => n === "ask_user")).toHaveLength(1);

    await session.dispose();
  });

  it("exposes the logical provider:id on the returned RoleSession for the §11.4 lifecycle record", async () => {
    const host = makeHost(workdir);
    const session = await host.spawnRole("implementer", { modelIndex: 0 });

    // The role's manifest declares `models: [stub:stub-model]`.
    // The `logical` field is the original `provider:id` string
    // the loop records on `session_started` (§11.4).
    expect(session.model).toBe("stub:stub-model");

    await session.dispose();
  });

  it("derives the per-run sessionDir from cwd + runId by default (constructor does NOT require it)", async () => {
    const host = makeHost(workdir);
    // Default derivation: `<cwd>/.pi-conductor/runs/<runId>/sessions`.
    expect(host.sessionDir).toBe(join(workdir, ".pi-conductor", "runs", host.runId, "sessions"));
    // The constructor mkdir's the dir so SessionManager.create
    // doesn't ENOENT.
    const { existsSync } = await import("node:fs");
    expect(existsSync(host.sessionDir)).toBe(true);
  });

  it("honors an explicit `sessionDir` override on the constructor options", async () => {
    const explicitDir = join(workdir, "explicit", "sessions");
    const host = makeHost(workdir, { sessionDir: explicitDir });
    expect(host.sessionDir).toBe(explicitDir);

    const session = await host.spawnRole("implementer", { modelIndex: 0 });
    expect(session.sessionFile).toContain(explicitDir);
    await session.dispose();
  });

  it("never uses `ExtensionCommandContext.newSession()` or any session-tree replacement surface (code-level check)", async () => {
    // Behavior: the production host only calls `createAgentSession`
    // + `SessionManager.create` (file-backed, branchless). The
    // phase-7a plan §1 rejects `ctx.newSession` / `ctx.fork` for
    // role sessions because that would put workers in pi's session
    // tree and break the host-owned `run_id`-keyed log (§11.1).
    //
    // This test is a smoke: spawn works (the wiring is correct) and
    // the sessionFile is in the conductor dir (not pi's tree). The
    // stronger "no `newSession` import" guarantee is enforced by
    // the grep guard on `src/core` + `src/manifest` + `src/seam`
    // + `src/cost` and by code review of `src/host/production-host.ts`
    // (no import of `ExtensionCommandContext` or any newSession /
    // fork surface).
    const host = makeHost(workdir);
    const session = await host.spawnRole("implementer", { modelIndex: 0 });
    expect(session.sessionFile).toBeTruthy();
    await session.dispose();
  });
});

// ─── Session teardown ────────────────────────────────────────────────
// Each `spawnRole` call creates a real SDK session (file-backed
// `SessionManager`, real `AgentSession`). `dispose()` must be called
// to release file descriptors. The test helper uses the
// `singleFork: true` vitest pool (`vitest.config.ts`) so all tests
// in this file share one Node process; the `afterEach` `rm -rf` on
// the temp cwd cleans the session files, but the FD is released
// by `session.dispose()` in each test.

// The `RoleSession` interface in `src/host/host.ts` exposes only
// the loop's seam surface. The 7A.3 tests need to read two SDK
// fields (`systemPrompt`, `getActiveToolNames()`) that the loop
// never sees. The cast is a one-line escape; the behavior is
// tested in the assertions.
type FullSession = RoleSession & {
  systemPrompt: string;
  getActiveToolNames(): string[];
};
function asFull(session: RoleSession): FullSession {
  return session as unknown as FullSession;
}
