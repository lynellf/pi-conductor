/** Controller preflight uses the real fixed capability probe, without native-child admission. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runVerifiedSandboxCapabilityProbe } from "../../src/host/execution/sandbox/probe-runner.js";
import { classifySandboxProcess } from "../../src/host/execution/sandbox/process-observation.js";
import { capturePreparedRuntime } from "../../src/host/execution/sandbox/runtime-capture.js";
import { verifyPreparedRuntimeSnapshot } from "../../src/host/execution/sandbox/runtime-verify.js";
import type { SandboxProcessObservation } from "../../src/persistence/sandbox-process.js";
import { createRealDelegationFixture } from "./fixtures/bubblewrap-delegation-fixture.js";

describe("real controller runtime preflight", () => {
  it("proves confinement for a controller runtime without a fabricated child admission", async () => {
    const fixture = await createRealDelegationFixture();
    try {
      const parent = join(fixture.runStateDir, "controller-runtime");
      await mkdir(parent, { mode: 0o700 });
      const runtime = await capturePreparedRuntime({
        sourcePath: join(fixture.checkout, ".pi/runtime"),
        snapshotParent: parent,
        hostProtection: {
          primaryCheckout: fixture.checkout,
          stateRoots: [fixture.runStateDir],
          childWorkspaceRoots: [],
        },
        bootstrapApproval: fixture.hostApproval.bootstrapApproval,
      });
      const owner = {
        kind: "controller_operation",
        controller_id: "planner",
        operation_id: "preflight",
      };
      const { binaryPath, approvedBuilds, probeApproval } = fixture.hostApproval;
      const result = await runVerifiedSandboxCapabilityProbe({
        binaryPath,
        approvedBuilds,
        probeApproval,
        loadVerifiedContext: async () => ({
          runtime: await verifyPreparedRuntimeSnapshot(runtime, {
            snapshotParent: parent,
            bootstrapApproval: fixture.hostApproval.bootstrapApproval,
          }),
          artifactParent: parent,
          owner,
          writableRoots: [],
          environment: {},
        }),
      });
      expect(result.final.nspid.at(-1)).toBe(1);
      const { readFile } = await import("node:fs/promises");
      const ready = JSON.parse(await readFile(join(result.artifactPath, "ready.json"), "utf8")) as {
        sandbox: unknown;
      };
      expect(ready.sandbox).toEqual(owner);
    } finally {
      await fixture.cleanup();
    }
  }, 30000);

  it("settles the exact owned namespace when controller preparation is aborted before release", async () => {
    const fixture = await createRealDelegationFixture();
    try {
      const parent = join(fixture.runStateDir, "controller-runtime");
      await mkdir(parent, { mode: 0o700 });
      const runtime = await capturePreparedRuntime({
        sourcePath: join(fixture.checkout, ".pi/runtime"),
        snapshotParent: parent,
        hostProtection: {
          primaryCheckout: fixture.checkout,
          stateRoots: [fixture.runStateDir],
          childWorkspaceRoots: [],
        },
        bootstrapApproval: fixture.hostApproval.bootstrapApproval,
      });
      const abort = new AbortController();
      let owned: SandboxProcessObservation | undefined;
      const { binaryPath, approvedBuilds, probeApproval } = fixture.hostApproval;
      await expect(
        runVerifiedSandboxCapabilityProbe({
          binaryPath,
          approvedBuilds,
          probeApproval,
          signal: abort.signal,
          loadVerifiedContext: async () => ({
            runtime,
            artifactParent: parent,
            owner: { kind: "controller_operation", operation_id: "aborted-preparation" },
            writableRoots: [],
            environment: {},
          }),
          testHookBeforeReadyPersistence: async ({ final }) => {
            owned = final;
            abort.abort();
          },
        }),
      ).rejects.toMatchObject({ name: "SandboxCapabilityProbeError", cleanup: "confirmed" });
      if (owned === undefined) throw new Error("probe did not reach its owned namespace");
      expect(await classifySandboxProcess(owned)).not.toBe("alive");
    } finally {
      await fixture.cleanup();
    }
  }, 30000);
});
