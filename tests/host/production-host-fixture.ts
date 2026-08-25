import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import {
  InMemoryRecordLog,
  type LoadedManifest,
  loadManifestFromString,
  ProductionHost,
  type RoleSession,
} from "../../src/index.js";

const STUB_MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: implementer
    max_visits: 3
    models:
      - model: stub:stub-model
        effort: max
    system_prompt: .pi/roles/implementer.md
    tools: [read, edit, handoff, end]
`;

const STUB_V2_MANIFEST = `
version: 2
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: roles/orchestrator.md
    tools: [read, handoff, end]
  - name: implementer
    max_visits: 3
    models:
      - model: stub:stub-model
        effort: high
    system_prompt: roles/implementer.md
    tools: [read, edit, handoff, end]
`;

/** Build the registered stub model registry used by production-host behavior tests. */
export function makeModelRegistryWithStub(
  steps: readonly import("../../src/host/stub-provider.js").StubStep[] = [],
  modelIds: readonly string[] = ["stub-model"],
): ModelRegistry {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const stubModel = makeStubModel();
  registry.registerProvider("stub", {
    api: "anthropic-messages" as const,
    apiKey: "stub-dummy-key-not-used",
    baseUrl: stubModel.baseUrl,
    streamSimple: makeStubStreamFunction({ steps }),
    models: modelIds.map((id) => ({
      id,
      name: `${stubModel.name} (${id})`,
      api: stubModel.api,
      baseUrl: stubModel.baseUrl,
      reasoning: stubModel.reasoning,
      input: [...stubModel.input],
      cost: { ...stubModel.cost },
      contextWindow: stubModel.contextWindow,
      maxTokens: stubModel.maxTokens,
    })),
  });
  return registry;
}

/** Build the ordinary v1 production-host fixture. */
export function makeHost(
  cwd: string,
  overrides: {
    sessionDir?: string;
    agentDir?: string;
    loadedManifest?: LoadedManifest;
    log?: InMemoryRecordLog;
    steps?: readonly import("../../src/host/stub-provider.js").StubStep[];
  } = {},
): ProductionHost {
  return new ProductionHost({
    modelRegistry: makeModelRegistryWithStub(overrides.steps),
    cwd,
    log: overrides.log ?? new InMemoryRecordLog(),
    loadedManifest: overrides.loadedManifest ?? loadManifestFromString(STUB_MANIFEST),
    runId: "test-run-1",
    ...(overrides.sessionDir !== undefined && { sessionDir: overrides.sessionDir }),
    ...(overrides.agentDir !== undefined && { agentDir: overrides.agentDir }),
  });
}

/** Build a v2 manifest rooted at the directory containing its prompt files. */
export function makeLoadedV2Manifest(manifestDir: string): LoadedManifest {
  return loadManifestFromString(STUB_V2_MANIFEST, manifestDir);
}

type FullSession = RoleSession & {
  systemPrompt: string;
  getActiveToolNames(): string[];
};

/** Expose production-only SDK inspection fields used by SDK-spawn assertions. */
export function asFull(session: RoleSession): FullSession {
  return session as unknown as FullSession;
}
