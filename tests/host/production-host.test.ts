/**
 * Task 7A.1 — ProductionHost scaffold + boundary errors.
 *
 * Covers Task 7A.1's acceptance criteria:
 *   - ProductionHost satisfies the existing `Host` interface without
 *     changing the loop contract.
 *   - Boundary errors include the role name and the missing value in
 *     their messages.
 *   - The grep guard still allows pi imports only in `src/host`.
 *
 * The class body is a minimal scaffold: every `Host` method throws a
 * not-yet-implemented error. 7A.2–7A.4 fill in the real wiring
 * (`spawnRole` model + prompt resolution, `DefaultResourceLoader`,
 * `SessionManager`, the parity-with-StubHost semantics). This task
 * only delivers the surface — constructor + typed errors — so the
 * loop has a usable type and the boundary failures are typed.
 *
 * Table-driven where the spec enumerates cases (the three error
 * types are the only "cases" 7A.1 enumerates). One assertion per
 * behavior; case names match the plan's 7A.1 description.
 */

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  type Host,
  InMemoryRecordLog,
  type LoadedManifest,
  loadManifestFromString,
  MalformedModelEntryError,
  ModelNotFoundError,
  ProductionHost,
  type RecordLog,
  SystemPromptNotFoundError,
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
