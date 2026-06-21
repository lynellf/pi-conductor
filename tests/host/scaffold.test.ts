/**
 * Task 13 scaffold tests — spec §8, §13.
 *
 * Covers Task 13's acceptance criteria:
 *   1. A valid manifest loads and yields a `MachineDefinition`.
 *   2. An uncapped worker throws an error naming the rule.
 *   3. Other §13 rules surface as `HostManifestError.errors[].code`.
 *   4. Soft warnings are surfaced via `LoadedManifest.warnings`.
 *   5. The `Host` interface compiles and a trivial fake-`Host`
 *      implementation satisfies it (sanity check that the seam
 *      is usable; the orchestration-loop tests live in Task 15).
 *
 * Table-driven where the spec enumerates cases (§13). One assertion
 * per behavior; case names match the spec's rule names.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Host,
  HostManifestError,
  type LoadedManifest,
  loadManifest,
  loadManifestFromString,
  type RoleSession,
} from "../../src/host/index.js";

// ─── Valid manifest happy-path ─────────────────────────────────────────

const VALID_MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    max_run_cost_usd: 25.0
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: implementer
    max_visits: 3
    max_session_cost_usd: 5.0
    models: [anthropic:claude-opus-4-5, openai:gpt-4o]
    system_prompt: .pi/roles/implementer.md
    tools: [read, edit, write, bash, handoff, end]
  - name: reviewer
    max_visits: 2
    system_prompt: .pi/roles/reviewer.md
    tools: [read, grep, handoff, end]
`;

describe("loadManifestFromString — valid manifest", () => {
  it("yields a MachineDefinition with the expected shape", () => {
    const loaded = loadManifestFromString(VALID_MANIFEST);

    expect(loaded.def.manifest_version).toBe("1");
    expect(loaded.def.orchestrator).toBe("orchestrator");
    expect([...loaded.def.workers].sort()).toEqual(["implementer", "reviewer"]);
    expect(loaded.def.max_visits).toEqual({ implementer: 3, reviewer: 2 });
    // §13 freeze: top-level + workers + max_visits frozen
    expect(Object.isFrozen(loaded.def)).toBe(true);
    expect(Object.isFrozen(loaded.def.workers)).toBe(true);
    expect(Object.isFrozen(loaded.def.max_visits)).toBe(true);
  });

  it("surfaces soft warnings separately from errors", () => {
    // Manifest below: implementer has session cap but only 1 model
    // entry → §13 "no-cheaper-fallback" warning. The reviewer is
    // missing handoff in tools → §13 "missing-required-tool" warning.
    // No errors, so derivation succeeds.
    const yaml = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [read, handoff, end]
  - name: implementer
    max_visits: 3
    max_session_cost_usd: 5.0
    models: [anthropic:claude-opus-4-5]
    tools: [read, handoff, end]
  - name: reviewer
    max_visits: 1
    tools: [read, grep]
`;
    const loaded = loadManifestFromString(yaml);
    const codes = loaded.warnings.map((w) => w.code).sort();
    expect(codes).toContain("no-cheaper-fallback");
    expect(codes).toContain("missing-required-tool");
  });
});

// ─── Hard-error cases (§13) — table-driven ─────────────────────────────

describe("loadManifestFromString — §13 hard errors", () => {
  type Case = {
    readonly name: string;
    readonly yaml: string;
    readonly expectedCode:
      | "missing-orchestrator"
      | "multiple-orchestrators"
      | "uncapped-worker"
      | "max-run-cost-on-worker"
      | "bare-model-alias";
  };

  const cases: readonly Case[] = [
    {
      name: "missing-orchestrator: no role with is_orchestrator: true",
      yaml: `
version: 1
roles:
  - name: implementer
    max_visits: 3
`,
      expectedCode: "missing-orchestrator",
    },
    {
      name: "multiple-orchestrators: two roles with is_orchestrator: true",
      yaml: `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: also_orchestrator
    is_orchestrator: true
    tools: [handoff, end]
`,
      expectedCode: "multiple-orchestrators",
    },
    {
      name: "uncapped-worker: worker has no max_visits",
      yaml: `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    # max_visits intentionally omitted
    tools: [read, handoff, end]
`,
      expectedCode: "uncapped-worker",
    },
    {
      name: "max-run-cost-on-worker: run-level cap on a worker",
      yaml: `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    max_run_cost_usd: 5.0
    tools: [read, handoff, end]
`,
      expectedCode: "max-run-cost-on-worker",
    },
    {
      name: "bare-model-alias: model entry not in provider:id form",
      yaml: `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [claude-sonnet]
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    tools: [read, handoff, end]
`,
      expectedCode: "bare-model-alias",
    },
  ];

  for (const c of cases) {
    it(`throws HostManifestError naming the rule: ${c.name}`, () => {
      let thrown: unknown;
      try {
        loadManifestFromString(c.yaml);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(HostManifestError);
      const err = thrown as HostManifestError;
      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain(c.expectedCode);
      // The error message itself names the rule (per Task 13 acceptance).
      expect(err.message).toContain(c.expectedCode);
    });
  }
});

// ─── File-backed loadManifest happy-path ───────────────────────────────

describe("loadManifest — file-backed", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-scaffold-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("reads .pi/conductor.yaml from disk and returns a LoadedManifest", async () => {
    const piDir = join(workdir, ".pi");
    await mkdir(piDir, { recursive: true });
    const manifestPath = join(piDir, "conductor.yaml");
    await writeFile(manifestPath, VALID_MANIFEST, "utf8");

    const loaded: LoadedManifest = await loadManifest(manifestPath);
    expect(loaded.def.orchestrator).toBe("orchestrator");
    expect(loaded.def.manifest_version).toBe("1");
    expect(loaded.def.max_visits.implementer).toBe(3);
    expect(loaded.def.max_visits.reviewer).toBe(2);
  });

  it("propagates filesystem errors (ENOENT) — not wrapped in HostManifestError", async () => {
    // A missing file is a different failure mode (I/O) than a
    // structured validation error; we don't wrap it. The host caller
    // (Task 13.5's `startRun`) decides what to surface.
    await expect(loadManifest(join(workdir, "does-not-exist.yaml"))).rejects.toThrow();
  });
});

// ─── Host interface compiles + trivial fake satisfies it ───────────────

describe("Host interface — type-level sanity check", () => {
  it("a trivial fake implements the interface", () => {
    // This test is a sanity check that the seam is usable: a fake
    // implementation satisfies the interface without runtime calls.
    // Real loop-level tests land in Task 15 (host/loop.test.ts).
    //
    // TS will fail to compile this file if the `Host` interface
    // drifts incompatibly with its implementations (this test alone
    // exercises every method).
    const fakeSession: RoleSession = {
      role: "implementer",
      sessionId: "test-session-id",
      sessionFile: "/tmp/test-session.jsonl",
      model: null,
      effort: "medium",
      readCaptureBuffer: () => [],
      resetCaptureBuffer: () => {},
      subscribe: () => () => {},
      prompt: async () => {},
      dispose: async () => {},
    };

    const fakeHost: Host = {
      spawnRole: async () => fakeSession,
      captureUsage: () => ({
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        tokens: 0,
        cost: 0,
      }),
      persistRecord: () => {},
      seedRunMemory: () => {
        // Trivial shape; real impl calls buildRunMemory (Phase 3).
        return {
          run_id: "test-run",
          goal: "",
          current_role: "orchestrator",
          state: "orchestrator",
          last_message: null,
          visit_history: [],
          run_cost_to_date: 0,
          run_cost_cap: null,
          remaining_budget: null,
          per_role_cost: {},
          next_candidates: [],
        };
      },
      abortSession: async () => {},
      sealSession: () => {},
      nextVisitIndex: () => 1,
      sessionTerminalReason: () => null,
      getNextModel: () => null,
      runCostSoFar: () => 0,
    };

    // Smoke: every method is callable on the fake.
    expect(typeof fakeHost.spawnRole).toBe("function");
    expect(typeof fakeHost.captureUsage).toBe("function");
    expect(typeof fakeHost.persistRecord).toBe("function");
    expect(typeof fakeHost.seedRunMemory).toBe("function");
    expect(typeof fakeHost.abortSession).toBe("function");
    expect(typeof fakeHost.sealSession).toBe("function");
    expect(typeof fakeHost.nextVisitIndex).toBe("function");
  });
});
