/** Task 7A SDK-backed ProductionHost spawn behavior. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildToolsAllowlist, loadManifestFromString } from "../../src/index.js";
import { asFull, makeHost, makeLoadedV2Manifest } from "./production-host-fixture.js";

describe("buildToolsAllowlist — Task 7A.3", () => {
  it("returns just [handoff, end, ask_user] when the role declares no tools", () => {
    expect(buildToolsAllowlist(undefined)).toEqual(["handoff", "end", "ask_user"]);
    expect(buildToolsAllowlist([])).toEqual(["handoff", "end", "ask_user"]);
  });

  it("returns the role's tools plus handoff, end, and ask_user, in declared order", () => {
    expect(buildToolsAllowlist(["read", "edit", "bash"])).toEqual([
      "read",
      "edit",
      "bash",
      "handoff",
      "end",
      "ask_user",
    ]);
  });

  it("deduplicates force-injected tools", () => {
    const result = buildToolsAllowlist(["read", "handoff", "end", "ask_user"]);
    expect(result).toEqual(["read", "handoff", "end", "ask_user"]);
    expect(result.filter((name) => name === "handoff")).toHaveLength(1);
    expect(result.filter((name) => name === "end")).toHaveLength(1);
    expect(result.filter((name) => name === "ask_user")).toHaveLength(1);
  });

  it("adds the predecessor-only context tool only when a host reference is present", () => {
    expect(buildToolsAllowlist(["handoff_context"], false)).toEqual(["handoff", "end", "ask_user"]);
    expect(buildToolsAllowlist([], true)).toEqual([
      "handoff",
      "end",
      "ask_user",
      "handoff_context",
    ]);
    expect(buildToolsAllowlist(["handoff_context"], true)).toEqual([
      "handoff_context",
      "handoff",
      "end",
      "ask_user",
    ]);
  });
});

describe("ProductionHost.spawnRole — Task 7A.3 SDK wiring", () => {
  let workdir: string;
  let rolePromptMarker: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-prod-host-spawn-"));
    await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
    rolePromptMarker = "PROMPT_MARKER_spawn_test_7A3";
    await writeFile(
      join(workdir, ".pi/roles/implementer.md"),
      `You are the implementer. ${rolePromptMarker}\nFollow the user's plan.`,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("loads the system prompt through the resource-loader override", async () => {
    const session = await makeHost(workdir).spawnRole("implementer", { modelIndex: 0 });
    expect(asFull(session).systemPrompt).toContain(rolePromptMarker);
    await session.dispose();
  });

  it("creates its session file in the conductor run directory, not Pi's session tree", async () => {
    const host = makeHost(workdir);
    const session = await host.spawnRole("implementer", { modelIndex: 0 });
    expect(session.sessionFile).toContain(
      join(workdir, ".pi-conductor", "runs", host.runId, "sessions"),
    );
    expect(session.sessionFile).not.toContain(
      join(process.env.HOME ?? "/tmp", ".pi", "agent", "sessions"),
    );
    await session.dispose();
  });

  it("force-includes handoff, end, and ask_user exactly once", async () => {
    const session = await makeHost(workdir).spawnRole("implementer", { modelIndex: 0 });
    const names = asFull(session).getActiveToolNames();
    expect(names).toContain("handoff");
    expect(names).toContain("end");
    expect(names).toContain("ask_user");
    expect(names.filter((name) => name === "handoff")).toHaveLength(1);
    expect(names.filter((name) => name === "end")).toHaveLength(1);
    expect(names.filter((name) => name === "ask_user")).toHaveLength(1);
    await session.dispose();
  });

  it("registers the bounded predecessor context tool for a referenced handoff", async () => {
    const session = await makeHost(workdir).spawnRole("implementer", {
      modelIndex: 0,
      handoffContextRef: {
        run_id: "test-run-1",
        source_role: "orchestrator",
        source_session_file: "/tmp/previous-orchestrator.jsonl",
      },
    });
    const names = asFull(session).getActiveToolNames();
    expect(names.filter((name) => name === "handoff_context")).toHaveLength(1);
    await session.dispose();
  });

  it("exposes logical model and effort for lifecycle records", async () => {
    const session = await makeHost(workdir).spawnRole("implementer", { modelIndex: 0 });
    expect(session.model).toBe("stub:stub-model");
    expect(session.effort).toBe("max");
    await session.dispose();
  });

  it("defaults the system model path to medium effort", async () => {
    const manifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: implementer
    max_visits: 3
    system_prompt: .pi/roles/implementer.md
    tools: [read, edit, handoff, end]
`);
    const session = await makeHost(workdir, { loadedManifest: manifest }).spawnRole("implementer");
    expect(session.model).toBeNull();
    expect(session.effort).toBe("medium");
    await session.dispose();
  });

  it("derives and creates the default per-run session directory", async () => {
    const host = makeHost(workdir);
    expect(host.sessionDir).toBe(join(workdir, ".pi-conductor", "runs", host.runId, "sessions"));
    const { existsSync } = await import("node:fs");
    expect(existsSync(host.sessionDir)).toBe(true);
  });

  it("honors an explicit session directory", async () => {
    const sessionDir = join(workdir, "explicit", "sessions");
    const host = makeHost(workdir, { sessionDir });
    const session = await host.spawnRole("implementer", { modelIndex: 0 });
    expect(session.sessionFile).toContain(sessionDir);
    await session.dispose();
  });

  it("uses the standalone SDK session path rather than the extension session tree", async () => {
    const session = await makeHost(workdir).spawnRole("implementer", { modelIndex: 0 });
    expect(session.sessionFile).toBeTruthy();
    await session.dispose();
  });
});

describe("ProductionHost.spawnRole — v2 manifest-base-relative prompt", () => {
  let workdir: string;
  let manifestDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-prod-host-spawn-v2-cwd-"));
    manifestDir = await mkdtemp(join(tmpdir(), "pi-conductor-prod-host-spawn-v2-manifest-"));
    await mkdir(join(manifestDir, "roles"), { recursive: true });
    await writeFile(join(manifestDir, "roles", "implementer.md"), "V2_PROMPT_MARKER_7D4", "utf8");
    await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
    await writeFile(join(workdir, ".pi/roles/implementer.md"), "WRONG v1 content", "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    await rm(manifestDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("loads the v2 prompt from manifestDir rather than cwd", async () => {
    const session = await makeHost(workdir, {
      loadedManifest: makeLoadedV2Manifest(manifestDir),
    }).spawnRole("implementer", { modelIndex: 0 });
    expect(asFull(session).systemPrompt).toContain("V2_PROMPT_MARKER_7D4");
    expect(asFull(session).systemPrompt).not.toContain("WRONG v1 content");
    await session.dispose();
  });
});
