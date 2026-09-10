/** Issue #103: durable admission must survive the owner process, under FSM §11–12. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  executionId,
  type ObserverResult,
  operatorNote,
  releaseSleeper,
  runId,
  sleeperIdentity,
  startSleeper,
} from "../tool-admission-restart-fixture.js";

const execFileAsync = promisify(execFile);
const sdkRequire = createRequire(
  realpathSync("node_modules/@earendil-works/pi-coding-agent/package.json"),
);
const jitiPath = sdkRequire.resolve("jiti");
const fixturePath = fileURLToPath(new URL("../tool-admission-restart-fixture.ts", import.meta.url));

async function subprocess<T>(mode: string, directory: string, token: string): Promise<T> {
  const script = `
const { createJiti } = require(${JSON.stringify(jitiPath)});
const jiti = createJiti(${JSON.stringify(fixturePath)}, { interopDefault: false });
jiti.import(${JSON.stringify(fixturePath)}).then(fixture => fixture.main(...process.argv.slice(1))).catch(error => { console.error(error); process.exitCode = 1; });
`;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["-e", script, "--", mode, directory, token],
    {
      timeout: 12_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as T;
}

describe.skipIf(process.platform !== "linux")("issue 103 cross-process admission recovery", () => {
  it.each([
    { scenario: "unrelated", description: "excludes a pre-existing inaccessible same-UID process" },
    {
      scenario: "descendant",
      description: "refuses a new unmarked inaccessible setsid descendant",
    },
    {
      scenario: "marked",
      description: "retains positive ownership even for a pre-existing process",
    },
  ] as const)("$description after the producer exits", async ({ scenario }) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-admission-restart-"));
    const token = randomUUID();
    try {
      const unrelated = await startSleeper(directory, "unrelated", true);
      await expect(readFile(`/proc/${unrelated.pid}/environ`)).rejects.toMatchObject({
        code: "EACCES",
      });
      const marked =
        scenario === "marked" ? await startSleeper(directory, "marked", false, token) : undefined;
      // Ensure the unrelated process is strictly older than the producer's
      // admission tick; equality deliberately carries no exclusion authority.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const producer = await subprocess<{ producerPid: number }>(
        scenario === "descendant" ? "produce-descendant" : "produce",
        directory,
        token,
      );
      const logPath = join(directory, `${runId}.jsonl`);
      const before = await readFile(logPath, "utf8");
      const inspection = await subprocess<ObserverResult>("observe", directory, token);
      expect(inspection.observerPid).not.toBe(producer.producerPid);
      expect(await readFile(logPath, "utf8")).toBe(before);
      if (scenario === "descendant") {
        const descendant = await sleeperIdentity(directory, "descendant");
        expect(descendant.parentPid).toBe(producer.producerPid);
        expect(descendant.sessionId).toBe(descendant.pid);
        expect(inspection).toMatchObject({
          ok: false,
          operation: "read_environ",
          code: "EACCES",
          pid: descendant.pid,
        });
        // A fresh observer must not manufacture a new baseline on confirmation.
        expect(await subprocess<ObserverResult>("confirm", directory, token)).toMatchObject({
          ok: false,
          operation: "read_environ",
          code: "EACCES",
          pid: descendant.pid,
        });
        expect(await readFile(logPath, "utf8")).toBe(before);
      } else if (scenario === "marked") {
        expect(inspection).toMatchObject({
          ok: true,
          executionIds: [executionId],
          processPids: [marked?.pid],
        });
        expect(await subprocess<ObserverResult>("confirm", directory, token)).toMatchObject({
          ok: false,
          code: "live_processes",
        });
        expect(await readFile(logPath, "utf8")).toBe(before);
      } else {
        expect(inspection).toMatchObject({
          ok: true,
          executionIds: [executionId],
          processPids: [],
        });
        expect(await subprocess<ObserverResult>("confirm", directory, token)).toMatchObject({
          ok: true,
          confirmed: true,
          executionIds: [],
        });
        const confirmed = JSON.parse(
          (await readFile(logPath, "utf8")).trim().split("\n").at(-1) ?? "null",
        ) as unknown;
        expect(confirmed).toMatchObject({
          type: "tool_execution_cleanup_confirmed",
          operator_note: operatorNote,
        });
      }
    } finally {
      await Promise.all(
        ["unrelated", "marked", "descendant"].map((name) => releaseSleeper(directory, name)),
      );
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
