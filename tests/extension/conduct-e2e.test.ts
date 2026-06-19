/**
 * Phase 7B Task 7B.4 — stub-driven E2E for `/conduct`.
 *
 * The plan's 7B.4 acceptance:
 *   1. During a stub-driven run, the status line
 *      updates on role transitions and clears at
 *      completion.
 *   2. `/conduct <goal>` with the stub provider reaches
 *      a terminal state and notifies.
 *   3. `pi -e ./extensions/conduct.ts` loads and
 *      exposes `/conduct`, or the chosen in-process
 *      harness documents why it is equivalent.
 *   4. A test fails if `extensions/conduct.ts`
 *      references `ctx.newSession` or `ctx.fork`.
 *      (Enforced by `no-role-spawn-via-session-tree.test.ts`.)
 *
 * This file covers (1) and (2) via the in-process
 * extension harness (the recording fake API in
 * `conduct-harness.ts`) driven against a real
 * `ProductionHost` + stub provider. The setup mirrors
 * `tests/host/production-host-parity.test.ts` so the
 * extension E2E reads as a direct end-to-end
 * composition: the harness invokes the registered
 * handler, the handler calls `startRun`, `startRun`
 * calls `runLoop`, the loop drives the production
 * host, the production host calls `createAgentSession`
 * with the stub stream function, the loop reaches
 * `done`.
 *
 * (3) is satisfied by `conduct-registration.test.ts`:
 * the recording harness invokes the factory with the
 * same shape of API pi passes to extension factories
 * (same field names, same types — see the harness for
 * the structural mapping). `pi -e ./extensions/conduct.ts`
 * would drive the same code path; the in-process
 * harness is documented as equivalent because it
 * invokes the exact same exported factory function
 * (`conductExtension`) with a recording API that
 * captures the same registrations.
 *
 * (4) is enforced by the grep guard in
 * `no-role-spawn-via-session-tree.test.ts`.
 *
 * Companion tests:
 *   - `conduct-registration.test.ts` — Task 7B.1
 *   - `conduct-start.test.ts` — Task 7B.2
 *   - `conduct-resume.test.ts` — Task 7B.3 (resume)
 *   - `conduct-list.test.ts` — Task 7B.3 (list)
 *   - `conduct-abort.test.ts` — Task 7B.3 (abort)
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONDUCT_STATUS_KEY } from "../../src/extension/status.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import { listRuns } from "../../src/index.js";
import { loadExtension, makeCtx, type NotifyCall, type StatusUpdate } from "./conduct-harness.js";

describe("extension shell — Task 7B.4: stub-driven E2E", () => {
  let workdir: string;
  let manifestPath: string;
  let modelRegistry: ModelRegistry;
  let notifyCalls: NotifyCall[];
  let statusUpdates: StatusUpdate[];

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-e2e-"));
    // Write the manifest + role prompt files.
    await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
    await writeFile(
      join(workdir, ".pi", "conductor.yaml"),
      `version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [stub:stub-model]
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: worker
    max_visits: 3
    models: [stub:stub-model]
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
`,
      "utf8",
    );
    await writeFile(
      join(workdir, ".pi", "roles", "orchestrator.md"),
      "You are the orchestrator.",
      "utf8",
    );
    await writeFile(join(workdir, ".pi", "roles", "worker.md"), "You are the worker.", "utf8");
    manifestPath = join(workdir, ".pi", "conductor.yaml");

    // Register the stub provider with a 3-step
    // script: orchestrator → handoff(worker) →
    // worker → handoff(orchestrator) → orchestrator
    // → end. The same script the
    // production-host-parity test uses (Task 7A.4).
    const authStorage = AuthStorage.inMemory();
    modelRegistry = ModelRegistry.inMemory(authStorage);
    const stubModel = makeStubModel();
    modelRegistry.registerProvider("stub", {
      api: "anthropic-messages" as const,
      apiKey: "stub-dummy-key-not-used",
      baseUrl: stubModel.baseUrl,
      streamSimple: makeStubStreamFunction({
        steps: [
          { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
          { kind: "emit_handoff", target_role: "orchestrator", reason: "worker done" },
          { kind: "emit_end", reason: "all done" },
        ],
      }),
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

    notifyCalls = [];
    statusUpdates = [];
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    // Clear the active-run tracker between tests so
    // a crashed run doesn't leak into the next.
    const { setActiveRun } = await import("../../src/extension/active-run.js");
    setActiveRun(null);
  });

  it("/conduct <goal> reaches a terminal state, notifies, and clears the status line", async () => {
    const ext = await loadExtension("<test>", workdir);
    const conduct = ext.commands.get("conduct");
    expect(conduct).toBeDefined();

    await conduct?.handler(
      "do the thing",
      makeCtx({
        cwd: workdir,
        modelRegistry,
        manifestPath,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
        setStatus: (key, text) => statusUpdates.push({ key, text }),
      }),
    );

    // Terminal notification: the spec/plan require a
    // `run_id` and terminal reason/state in the
    // completion notification.
    const terminalNotif = notifyCalls.find(
      (n) => n.type === "info" && /run_id=/.test(n.msg) && /state=/.test(n.msg),
    );
    expect(terminalNotif).toBeDefined();
    // The terminal state should be "done" (stub
    // script ends with `emit_end` from the
    // orchestrator).
    expect(terminalNotif?.msg).toMatch(/state=done/);
    expect(terminalNotif?.msg).toMatch(/reason=done/);

    // Status updates: at least one render during the
    // run, cleared on completion. The exact number
    // of intermediate updates depends on the
    // poller's tick rate; we only assert that the
    // line was rendered with the conduct key, and
    // the last update cleared the line.
    expect(statusUpdates.length).toBeGreaterThan(0);
    expect(statusUpdates.every((u) => u.key === CONDUCT_STATUS_KEY)).toBe(true);
    const lastStatus = statusUpdates[statusUpdates.length - 1];
    expect(lastStatus?.text).toBeUndefined();

    // The active-run tracker is cleared on terminal.
    const { getActiveRun } = await import("../../src/extension/active-run.js");
    expect(getActiveRun()).toBeNull();

    // The file-backed log under
    // <cwd>/.pi-conductor/runs/ now has the run.
    // /conduct:list can find it on a fresh
    // invocation.
    const { resolveRunBaseDir } = await import("../../src/extension/commands/start.js");
    const ids = listRuns(resolveRunBaseDir(workdir));
    expect(ids).toHaveLength(1);
  });
});
