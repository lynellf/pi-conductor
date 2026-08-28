import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { describe, expect, it } from "vitest";
import { serializeActiveToolDefinitions } from "../../src/host/trajectory-admission.js";
import {
  createInitialCheckpoint,
  FileRecordLog,
  InMemoryRecordLog,
  loadManifest,
  loadManifestFromString,
  ProductionHost,
  resumeRun,
  type SessionLifecycleEvent,
} from "../../src/index.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import {
  createManifestSnapshot,
  sha256Canonical,
  TrajectoryResumeError,
} from "../../src/persistence/trajectory-records.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

function lastUserText(request: unknown): string | null {
  if (typeof request !== "object" || request === null || !("messages" in request)) return null;
  const messages = (request as { readonly messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "user" &&
      "content" in message
    ) {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) continue;
      const content = message.content[0];
      if (
        typeof content === "object" &&
        content !== null &&
        "text" in content &&
        typeof content.text === "string"
      ) {
        return content.text;
      }
    }
  }
  return null;
}

const MANIFEST = `
version: 1
handoffs:
  - from: orchestrator
    to: implementer
    mode: trajectory
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: implementer
    max_visits: 1
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: .pi/roles/implementer.md
    tools: [handoff, end]
`;

describe("Issue #63 trajectory resume", () => {
  it("reopens the selected physical conversation rather than creating a fresh target", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-trajectory-resume-"));
    try {
      const baseDir = join(workdir, "runs");
      const manifestPath = join(workdir, ".pi", "conductor.yaml");
      await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
      await writeFile(manifestPath, MANIFEST, "utf8");
      await writeFile(
        join(workdir, ".pi", "settings.json"),
        JSON.stringify({ compaction: { enabled: true } }),
        "utf8",
      );
      await writeFile(join(workdir, ".pi", "roles", "orchestrator.md"), "ORCHESTRATOR", "utf8");
      await writeFile(join(workdir, ".pi", "roles", "implementer.md"), "IMPLEMENTER", "utf8");
      const loaded = await loadManifest(manifestPath);
      const checkpoint = createInitialCheckpoint(loaded.def);
      const resumedCheckpoint = {
        ...checkpoint,
        current_role: "implementer",
        visit_count: { implementer: 1 },
        updated_at: 1,
      };
      const log = new FileRecordLog({ baseDir });
      log.append(
        createManifestSnapshot({
          runId: checkpoint.run_id,
          manifest: loaded.manifest,
          definition: loaded.def,
          ts: 1,
        }),
      );
      log.append({ type: "checkpoint_snapshot", checkpoint: resumedCheckpoint });
      log.append({ type: "run_seeded", run_id: checkpoint.run_id, goal: "resume", ts: 1 });

      const registry = makeModelRegistryWithStub();
      const sourceHost = new ProductionHost({
        modelRegistry: registry,
        cwd: workdir,
        log,
        loadedManifest: loaded,
        runId: checkpoint.run_id,
      });
      const source = await sourceHost.spawnRole("orchestrator");
      await source.prompt("source trajectory");
      const sourceConversation = {
        id: source.conversationId ?? source.sessionId,
        file: source.sessionFile,
      };
      const sourceContext = source.getTrajectoryContext?.();
      if (sourceContext === undefined) throw new Error("source did not expose trajectory context");
      const activeToolNames = ["handoff", "end", "ask_user"];
      const activeToolDefinitions = serializeActiveToolDefinitions(
        activeToolNames.map((name) => sourceContext.toolDefinitions[name]),
      );
      await source.dispose();
      log.append({
        type: "session_ended",
        run_id: checkpoint.run_id,
        role: "orchestrator",
        visit_index: 1,
        state: "implementer",
        model: "stub:stub-model",
        session_file: source.sessionFile,
        parent_session: null,
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
        role_session_id: source.sessionId,
        conversation_id: sourceConversation.id,
        ts: 2,
      });
      log.append({
        type: "handoff_transport_selected",
        schema_version: 1,
        run_id: checkpoint.run_id,
        source_role_session_id: source.sessionId,
        from: "orchestrator",
        to: "implementer",
        mode: "trajectory",
        source_conversation: sourceConversation,
        target: {
          model: "stub:stub-model",
          requested_effort: "off",
          system_prompt: "IMPLEMENTER",
          active_tool_names: activeToolNames,
          seed: "[handoff → implementer]\nTARGET_SEED_EXACT",
          environment_sha256: sha256Canonical({
            system_prompt: "IMPLEMENTER",
            model: "stub:stub-model",
            effort: "off",
            active_tool_names: activeToolNames,
            active_tool_definitions: activeToolDefinitions,
          }),
        },
        admission: {
          schema_version: 1,
          observed_context_tokens: 0,
          role_envelope_tokens: 0,
          target_max_tokens: 8192,
          safety_reservation_tokens: 8192,
          required_tokens: 16384,
          target_context_window: 200000,
          target_model: "stub:stub-model",
        },
        ts: 2,
      });

      const directResumeHost = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub(),
        cwd: workdir,
        log,
        loadedManifest: loaded,
        runId: checkpoint.run_id,
      });
      const resumedTarget = await directResumeHost.spawnRole("implementer");
      expect(
        (
          resumedTarget as typeof resumedTarget & { isAutoCompactionEnabled(): boolean }
        ).isAutoCompactionEnabled(),
      ).toBe(false);
      await resumedTarget.dispose();

      // Snapshot-era resume must not parse a changed (or malformed) current YAML.
      await writeFile(manifestPath, "this: [is not valid", "utf8");
      const resumedRequests: unknown[] = [];
      const resumedRegistry = makeModelRegistryWithStub(
        [{ kind: "emit_handoff", target_role: "orchestrator" }, { kind: "emit_end" }],
        ["stub-model"],
        (context) => resumedRequests.push(context),
      );
      const requestCountBeforeResumedTarget = resumedRequests.length;
      const handle = await resumeRun(manifestPath, checkpoint.run_id, {
        goal: "ignored",
        baseDir,
        hostFactory: ({ runId, log: resumedLog, loadedManifest }) =>
          new ProductionHost({
            modelRegistry: resumedRegistry,
            cwd: workdir,
            log: resumedLog,
            loadedManifest,
            runId,
          }),
      });
      await expect(handle.completion()).resolves.toMatchObject({ exitReason: expect.any(String) });
      const starts = log
        .records(checkpoint.run_id)
        .filter(
          (record): record is SessionLifecycleEvent =>
            record.type === "session_started" && record.role === "implementer",
        );
      expect(starts).toHaveLength(1);
      expect(starts[0]?.session_file).toBe(sourceConversation.file);
      expect(starts[0]?.parent_session).toBe(source.sessionId);
      expect(starts[0]?.visit_index).toBe(1);
      expect(resumedRequests[requestCountBeforeResumedTarget]).toMatchObject({
        messages: expect.any(Array),
      });
      expect(lastUserText(resumedRequests[requestCountBeforeResumedTarget])).toBe(
        "[handoff → implementer]\nTARGET_SEED_EXACT",
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("restores the logical parent and advances the visit index after a target-start crash", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-trajectory-crash-"));
    try {
      const baseDir = join(workdir, "runs");
      const manifestPath = join(workdir, ".pi", "conductor.yaml");
      await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
      await writeFile(manifestPath, MANIFEST, "utf8");
      await writeFile(join(workdir, ".pi", "roles", "orchestrator.md"), "ORCHESTRATOR", "utf8");
      await writeFile(join(workdir, ".pi", "roles", "implementer.md"), "IMPLEMENTER", "utf8");
      const loaded = await loadManifest(manifestPath);
      const initial = createInitialCheckpoint(loaded.def);
      const sourceHost = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub([
          { kind: "emit_handoff", target_role: "implementer" },
        ]),
        cwd: workdir,
        log: new FileRecordLog({ baseDir }),
        loadedManifest: loaded,
        runId: initial.run_id,
      });
      const source = await sourceHost.spawnRole("orchestrator");
      await source.prompt("source trajectory");
      const context = source.getTrajectoryContext?.();
      if (context === undefined) throw new Error("source did not expose trajectory context");
      const activeToolNames = ["handoff", "end", "ask_user"];
      const definitions = serializeActiveToolDefinitions(
        activeToolNames.map((name) => context.toolDefinitions[name]),
      );
      const sourceConversation = {
        id: source.conversationId ?? source.sessionId,
        file: source.sessionFile,
      };
      await source.dispose();

      const log = new FileRecordLog({ baseDir });
      log.append(
        createManifestSnapshot({
          runId: initial.run_id,
          manifest: loaded.manifest,
          definition: loaded.def,
          ts: 1,
        }),
      );
      log.append({ type: "run_seeded", run_id: initial.run_id, goal: "resume", ts: 1 });
      log.append({
        type: "session_ended",
        run_id: initial.run_id,
        role: "orchestrator",
        visit_index: 1,
        state: "implementer",
        model: "stub:stub-model",
        session_file: sourceConversation.file,
        parent_session: null,
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
        role_session_id: source.sessionId,
        conversation_id: sourceConversation.id,
        ts: 2,
      });
      log.append({
        type: "handoff_transport_selected",
        schema_version: 1,
        run_id: initial.run_id,
        source_role_session_id: source.sessionId,
        from: "orchestrator",
        to: "implementer",
        mode: "trajectory",
        source_conversation: sourceConversation,
        target: {
          model: "stub:stub-model",
          requested_effort: "off",
          system_prompt: "IMPLEMENTER",
          active_tool_names: activeToolNames,
          seed: "[handoff → implementer]\nTARGET_SEED_EXACT",
          environment_sha256: sha256Canonical({
            system_prompt: "IMPLEMENTER",
            model: "stub:stub-model",
            effort: "off",
            active_tool_names: activeToolNames,
            active_tool_definitions: definitions,
          }),
        },
        admission: {
          schema_version: 1,
          observed_context_tokens: 0,
          role_envelope_tokens: 0,
          target_max_tokens: 8192,
          safety_reservation_tokens: 8192,
          required_tokens: 16384,
          target_context_window: 200000,
          target_model: "stub:stub-model",
        },
        ts: 3,
      });
      log.append({
        type: "session_started",
        run_id: initial.run_id,
        role: "implementer",
        visit_index: 1,
        state: "implementer",
        model: "stub:stub-model",
        session_file: sourceConversation.file,
        parent_session: source.sessionId,
        role_session_id: "crashed-target",
        conversation_id: sourceConversation.id,
        ts: 4,
      });
      log.append({
        type: "checkpoint_snapshot",
        checkpoint: {
          ...initial,
          current_role: "implementer",
          visit_count: { implementer: 1 },
          active_role_session: {
            id: "crashed-target",
            role: "implementer",
            session_file: sourceConversation.file,
          },
          updated_at: 4,
        },
      });

      const handle = await resumeRun(manifestPath, initial.run_id, {
        goal: "ignored",
        baseDir,
        hostFactory: ({ runId, log: resumedLog, loadedManifest }) =>
          new ProductionHost({
            modelRegistry: makeModelRegistryWithStub([
              { kind: "emit_handoff", target_role: "orchestrator" },
              { kind: "emit_end" },
            ]),
            cwd: workdir,
            log: resumedLog,
            loadedManifest,
            runId,
          }),
      });
      await expect(handle.completion()).resolves.toMatchObject({ exitReason: "done" });
      const targetStarts = log
        .records(initial.run_id)
        .filter(
          (
            record,
          ): record is SessionLifecycleEvent & { readonly conversation_id?: string | null } =>
            record.type === "session_started" && record.role === "implementer",
        );
      expect(targetStarts.map((record) => record.visit_index)).toEqual([1, 2]);
      expect(targetStarts.map((record) => record.parent_session)).toEqual([
        source.sessionId,
        source.sessionId,
      ]);
      expect(targetStarts[0]?.conversation_id).toBe(targetStarts[1]?.conversation_id);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("rejects an incomplete persisted target environment before opening or prompting a target", async () => {
    const loaded = loadManifestFromString(MANIFEST);
    const log = new InMemoryRecordLog();
    log.append({
      type: "handoff_transport_selected",
      schema_version: 1,
      run_id: "invalid-trajectory-selector",
      source_role_session_id: "source-role-session",
      from: "orchestrator",
      to: "implementer",
      mode: "trajectory",
      source_conversation: { id: "shared-conversation", file: "/must-not-open.jsonl" },
      target: {
        model: "stub:stub-model",
        requested_effort: "off",
        system_prompt: "IMPLEMENTER",
        active_tool_names: ["handoff", "end", "ask_user"],
      },
      admission: {
        schema_version: 1,
        observed_context_tokens: 0,
        role_envelope_tokens: 0,
        target_max_tokens: 8192,
        safety_reservation_tokens: 8192,
        required_tokens: 16384,
        target_context_window: 200000,
        target_model: "stub:stub-model",
      },
      ts: 1,
    } as unknown as PersistedRecord);
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: process.cwd(),
      log,
      loadedManifest: loaded,
      runId: "invalid-trajectory-selector",
    });

    await expect(host.spawnRole("implementer")).rejects.toBeInstanceOf(TrajectoryResumeError);
    expect(log.records("invalid-trajectory-selector")).toHaveLength(1);
  });

  it("fails a clamped persisted target effort before its provider can receive a prompt", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-trajectory-effort-"));
    try {
      const manifestPath = join(workdir, ".pi", "conductor.yaml");
      await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
      await writeFile(manifestPath, MANIFEST, "utf8");
      await writeFile(join(workdir, ".pi", "roles", "orchestrator.md"), "ORCHESTRATOR", "utf8");
      await writeFile(join(workdir, ".pi", "roles", "implementer.md"), "IMPLEMENTER", "utf8");
      const loaded = await loadManifest(manifestPath);
      const log = new InMemoryRecordLog();
      const requests: unknown[] = [];
      const registry = makeModelRegistryWithStub([], ["stub-model"], (context) => {
        requests.push(context);
      });
      const sourceHost = new ProductionHost({
        modelRegistry: registry,
        cwd: workdir,
        log,
        loadedManifest: loaded,
        runId: "clamped-trajectory-effort",
      });
      const source = await sourceHost.spawnRole("orchestrator");
      await source.prompt("source trajectory");
      const context = source.getTrajectoryContext?.();
      if (context === undefined) throw new Error("source did not expose trajectory context");
      const activeToolNames = ["handoff", "end", "ask_user"];
      const activeToolDefinitions = serializeActiveToolDefinitions(
        activeToolNames.map((name) => context.toolDefinitions[name]),
      );
      const sourceConversation = {
        id: source.conversationId ?? source.sessionId,
        file: source.sessionFile,
      };
      await source.dispose();
      log.append({
        type: "handoff_transport_selected",
        schema_version: 1,
        run_id: "clamped-trajectory-effort",
        source_role_session_id: source.sessionId,
        from: "orchestrator",
        to: "implementer",
        mode: "trajectory",
        source_conversation: sourceConversation,
        target: {
          model: "stub:stub-model",
          requested_effort: "high",
          system_prompt: "IMPLEMENTER",
          active_tool_names: activeToolNames,
          seed: "[handoff → implementer]\nTARGET_SEED_EXACT",
          environment_sha256: sha256Canonical({
            system_prompt: "IMPLEMENTER",
            model: "stub:stub-model",
            effort: "high",
            active_tool_names: activeToolNames,
            active_tool_definitions: activeToolDefinitions,
          }),
        },
        admission: {
          schema_version: 1,
          observed_context_tokens: 0,
          role_envelope_tokens: 0,
          target_max_tokens: 8192,
          safety_reservation_tokens: 8192,
          required_tokens: 16384,
          target_context_window: 200000,
          target_model: "stub:stub-model",
        },
        ts: 1,
      });

      const targetHost = new ProductionHost({
        modelRegistry: registry,
        cwd: workdir,
        log,
        loadedManifest: loaded,
        runId: "clamped-trajectory-effort",
      });
      const requestCountBeforeTarget = requests.length;
      await expect(targetHost.spawnRole("implementer")).rejects.toBeInstanceOf(
        TrajectoryResumeError,
      );
      expect(requests).toHaveLength(requestCountBeforeTarget);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "compacted", sourcePrompt: "source trajectory", code: "trajectory_history_compacted" },
    {
      name: "oversized",
      sourcePrompt: "x".repeat(1_000_000),
      code: "trajectory_context_too_large",
    },
  ])("re-admits a $name selected branch before target generation", async ({
    sourcePrompt,
    code,
  }) => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-trajectory-readmit-"));
    try {
      const manifestPath = join(workdir, ".pi", "conductor.yaml");
      await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
      await writeFile(manifestPath, MANIFEST, "utf8");
      await writeFile(join(workdir, ".pi", "roles", "orchestrator.md"), "ORCHESTRATOR", "utf8");
      await writeFile(join(workdir, ".pi", "roles", "implementer.md"), "IMPLEMENTER", "utf8");
      const loaded = await loadManifest(manifestPath);
      const log = new InMemoryRecordLog();
      const sourceHost = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub(),
        cwd: workdir,
        log,
        loadedManifest: loaded,
        runId: `readmit-${code}`,
      });
      const source = await sourceHost.spawnRole("orchestrator");
      if (sourcePrompt !== null) await source.prompt(sourcePrompt);
      const sourceConversation = {
        id: source.conversationId ?? source.sessionId,
        file: source.sessionFile,
      };
      const context = source.getTrajectoryContext?.();
      if (context === undefined) throw new Error("source did not expose trajectory context");
      const activeToolNames = ["handoff", "end", "ask_user"];
      const definitions = serializeActiveToolDefinitions(
        activeToolNames.map((name) => context.toolDefinitions[name]),
      );
      await source.dispose();
      if (code === "trajectory_history_compacted") {
        const manager = SessionManager.open(
          sourceConversation.file,
          join(workdir, "sessions"),
          workdir,
        );
        const firstEntry = manager.getEntries()[0]?.id;
        if (firstEntry === undefined) throw new Error("source has no session entry to compact");
        manager.appendCompaction("manual compaction", firstEntry, 0);
      }
      log.append({
        type: "handoff_transport_selected",
        schema_version: 1,
        run_id: `readmit-${code}`,
        source_role_session_id: source.sessionId,
        from: "orchestrator",
        to: "implementer",
        mode: "trajectory",
        source_conversation: sourceConversation,
        target: {
          model: "stub:stub-model",
          requested_effort: "off",
          system_prompt: "IMPLEMENTER",
          active_tool_names: activeToolNames,
          seed: "[handoff → implementer]\\nTARGET_SEED_EXACT",
          environment_sha256: sha256Canonical({
            system_prompt: "IMPLEMENTER",
            model: "stub:stub-model",
            effort: "off",
            active_tool_names: activeToolNames,
            active_tool_definitions: definitions,
          }),
        },
        admission: {
          schema_version: 1,
          observed_context_tokens: 0,
          role_envelope_tokens: 0,
          target_max_tokens: 8192,
          safety_reservation_tokens: 8192,
          required_tokens: 16384,
          target_context_window: 200000,
          target_model: "stub:stub-model",
        },
        ts: 1,
      });
      const requests: unknown[] = [];
      const targetHost = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub([], ["stub-model"], (request) =>
          requests.push(request),
        ),
        cwd: workdir,
        log,
        loadedManifest: loaded,
        runId: `readmit-${code}`,
      });
      await expect(targetHost.spawnRole("implementer")).rejects.toMatchObject({ code });
      expect(requests).toHaveLength(0);
      expect(
        log.records(`readmit-${code}`).filter((record) => record.type === "session_started"),
      ).toHaveLength(0);
      expect(log.records(`readmit-${code}`).at(-1)).toMatchObject({
        type: "trajectory_handoff_failed",
        code,
      });
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("surfaces a durable trajectory failure without reopening or retrying its target", async () => {
    const loaded = loadManifestFromString(MANIFEST);
    const log = new InMemoryRecordLog();
    log.append({
      type: "trajectory_handoff_failed",
      schema_version: 1,
      run_id: "failed-trajectory",
      from: "orchestrator",
      to: "implementer",
      source_conversation: { id: "shared-conversation", file: "/unused.jsonl" },
      code: "trajectory_context_too_large",
      message: "admission failed before target start",
      ts: 1,
    });
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: process.cwd(),
      log,
      loadedManifest: loaded,
      runId: "failed-trajectory",
    });

    await expect(host.spawnRole("implementer")).rejects.toThrow("previously failed");
    expect(log.records("failed-trajectory")).toHaveLength(1);
  });

  it("rejects a malformed selector at the public resume boundary before host construction", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-trajectory-resume-boundary-"));
    try {
      const loaded = loadManifestFromString(MANIFEST);
      const initial = createInitialCheckpoint(loaded.def);
      const log = new FileRecordLog({ baseDir: workdir });
      log.append(
        createManifestSnapshot({
          runId: initial.run_id,
          manifest: loaded.manifest,
          definition: loaded.def,
          ts: 1,
        }),
      );
      log.append({
        type: "checkpoint_snapshot",
        checkpoint: {
          ...initial,
          current_role: "implementer",
          visit_count: { implementer: 1 },
        },
      });
      log.append({
        type: "handoff_transport_selected",
        schema_version: 1,
        run_id: initial.run_id,
        source_role_session_id: "source",
        from: "orchestrator",
        to: "implementer",
        mode: "trajectory",
        source_conversation: { id: "conversation", file: "/must-not-open.jsonl" },
        target: {
          model: "stub:stub-model",
          requested_effort: "off",
          system_prompt: "IMPLEMENTER",
          active_tool_names: ["handoff", "end", "ask_user"],
          environment_sha256: "0".repeat(64),
        },
        admission: {
          schema_version: 1,
          observed_context_tokens: 0,
          role_envelope_tokens: 0,
          target_max_tokens: 8192,
          safety_reservation_tokens: 8192,
          required_tokens: 16384,
          target_context_window: 200000,
          target_model: "stub:stub-model",
        },
        ts: 1,
      } as unknown as PersistedRecord);
      let hostConstructed = false;
      await expect(
        resumeRun(join(workdir, "ignored.yaml"), initial.run_id, {
          goal: "ignored",
          baseDir: workdir,
          hostFactory: () => {
            hostConstructed = true;
            throw new Error("host must not be constructed");
          },
        }),
      ).rejects.toBeInstanceOf(TrajectoryResumeError);
      expect(hostConstructed).toBe(false);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported target effort before selector persistence or target generation", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-trajectory-effort-preflight-"));
    try {
      const manifestPath = join(workdir, ".pi", "conductor.yaml");
      await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
      await writeFile(manifestPath, MANIFEST.replaceAll("effort: off", "effort: high"), "utf8");
      await writeFile(join(workdir, ".pi", "roles", "orchestrator.md"), "ORCHESTRATOR", "utf8");
      await writeFile(join(workdir, ".pi", "roles", "implementer.md"), "IMPLEMENTER", "utf8");
      const requests: unknown[] = [];
      const registry = makeModelRegistryWithStub([], ["stub-model"], (request) =>
        requests.push(request),
      );
      const log = new InMemoryRecordLog();
      const host = new ProductionHost({
        modelRegistry: registry,
        cwd: workdir,
        log,
        loadedManifest: await loadManifest(manifestPath),
        runId: "effort-preflight",
      });
      const source = await host.spawnRole("orchestrator");
      const requestsBeforeSelection = requests.length;
      await expect(
        host.selectAcceptedHandoffTransport({
          from: "orchestrator",
          to: "implementer",
          source,
          targetSeed: "TARGET_SEED_EXACT",
          targetVisitIndex: 1,
        }),
      ).rejects.toMatchObject({ code: "trajectory_target_environment_invalid" });
      expect(requests).toHaveLength(requestsBeforeSelection);
      expect(
        log
          .records("effort-preflight")
          .some((record) => record.type === "handoff_transport_selected"),
      ).toBe(false);
      expect(log.records("effort-preflight").at(-1)).toMatchObject({
        type: "trajectory_handoff_failed",
        code: "trajectory_target_environment_invalid",
      });
      await source.dispose();
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("fails closed instead of appending a target seed already present in the reopened conversation", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-trajectory-duplicate-seed-"));
    try {
      const manifestPath = join(workdir, ".pi", "conductor.yaml");
      await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
      await writeFile(manifestPath, MANIFEST, "utf8");
      await writeFile(join(workdir, ".pi", "roles", "orchestrator.md"), "ORCHESTRATOR", "utf8");
      await writeFile(join(workdir, ".pi", "roles", "implementer.md"), "IMPLEMENTER", "utf8");
      const loaded = await loadManifest(manifestPath);
      const log = new InMemoryRecordLog();
      const requests: unknown[] = [];
      const registry = makeModelRegistryWithStub([], ["stub-model"], (request) =>
        requests.push(request),
      );
      const sourceHost = new ProductionHost({
        modelRegistry: registry,
        cwd: workdir,
        log,
        loadedManifest: loaded,
        runId: "duplicate-target-seed",
      });
      const source = await sourceHost.spawnRole("orchestrator");
      const targetSeed = "[handoff → implementer]\\nTARGET_SEED_EXACT";
      await source.prompt(targetSeed);
      const context = source.getTrajectoryContext?.();
      if (context === undefined) throw new Error("source did not expose trajectory context");
      const names = ["handoff", "end", "ask_user"];
      const definitions = serializeActiveToolDefinitions(
        names.map((name) => context.toolDefinitions[name]),
      );
      const conversation = {
        id: source.conversationId ?? source.sessionId,
        file: source.sessionFile,
      };
      await source.dispose();
      log.append({
        type: "handoff_transport_selected",
        schema_version: 1,
        run_id: "duplicate-target-seed",
        source_role_session_id: source.sessionId,
        from: "orchestrator",
        to: "implementer",
        mode: "trajectory",
        source_conversation: conversation,
        target: {
          model: "stub:stub-model",
          requested_effort: "off",
          system_prompt: "IMPLEMENTER",
          active_tool_names: names,
          seed: targetSeed,
          environment_sha256: sha256Canonical({
            system_prompt: "IMPLEMENTER",
            model: "stub:stub-model",
            effort: "off",
            active_tool_names: names,
            active_tool_definitions: definitions,
          }),
        },
        admission: {
          schema_version: 1,
          observed_context_tokens: 0,
          role_envelope_tokens: 0,
          target_max_tokens: 8192,
          safety_reservation_tokens: 8192,
          required_tokens: 16384,
          target_context_window: 200000,
          target_model: "stub:stub-model",
        },
        ts: 1,
      });
      const targetHost = new ProductionHost({
        modelRegistry: registry,
        cwd: workdir,
        log,
        loadedManifest: loaded,
        runId: "duplicate-target-seed",
      });
      const requestsBeforeTarget = requests.length;
      await expect(targetHost.spawnRole("implementer")).rejects.toMatchObject({
        code: "trajectory_target_seed_ambiguous",
      });
      expect(requests).toHaveLength(requestsBeforeTarget);
      expect(log.records("duplicate-target-seed").at(-1)).toMatchObject({
        type: "trajectory_handoff_failed",
        code: "trajectory_target_seed_ambiguous",
      });
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
