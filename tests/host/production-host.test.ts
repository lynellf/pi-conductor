/**
 * Task 7A.1 + 7A.2 — ProductionHost scaffold, boundary errors, and
 * the pure resolution pieces used by `spawnRole` (§8.1).
 *
 * 7A.1 (this file's first two describe blocks):
 *   - ProductionHost satisfies the existing `Host` interface without
 *     changing the loop contract.
 *   - Boundary errors include the role name and the missing value in
 *     their messages.
 *   - The grep guard still allows pi imports only in `src/host`.
 *
 * 7A.2 (this file's last three describe blocks):
 *   - `selectModelEntry` returns the entry at index, or `null` for
 *     a role with omitted `models` (the "system model" path).
 *   - `resolveModel` returns `{ model, logical }` for a registry hit
 *     and throws `ModelNotFoundError` / `MalformedModelEntryError`
 *     on miss / malformed entry.
 *   - `loadSystemPrompt` returns the UTF-8 content of the prompt
 *     file, or `null` when no `system_prompt` is declared, and
 *     throws `SystemPromptNotFoundError` when the declared path
 *     is missing on disk.
 *
 * Table-driven where the spec enumerates cases. One assertion per
 * behavior; case names match the plan's 7A.1 / 7A.2 descriptions.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Host,
  InMemoryRecordLog,
  type LoadedManifest,
  loadManifestFromString,
  loadSystemPrompt,
  MalformedModelEntryError,
  ModelNotFoundError,
  ProductionHost,
  type RecordLog,
  resolveModel,
  SystemPromptNotFoundError,
  selectModelEntry,
} from "../../src/index.js";

// ─── Test fixture ─────────────────────────────────────────────────────

const VALID_MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: implementer
    max_visits: 3
    models: [anthropic:claude-opus-4-5, openai:gpt-4o]
    system_prompt: .pi/roles/implementer.md
    tools: [read, edit, write, handoff, end]
`;

function makeLoadedManifest(): LoadedManifest {
  return loadManifestFromString(VALID_MANIFEST);
}

function makeLog(): RecordLog {
  return new InMemoryRecordLog();
}

function makeModelRegistry(): ModelRegistry {
  // No providers registered; the constructor must not call into the
  // registry (it just stores the reference for 7A.2's `spawnRole`).
  return ModelRegistry.inMemory(AuthStorage.inMemory());
}

function makeHost(): ProductionHost {
  return new ProductionHost({
    modelRegistry: makeModelRegistry(),
    cwd: "/tmp/pi-conductor-test",
    log: makeLog(),
    loadedManifest: makeLoadedManifest(),
    runId: "test-run-1",
  });
}

// ─── Constructor + Host conformance ──────────────────────────────────

describe("ProductionHost — constructor + Host conformance", () => {
  it("constructs with the production context (modelRegistry, cwd, log, loadedManifest, runId)", () => {
    const host = makeHost();
    expect(host).toBeInstanceOf(ProductionHost);
  });

  it("assigns to the Host interface without changing the loop contract", () => {
    // The compile-time check is the real contract: if `ProductionHost`
    // drifts from `Host`, this assignment fails typecheck. The runtime
    // smoke below catches a class that satisfies the type but loses
    // methods at runtime (e.g., a `delete host.spawnRole` regression).
    const host: Host = makeHost();
    expect(typeof host.spawnRole).toBe("function");
    expect(typeof host.captureUsage).toBe("function");
    expect(typeof host.persistRecord).toBe("function");
    expect(typeof host.seedRunMemory).toBe("function");
    expect(typeof host.abortSession).toBe("function");
    expect(typeof host.sealSession).toBe("function");
    expect(typeof host.nextVisitIndex).toBe("function");
    expect(typeof host.sessionTerminalReason).toBe("function");
    expect(typeof host.getNextModel).toBe("function");
    expect(typeof host.runCostSoFar).toBe("function");
  });
});

// ─── Boundary errors — table-driven ──────────────────────────────────

describe("ProductionHost — boundary errors", () => {
  type ErrorCase = {
    readonly name: string;
    readonly build: (role: string, missing: string) => Error;
    readonly field: "entry" | "path";
  };

  const cases: readonly ErrorCase[] = [
    {
      name: "ModelNotFoundError: modelRegistry.find returned null for provider:id",
      build: (role, entry) => new ModelNotFoundError(role, entry),
      field: "entry",
    },
    {
      name: "MalformedModelEntryError: role.models entry is not provider:id",
      build: (role, entry) => new MalformedModelEntryError(role, entry),
      field: "entry",
    },
    {
      name: "SystemPromptNotFoundError: role.system_prompt path is declared but missing",
      build: (role, path) => new SystemPromptNotFoundError(role, path),
      field: "path",
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it("is a subclass of Error with a stable `name`", () => {
        const err = c.build("implementer", "anthropic:claude-opus-4-5");
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe(err.constructor.name);
      });

      it("includes the role name in the message", () => {
        const err = c.build("implementer", "anthropic:claude-opus-4-5");
        expect(err.message).toContain("implementer");
      });

      it("includes the missing value in the message", () => {
        const err = c.build("implementer", "anthropic:claude-opus-4-5");
        expect(err.message).toContain("anthropic:claude-opus-4-5");
      });

      it(`exposes the role and missing value (${c.field}) as readonly fields`, () => {
        const err = c.build("implementer", "anthropic:claude-opus-4-5") as Error & {
          readonly role: string;
          readonly [k: string]: unknown;
        };
        expect(err.role).toBe("implementer");
        expect(err[c.field]).toBe("anthropic:claude-opus-4-5");
      });
    });
  }
});

// ─── Task 7A.2: pure resolution pieces ───────────────────────────────
// Three pure functions used by `spawnRole` (7A.3 wires the real
// `createAgentSession` call; 7A.2 just exposes and tests the
// resolution). Each function is independently testable without
// touching the SDK's session factory.

describe("selectModelEntry — model-list selector (§8.1)", () => {
  it("returns the entry at the requested index when the role has a `models` list", () => {
    expect(
      selectModelEntry("implementer", { models: ["anthropic:claude-x", "openai:gpt-4o"] }, 0),
    ).toBe("anthropic:claude-x");
    expect(
      selectModelEntry("implementer", { models: ["anthropic:claude-x", "openai:gpt-4o"] }, 1),
    ).toBe("openai:gpt-4o");
  });

  it("returns null when the role's RoleConfig is undefined (system model path)", () => {
    expect(selectModelEntry("implementer", undefined, 0)).toBeNull();
  });

  it("returns null when the role's RoleConfig omits the `models` field (system model path)", () => {
    // A role with no `models` list uses the SDK's default. The
    // production host does NOT guess a provider alias — that's
    // the explicit "system model" path the plan calls out.
    expect(selectModelEntry("implementer", {}, 0)).toBeNull();
  });

  it("returns null when the role's `models` list is empty (system model path)", () => {
    expect(selectModelEntry("implementer", { models: [] }, 0)).toBeNull();
  });
});

describe("resolveModel — provider:id → Model + logical (§8.1)", () => {
  function makeFakeModel(): Model<never> {
    return {
      id: "claude-x",
      name: "Claude X (test)",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    } as unknown as Model<never>;
  }

  it("returns { model, logical } for a registry hit; `logical` is the original `provider:id`", () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    const fakeModel = makeFakeModel();
    vi.spyOn(registry, "find").mockReturnValue(
      fakeModel as unknown as ReturnType<typeof registry.find>,
    );

    const result = resolveModel("implementer", "anthropic:claude-x", registry);
    expect(result.model).toBe(fakeModel);
    expect(result.logical).toBe("anthropic:claude-x");
  });

  it("calls `modelRegistry.find(provider, id)` with the split parts (not the raw entry)", () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    const findSpy = vi
      .spyOn(registry, "find")
      .mockReturnValue(makeFakeModel() as unknown as ReturnType<typeof registry.find>);

    resolveModel("implementer", "anthropic:claude-x", registry);
    expect(findSpy).toHaveBeenCalledWith("anthropic", "claude-x");
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it("throws ModelNotFoundError when the registry returns undefined for a valid provider:id", () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    vi.spyOn(registry, "find").mockReturnValue(undefined);

    expect(() => resolveModel("implementer", "anthropic:claude-x", registry)).toThrow(
      ModelNotFoundError,
    );
    try {
      resolveModel("implementer", "anthropic:claude-x", registry);
    } catch (e) {
      const err = e as ModelNotFoundError;
      expect(err.role).toBe("implementer");
      expect(err.entry).toBe("anthropic:claude-x");
      expect(err.message).toContain("implementer");
      expect(err.message).toContain("anthropic:claude-x");
    }
  });

  // ─── Malformed entries — table-driven (§8.1, §13 bare-model-alias) ───
  describe("malformed `provider:id` entries throw MalformedModelEntryError", () => {
    const cases: readonly { readonly name: string; readonly entry: string }[] = [
      { name: "no colon separator", entry: "claude-x" },
      { name: "empty provider", entry: ":claude-x" },
      { name: "empty id", entry: "anthropic:" },
      { name: "multiple colons (only one allowed)", entry: "anthropic:claude:x" },
      { name: "empty string", entry: "" },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
        expect(() => resolveModel("implementer", c.entry, registry)).toThrow(
          MalformedModelEntryError,
        );
      });
    }
  });
});

describe("loadSystemPrompt — UTF-8 from cwd (§8.1)", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-prod-host-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns null when `path` is undefined (no `system_prompt` declared)", async () => {
    expect(await loadSystemPrompt("implementer", undefined, workdir)).toBeNull();
  });

  it("loads a declared prompt file as UTF-8 from cwd", async () => {
    const rolesDir = join(workdir, ".pi", "roles");
    await mkdir(rolesDir, { recursive: true });
    const promptPath = ".pi/roles/implementer.md";
    await writeFile(join(workdir, promptPath), "You are the implementer role.\n", "utf8");

    const content = await loadSystemPrompt("implementer", promptPath, workdir);
    expect(content).toBe("You are the implementer role.\n");
  });

  it("loads a declared absolute prompt path as-is (cwd ignored)", async () => {
    // Absolute paths are used verbatim — cwd only resolves relative
    // paths. The test writes a file in the temp dir and uses its
    // absolute path; the same content loads even though `cwd` points
    // at an unrelated directory.
    const rolesDir = join(workdir, ".pi", "roles");
    await mkdir(rolesDir, { recursive: true });
    const absPath = join(workdir, ".pi/roles/absolute.md");
    await writeFile(absPath, "absolute-path content", "utf8");

    const content = await loadSystemPrompt("implementer", absPath, "/some/other/dir");
    expect(content).toBe("absolute-path content");
  });

  it("throws SystemPromptNotFoundError when the declared prompt path is missing on disk", async () => {
    await expect(loadSystemPrompt("implementer", ".pi/roles/missing.md", workdir)).rejects.toThrow(
      SystemPromptNotFoundError,
    );
    try {
      await loadSystemPrompt("implementer", ".pi/roles/missing.md", workdir);
    } catch (e) {
      const err = e as SystemPromptNotFoundError;
      expect(err.role).toBe("implementer");
      expect(err.path).toBe(".pi/roles/missing.md");
      expect(err.message).toContain("implementer");
      expect(err.message).toContain(".pi/roles/missing.md");
    }
  });
});
