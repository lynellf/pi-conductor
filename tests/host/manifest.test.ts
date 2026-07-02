/**
 * Task 7D.2 — `LoadedManifest` carries `manifestDir` + `manifestVersion`.
 *
 * Covers the Phase 7D plan Task 7D.2 acceptance:
 *   - `loadManifest(path)` returns `manifestDir = dirname(path)`.
 *   - `loadManifestFromString(rawYaml)` returns `manifestDir = null`.
 *   - `loadManifestFromString(rawYaml, "/some/dir")` returns
 *     `manifestDir = "/some/dir"`.
 *   - `manifestVersion` matches the parsed `version:` field in
 *     all cases.
 *   - All existing callers of `loadManifestFromString` (tests,
 *     `defaults.test.ts`) still compile — the new param is optional.
 *
 * The new fields are additive; no existing assertion checks the
 * exact shape of `LoadedManifest`. The error-path test confirms
 * the loader's existing typed error (`HostManifestError`) is
 * unchanged for the malformed-input case.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HostManifestError,
  type LoadedManifest,
  loadManifest,
  loadManifestFromString,
} from "../../src/host/index.js";

// ─── Fixture ───────────────────────────────────────────────────────

const V1_MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: roles/orchestrator.md
`;

const V2_MANIFEST = `
version: 2
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: roles/orchestrator.md
`;

// ─── loadManifestFromString — manifestDir + manifestVersion ─────────

describe("loadManifestFromString — manifestDir + manifestVersion (Task 7D.2)", () => {
  it("returns manifestDir = null and manifestVersion = 1 when called with no manifestDir arg (v1)", () => {
    const loaded = loadManifestFromString(V1_MANIFEST);
    expect(loaded.manifestDir).toBeNull();
    expect(loaded.manifestVersion).toBe(1);
  });

  it("returns manifestVersion = 2 for a v2 manifest", () => {
    const loaded = loadManifestFromString(V2_MANIFEST);
    expect(loaded.manifestVersion).toBe(2);
  });

  it("returns manifestDir = null by default (test/programmatic path has no file path)", () => {
    // The default behavior: programmatic YAML loading has no
    // file path, so `manifestDir` is `null`. v1 manifests ignore
    // `manifestDir` (cwd-relative resolution); v2 manifests
    // loaded this way will fail to resolve relative prompts
    // (a deliberate, test-only error path — see production-host-resolve).
    const loaded = loadManifestFromString(V1_MANIFEST);
    expect(loaded.manifestDir).toBeNull();
  });

  it("returns manifestDir = the second arg when an explicit dir is passed", () => {
    const loaded = loadManifestFromString(V1_MANIFEST, "/some/explicit/dir");
    expect(loaded.manifestDir).toBe("/some/explicit/dir");
  });

  it("manifestVersion matches the parsed `version:` field for any valid value", () => {
    // Use a v5 manifest with a valid orchestrator to verify the
    // version integer flows through end-to-end. The v5 version is
    // arbitrary; the point is that the integer is preserved, not
    // collapsed to "1" or "2".
    const loaded = loadManifestFromString(`
version: 5
roles:
  - name: orchestrator
    is_orchestrator: true
`);
    expect(loaded.manifestVersion).toBe(5);
  });

  it("preserves the existing loaded shape (def, manifest, warnings) — fields are additive only", () => {
    const loaded = loadManifestFromString(V1_MANIFEST, "/dir");
    // The three pre-existing fields are unchanged.
    expect(loaded.def.manifest_version).toBe("1");
    expect(loaded.manifest.roles).toHaveLength(1);
    expect(loaded.warnings).toEqual([]);
  });

  it("still throws HostManifestError on hard validation failures (no behavior change)", () => {
    // An uncapped worker is a §13 hard error. The error class
    // and `errors[]` payload are unchanged; the new fields are
    // purely additive and never appear in the error path.
    const uncappedWorker = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: implementer
`;
    expect(() => loadManifestFromString(uncappedWorker)).toThrow(HostManifestError);
  });
});

// ─── loadManifest — manifestDir = dirname(path) ─────────────────────

describe("loadManifest — manifestDir is dirname(path) (Task 7D.2)", () => {
  let workdir: string;
  let manifestPath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-host-manifest-"));
    await mkdir(join(workdir, ".pi"), { recursive: true });
    manifestPath = join(workdir, ".pi", "conductor.yaml");
    await writeFile(manifestPath, V1_MANIFEST, "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("returns manifestDir = dirname(path) for a v1 manifest", async () => {
    const loaded = await loadManifest(manifestPath);
    expect(loaded.manifestDir).toBe(dirname(manifestPath));
  });

  it("returns manifestVersion matching the parsed `version:` field", async () => {
    const v2Path = join(workdir, ".pi", "v2.yaml");
    await writeFile(v2Path, V2_MANIFEST, "utf8");
    const loaded = await loadManifest(v2Path);
    expect(loaded.manifestVersion).toBe(2);
  });

  it("preserves the existing loaded shape (def, manifest, warnings) — fields are additive only", async () => {
    const loaded: LoadedManifest = await loadManifest(manifestPath);
    expect(loaded.def.manifest_version).toBe("1");
    expect(loaded.manifest.roles).toHaveLength(1);
    expect(loaded.warnings).toEqual([]);
  });
});

// ─── Provider-registration preflight check (Issue #6) ───────────────

describe("checkModelProvidersRegistered — preflight advisory check (T2.9)", () => {
  const MANIFEST_WITH_MODELS = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: ollama:robit/ornith:9b
        effort: medium
      - model: anthropic:claude-4
        effort: high
  - name: worker
    max_visits: 3
    models:
      - model: ollama:robit/ornith:9b
        effort: low
`;

  const MANIFEST_WITH_THREE_MISSING = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: provider-a:model-1
        effort: medium
      - model: provider-b:model-2
        effort: medium
      - model: provider-c:model-3
        effort: medium
`;

  const MANIFEST_NO_MODELS = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: roles/orchestrator.md
`;

  function emptyRegistry(): ModelRegistry {
    return ModelRegistry.inMemory(AuthStorage.inMemory());
  }

  function registryWithAnthropic(): ModelRegistry {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    // Override find to return a model only for "anthropic" without
    // calling registerProvider (which requires SDK-internal config).
    registry.find = (provider: string) => {
      if (provider === "anthropic") return {} as never;
      return undefined;
    };
    return registry;
  }

  it("emits unregistered-provider warning when registry find returns undefined", () => {
    const loaded = loadManifestFromString(MANIFEST_WITH_MODELS, null, emptyRegistry());
    // Both roles use ollama which is not registered; anthropic also not registered.
    const unregistered = loaded.warnings.filter((w) => w.code === "unregistered-provider");
    // 3 entries total: orchestrator has ollama + anthropic (both miss), worker has ollama (miss)
    expect(unregistered).toHaveLength(3);
    expect(unregistered[0]?.message).toContain("orchestrator");
    expect(unregistered[0]?.message).toContain("ollama:robit/ornith:9b");
  });

  it("no warning when registry find returns a model", () => {
    const loaded = loadManifestFromString(MANIFEST_WITH_MODELS, null, registryWithAnthropic());
    const unregistered = loaded.warnings.filter((w) => w.code === "unregistered-provider");
    // Only anthropic resolves; ollama entries still miss.
    expect(unregistered).toHaveLength(2);
    expect(unregistered.every((w) => w.message.includes("ollama"))).toBe(true);
  });

  it("no unregistered-provider warning when no ModelRegistry is passed (back-compat)", () => {
    const loaded = loadManifestFromString(MANIFEST_WITH_MODELS);
    const unregistered = loaded.warnings.filter((w) => w.code === "unregistered-provider");
    expect(unregistered).toHaveLength(0);
  });

  it("roles without models are skipped (system-model path)", () => {
    const loaded = loadManifestFromString(MANIFEST_NO_MODELS, null, emptyRegistry());
    const unregistered = loaded.warnings.filter((w) => w.code === "unregistered-provider");
    expect(unregistered).toHaveLength(0);
  });

  it("per-entry granularity: three missing entries → three warnings", () => {
    const loaded = loadManifestFromString(MANIFEST_WITH_THREE_MISSING, null, emptyRegistry());
    const unregistered = loaded.warnings.filter((w) => w.code === "unregistered-provider");
    expect(unregistered).toHaveLength(3);
  });

  it("hard errors still block: bare-model-alias throws before preflight check runs", () => {
    const bareAliasManifest = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: bare-alias
        effort: medium
`;
    expect(() => loadManifestFromString(bareAliasManifest, null, emptyRegistry())).toThrow(
      HostManifestError,
    );
  });
});
