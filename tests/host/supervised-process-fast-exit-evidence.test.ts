import { afterEach, describe, expect, it, vi } from "vitest";
import { runSupervisedProcess } from "../../src/host/execution/supervised-process.js";
import * as identity from "../../src/host/execution/supervised-process-identity.js";

const childScript =
  "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:'ignore'}); child.unref(); setTimeout(()=>process.exit(0),200);";

async function killOwned(marker: string, minimumStartTime: string): Promise<void> {
  const owned = await identity.findProcessesByOwnerToken(marker, minimumStartTime);
  for (const processIdentity of owned) {
    const current = await identity.readProcessIdentity(processIdentity.pid, marker);
    if (
      current?.pid === processIdentity.pid &&
      current.startTime === processIdentity.startTime &&
      current.processGroupId === processIdentity.processGroupId
    ) {
      try {
        process.kill(processIdentity.pid, "SIGKILL");
      } catch (error) {
        // The test-owned sleeper may have exited.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await identity.findProcessesByOwnerToken(marker, minimumStartTime)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await expect(identity.findProcessesByOwnerToken(marker, minimumStartTime)).resolves.toHaveLength(
    0,
  );
}

describe("fast-exit supervised process evidence", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["observed admission", false, true],
    ["missing admission", true, false],
  ] as const)(
    "retains surviving child evidence for %s",
    async (_name, forceMissing, leaderObserved) => {
      const marker = `fast-exit-evidence-${process.pid}-${Date.now()}-${forceMissing ? "missing" : "observed"}`;
      const supervisor = await identity.readProcessIdentity(process.pid);
      if (supervisor === null) throw new Error("test supervisor identity unavailable");
      let missingPid: number | undefined;
      if (forceMissing) {
        const original = identity.readProcessIdentity;
        vi.spyOn(identity, "readProcessIdentity").mockImplementation(async (pid, ownerToken) => {
          if (ownerToken !== undefined && missingPid === undefined && pid !== process.pid) {
            missingPid = pid;
            return null;
          }
          return original(pid, ownerToken);
        });
      }
      try {
        let rejected: unknown;
        try {
          await runSupervisedProcess({
            executionId: marker,
            file: process.execPath,
            args: ["-e", childScript],
            cwd: process.cwd(),
            timeoutMs: 3_000,
            graceMs: 100,
            onStart: () => undefined,
          });
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toMatchObject({
          code: "supervised-process-spawn-failed",
          cleanup: "unconfirmed",
          diagnostic: {
            cleanup_cause: forceMissing
              ? "leader_exited_with_owned_descendants"
              : "escaped_owned_processes",
            leader_observed: leaderObserved,
          },
        });
        const owned = await identity.findProcessesByOwnerToken(marker, supervisor.startTime);
        expect(owned.length).toBeGreaterThan(0);
        expect(owned.every((item) => BigInt(item.startTime) >= BigInt(supervisor.startTime))).toBe(
          true,
        );
        expect(owned.every((item) => item.processGroupId > 0)).toBe(true);
        const observed = (
          rejected as {
            diagnostic: {
              observed_members: readonly {
                pid: number;
                start_time: string;
                process_group_id: number;
              }[];
            };
          }
        ).diagnostic.observed_members;
        expect(observed.length).toBeGreaterThan(0);
        expect(
          observed.every((item) =>
            owned.some(
              (candidate) =>
                candidate.pid === item.pid &&
                candidate.startTime === item.start_time &&
                candidate.processGroupId === item.process_group_id,
            ),
          ),
        ).toBe(true);
      } finally {
        await killOwned(marker, supervisor.startTime);
      }
    },
    15_000,
  );
});
