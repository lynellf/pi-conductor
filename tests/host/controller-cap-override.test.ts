import { rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { RunControl } from "../../src/host/run-control.js";
import { RunHandle } from "../../src/host/run-handle.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { controllerSessionFixture } from "./fixtures/controller-role-session-fixture.js";

it("lowering the live cap wakes a waiting controller without another durable event", async () => {
  let calls = 0;
  const fixture = await controllerSessionFixture({
    invokePlanner: async (request) => {
      calls += 1;
      return {
        protocol_version: 1,
        run_id: request.run_id,
        controller_id: request.controller_id,
        definition_digest: request.definition_digest,
        activation_id: request.activation_id,
        owner_epoch: request.owner_epoch,
        state_revision: request.state_revision,
        event_cursor: request.page_cursor,
        state: {},
        decision: "wait",
      };
    },
  });
  const runId = fixture.activation.run_id;
  const control = new RunControl({
    runId,
    abortSession: async (session) => session.abortOwnedWork?.(),
  });
  await control.setActiveSession(fixture.session);
  const log = new InMemoryRecordLog();
  log.append({
    type: "session_ended",
    run_id: runId,
    role: "orchestrator",
    visit_index: 1,
    state: "orchestrator",
    model: null,
    session_file: "previous-session",
    parent_session: null,
    usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, tokens: 2, cost: 1 },
    ts: 1,
  });
  const loadedManifest = loadManifestFromString(
    "version: 1\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n",
  );
  const handle = new RunHandle({
    runId,
    def: loadedManifest.def,
    log,
    loadedManifest,
    configOverrideContainer: { current: {} },
    requestAbort: async () => undefined,
    runControl: control,
    completionPromise: new Promise(() => undefined),
  });
  const prompting = fixture.session.prompt("ignored");
  try {
    await vi.waitFor(() => expect(calls).toBe(1));
    handle.runConfig({ maxRunCostUsd: 0.5 });
    await vi.waitFor(() =>
      expect(fixture.session.getHostTermination?.()).toEqual({ kind: "run_cost_cap" }),
    );
    await prompting;
    expect(fixture.session.readCaptureBuffer()).toEqual([]);
    expect(calls).toBe(1);
  } finally {
    await fixture.session.abortOwnedWork?.();
    await prompting.catch(() => undefined);
    await fixture.session.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
