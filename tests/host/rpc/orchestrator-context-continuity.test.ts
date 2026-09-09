/** Real RPC-child continuity proof for isolated retained context. */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prepareIsolatedContextRetention } from "../../../src/host/isolated-context-retention.js";
import { createNodeRoleSession } from "../../../src/host/rpc/node-role-session-factory.js";
import { InMemoryRecordLog } from "../../../src/persistence/in-memory-log.js";

const fixture = fileURLToPath(new URL("./fixtures/context-child-provider.ts", import.meta.url));

async function addFixtureExtension(configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.extensionPath = fixture;
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
}

function recordsFor(log: InMemoryRecordLog, runId: string, type: "context_invocation_started") {
  return log.records(runId).filter((record) => record.type === type);
}

describe("isolated RPC retained context", () => {
  it.each([
    false,
    true,
  ])("restores the exact prior history across two real child visits (first failure: %s)", async (firstFailure) => {
    const root = await mkdtemp(join(tmpdir(), "isolated-context-rpc-test-"));
    const sessionDir = join(root, "sessions");
    const agentDir = join(root, "agent");
    const machineToolsConfigPath = join(root, "machine-tools.json");
    await writeFile(
      machineToolsConfigPath,
      JSON.stringify({ workspaceRoot: root, mounts: [], declaredToolNames: ["end"] }),
    );
    const log = new InMemoryRecordLog();
    const runId = "isolated-context-rpc-run";
    const persistRecord = (record: Parameters<typeof log.append>[0]): void => log.append(record);
    const common = {
      log,
      persistRecord,
      runId,
      role: "orchestrator",
      visitIndex: 1,
      cwd: root,
      agentDir,
      sessionDir,
      childCwd: root,
      childSessionDir: sessionDir,
      childAgentDir: agentDir,
      machineToolsConfigPath,
      model: "context-child:context-child-model",
      effort: "off" as const,
      systemPrompt: null,
    };
    let first: Awaited<ReturnType<typeof prepareIsolatedContextRetention>> | undefined;
    let second: Awaited<ReturnType<typeof prepareIsolatedContextRetention>> | undefined;
    let firstSession: Awaited<ReturnType<typeof createNodeRoleSession>> | undefined;
    let secondSession: Awaited<ReturnType<typeof createNodeRoleSession>> | undefined;
    try {
      first = await prepareIsolatedContextRetention(common);
      await addFixtureExtension(first.contextConfigPath);
      firstSession = await createNodeRoleSession({
        role: "orchestrator",
        model: common.model,
        effort: "off",
        cwd: root,
        sessionDir,
        agentDir,
        systemPrompt: null,
        machineToolsConfigPath,
        contextConfigPath: first.contextConfigPath,
        roleSessionId: "logical-first",
        contextRetention: first.contextRetention,
      });
      first.attach({
        roleSessionId: "logical-first",
        physicalSessionId: firstSession.conversationId,
        conversationId: firstSession.conversationId,
        sessionFile: firstSession.sessionFile,
      });
      const firstStartedAt = Date.now();
      log.append({
        type: "session_started",
        run_id: runId,
        role: "orchestrator",
        visit_index: 1,
        state: "orchestrator",
        model: common.model,
        role_session_id: "logical-first",
        conversation_id: firstSession.conversationId,
        model_effort: "off",
        session_file: firstSession.sessionFile,
        parent_session: null,
        ts: firstStartedAt,
      });
      try {
        await first.wrapPrompt(firstSession.prompt.bind(firstSession))(
          firstFailure ? "fail-first" : "first seed",
        );
      } catch {
        // The failed model attempt still has durable seed history.
      }
      const firstUsage = firstSession.captureUsage();
      log.append({
        type: firstFailure ? "session_failed" : "session_ended",
        run_id: runId,
        role: "orchestrator",
        visit_index: 1,
        state: "orchestrator",
        model: common.model,
        role_session_id: "logical-first",
        conversation_id: firstSession.conversationId,
        model_effort: "off",
        session_file: firstSession.sessionFile,
        parent_session: null,
        usage: firstUsage,
        ...(firstFailure ? { failure_reason: "model_error" } : {}),
        ts: firstStartedAt + 1,
      });
      const firstBytes = await readFile(firstSession.sessionFile);
      const firstBoundary = await first.retainedContext.captureBoundary();
      await firstSession.dispose();
      await first.retainedContext.commitBoundary(firstBoundary);
      await first.close();
      first = undefined;

      second = await prepareIsolatedContextRetention({
        ...common,
        visitIndex: 2,
        model: firstFailure ? "context-child:context-child-next" : common.model,
      });
      await addFixtureExtension(second.contextConfigPath);
      secondSession = await createNodeRoleSession({
        role: "orchestrator",
        model: firstFailure ? "context-child:context-child-next" : common.model,
        effort: "off",
        cwd: root,
        sessionDir,
        agentDir,
        systemPrompt: null,
        machineToolsConfigPath,
        contextConfigPath: second.contextConfigPath,
        roleSessionId: "logical-second",
        contextRetention: second.contextRetention,
      });
      second.attach({
        roleSessionId: "logical-second",
        physicalSessionId: secondSession.conversationId,
        conversationId: secondSession.conversationId,
        sessionFile: secondSession.sessionFile,
      });
      const secondStartedAt = Date.now();
      log.append({
        type: "session_started",
        run_id: runId,
        role: "orchestrator",
        visit_index: 2,
        state: "orchestrator",
        model: firstFailure ? "context-child:context-child-next" : common.model,
        role_session_id: "logical-second",
        conversation_id: secondSession.conversationId,
        model_effort: "off",
        session_file: secondSession.sessionFile,
        parent_session: null,
        ts: secondStartedAt,
      });
      expect(secondSession.conversationId).not.toBe(firstSession.conversationId);
      await second.wrapPrompt(secondSession.prompt.bind(secondSession))("second seed");
      expect(secondSession.readCaptureBuffer()).toEqual(
        expect.arrayContaining([expect.objectContaining({ toolName: "end" })]),
      );
      const secondUsage = secondSession.captureUsage();
      log.append({
        type: "session_ended",
        run_id: runId,
        role: "orchestrator",
        visit_index: 2,
        state: "orchestrator",
        model: firstFailure ? "context-child:context-child-next" : common.model,
        role_session_id: "logical-second",
        conversation_id: secondSession.conversationId,
        model_effort: "off",
        session_file: secondSession.sessionFile,
        parent_session: null,
        usage: secondUsage,
        ts: secondStartedAt + 1,
      });
      const secondBytes = await readFile(secondSession.sessionFile, "utf8");
      expect(secondBytes).toContain(firstFailure ? "fail-first" : "first seed");
      expect(secondBytes).toContain("second seed");
      expect(secondBytes).toContain(firstFailure ? "context-child-next" : "context-child-model");
      expect(recordsFor(log, runId, "context_invocation_started").at(-1)?.model).toBe(
        firstFailure ? "context-child:context-child-next" : common.model,
      );
      const secondBoundary = await second.retainedContext.captureBoundary();
      await secondSession.dispose();
      expect(await readFile(firstSession.sessionFile)).toEqual(firstBytes);
      await second.retainedContext.commitBoundary(secondBoundary);

      const records = log.records(runId);
      expect(records.filter((record) => record.type === "context_invocation_started")).toHaveLength(
        2,
      );
      expect(records.filter((record) => record.type === "context_boundary_committed")).toHaveLength(
        2,
      );
      expect(records.filter((record) => record.type === "context_delivery_committed")).toHaveLength(
        2,
      );
      expect(
        new Set(
          records
            .filter((record) => record.type === "context_invocation_started")
            .map((record) => record.role_session_id),
        ).size,
      ).toBe(2);
    } finally {
      await firstSession?.dispose().catch(() => undefined);
      await secondSession?.dispose().catch(() => undefined);
      await first?.close().catch(() => undefined);
      await second?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
