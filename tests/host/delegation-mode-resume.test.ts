import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createDelegateTool } from "../../src/host/delegation/delegate-tool-factory.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import type { DelegationScheduler } from "../../src/host/delegation/scheduler.js";
import {
  createInitialCheckpoint,
  FileRecordLog,
  type LoadedManifest,
  loadManifestFromString,
  type RecordLog,
  resumeRun,
  StubHost,
  startRun,
} from "../../src/index.js";
import { createManifestSnapshot } from "../../src/persistence/trajectory-records.js";
import type { DelegateSubmissionArgs } from "../../src/seam/schema.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const manifest = (mode?: "blocking" | "nonblocking"): string => `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end, delegate]
    delegation:
      ${mode === undefined ? "" : `mode: ${mode}\n      `}allowed_subagents: [child]
      max_children_per_session: 2
      max_parallel: 1
  - name: worker
    max_visits: 3
    tools: [handoff, end]
    models: [stub:worker]
subagents:
  - name: child
    models: [stub:child]
    max_session_cost_usd: 1
    system_prompt: child.md
`;

async function writeManifest(workdir: string, source: string): Promise<string> {
  await mkdir(join(workdir, ".pi"), { recursive: true });
  const path = join(workdir, ".pi", "conductor.yaml");
  await writeFile(path, source, "utf8");
  return path;
}

async function runToCompletion(
  manifestPath: string,
  baseDir: string,
  loaded?: (value: LoadedManifest) => void,
) {
  const handle = await startRun(manifestPath, {
    goal: "resume delegation mode",
    baseDir,
    hostFactory: ({ runId, log, loadedManifest }) => {
      loaded?.(loadedManifest);
      return new StubHost({
        runId,
        log,
        loadedManifest,
        steps: [{ kind: "emit_end", reason: "fixture complete" }],
        agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-delegation-mode-"),
      });
    },
  });
  return { handle, result: await handle.completion() };
}

function invokeDelegate(
  tool: ReturnType<typeof createDelegateTool>,
  toolCallId: string,
  args: unknown,
): Promise<unknown> {
  return (tool.execute as unknown as (id: string, params: unknown) => Promise<unknown>)(
    toolCallId,
    args,
  );
}

function makeAcceptingScheduler(submitted: (args: unknown) => void): DelegationScheduler {
  return {
    submit: async (_toolCallId: string, args: DelegateSubmissionArgs) => {
      submitted(args);
      return ["child-accepted"];
    },
    remainingChildren: () => 1,
    status: () => [],
    wait: async () => {
      throw new Error("wait is not part of this acceptance fixture");
    },
    cancel: async () => {},
    close: async () => {},
    isClosed: () => false,
    pendingChildIds: () => [],
  } as unknown as DelegationScheduler;
}

function activeLegacyDelegateCall(
  loadedManifest: LoadedManifest,
  runId: string,
  workdir: string,
  log: RecordLog,
  submitted: (args: unknown) => void,
): Promise<unknown> {
  const role = loadedManifest.manifest.roles.find((candidate) => candidate.name === "orchestrator");
  if (role === undefined || role.delegation === undefined)
    throw new Error("expected the resumed orchestrator to retain delegation policy");
  const legacyMode =
    loadedManifest.legacyDelegationMode === true ||
    loadedManifest.legacyDelegationRoles?.includes("orchestrator") === true;
  const tool = createDelegateTool({
    role,
    subagents: loadedManifest.manifest.subagents ?? [],
    remainingChildren: role.delegation.max_children_per_session,
    runId,
    parentRole: "orchestrator",
    parentVisitIndex: 1,
    primaryCheckout: workdir,
    runStateDir: join(workdir, ".pi-conductor", "runs", runId),
    persistRecord: (record) => log.append(record),
    agentDir: join(workdir, ".pi-conductor", "agent"),
    systemPromptRoot: workdir,
    modelRegistry: makeModelRegistryWithStub(),
    sessionDir: join(workdir, ".pi-conductor", "sessions"),
    manager: new DelegationManager(),
    scheduler: makeAcceptingScheduler(submitted),
    ...(legacyMode ? { legacyDelegationMode: true } : {}),
  });
  return invokeDelegate(tool, "legacy-call", {
    mode: "nonblocking",
    tasks: [
      {
        id: "legacy-task",
        subagent: "child",
        objective: "preserve the accepted child",
        expected_output: "accepted",
      },
    ],
  });
}

describe("Issue #86 public snapshot/resume policy", () => {
  it.each([
    ["omitted", undefined, "blocking"],
    ["explicit nonblocking", "nonblocking" as const, "nonblocking"],
  ])("pins %s delegation mode on a fresh start", async (_label, mode, expected) => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-delegation-mode-"));
    directories.push(workdir);
    const path = await writeManifest(workdir, manifest(mode));
    let observed: LoadedManifest | undefined;
    const { result } = await runToCompletion(path, join(workdir, "runs"), (loaded) => {
      observed = loaded;
    });

    expect(result.exitReason).toBe("done");
    expect(
      observed?.manifest.roles.find((role) => role.name === "orchestrator")?.delegation?.mode,
    ).toBe(expected);
  });

  it("resumes from the durable policy when the manifest source is edited", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-delegation-mode-"));
    directories.push(workdir);
    const path = await writeManifest(workdir, manifest("nonblocking"));
    const baseDir = join(workdir, "runs");
    const first = await runToCompletion(path, baseDir);

    let resumed: LoadedManifest | undefined;
    const handle = await resumeRun(path, first.handle.runId, {
      goal: "",
      baseDir,
      hostFactory: ({ runId, log, loadedManifest }) => {
        resumed = loadedManifest;
        return new StubHost({
          runId,
          log,
          loadedManifest,
          steps: [],
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-delegation-mode-"),
        });
      },
    });
    await handle.completion();

    expect(
      resumed?.manifest.roles.find((role) => role.name === "orchestrator")?.delegation?.mode,
    ).toBe("nonblocking");
  });

  it("derives legacy per-call provenance from a durable snapshot without mode", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-delegation-mode-"));
    directories.push(workdir);
    const path = await writeManifest(workdir, manifest());
    const baseDir = join(workdir, "runs");
    const loaded = loadManifestFromString(manifest("nonblocking"));
    const legacyManifest = {
      ...loaded.manifest,
      roles: loaded.manifest.roles.map((role) =>
        role.delegation === undefined
          ? role
          : (() => {
              const { mode: _mode, ...legacyDelegation } = role.delegation;
              return { ...role, delegation: legacyDelegation };
            })(),
      ),
    } as LoadedManifest["manifest"];
    const checkpoint = { ...createInitialCheckpoint(loaded.def), current_role: "done" as const };
    const runId = checkpoint.run_id;
    const log = new FileRecordLog({ baseDir });
    log.append(
      createManifestSnapshot({ runId, manifest: legacyManifest, definition: loaded.def, ts: 1 }),
    );
    log.append({ type: "checkpoint_snapshot", checkpoint });
    log.append({ type: "run_seeded", run_id: runId, goal: "legacy run", ts: 2 });

    let resumed: LoadedManifest | undefined;
    let accepted: Promise<unknown> | undefined;
    let submitted: unknown;
    const handle = await resumeRun(path, runId, {
      goal: "",
      baseDir,
      hostFactory: ({ runId: resumedRunId, log: resumedLog, loadedManifest }) => {
        resumed = loadedManifest;
        accepted = activeLegacyDelegateCall(
          loadedManifest,
          resumedRunId,
          workdir,
          resumedLog,
          (args) => {
            submitted = args;
          },
        );
        return new StubHost({
          runId: resumedRunId,
          log: resumedLog,
          loadedManifest,
          steps: [],
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-delegation-mode-"),
        });
      },
    });
    await handle.completion();
    const acceptedResult = await accepted;

    expect(resumed?.legacyDelegationMode).toBeUndefined();
    expect(resumed?.legacyDelegationRoles).toEqual(["orchestrator", "worker"]);
    expect(
      resumed?.manifest.roles.find((role) => role.name === "orchestrator")?.delegation?.mode,
    ).toBeUndefined();
    expect(submitted).toMatchObject({ mode: "nonblocking", tasks: [{ id: "legacy-task" }] });
    expect(acceptedResult).toMatchObject({
      content: [{ text: JSON.stringify({ child_ids: ["child-accepted"] }) }],
    });
  });

  it("warns when an old run has no manifest snapshot proving its delegation mode", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-delegation-mode-"));
    directories.push(workdir);
    const path = await writeManifest(workdir, manifest());
    const baseDir = join(workdir, "runs");
    const loaded = loadManifestFromString(manifest());
    const checkpoint = { ...createInitialCheckpoint(loaded.def), current_role: "done" as const };
    const runId = checkpoint.run_id;
    const log = new FileRecordLog({ baseDir });
    log.append({ type: "checkpoint_snapshot", checkpoint });
    log.append({ type: "run_seeded", run_id: runId, goal: "unproven legacy run", ts: 1 });

    let resumed: LoadedManifest | undefined;
    let accepted: Promise<unknown> | undefined;
    let submitted: unknown;
    const handle = await resumeRun(path, runId, {
      goal: "",
      baseDir,
      hostFactory: ({ runId: resumedRunId, log: resumedLog, loadedManifest }) => {
        resumed = loadedManifest;
        accepted = activeLegacyDelegateCall(
          loadedManifest,
          resumedRunId,
          workdir,
          resumedLog,
          (args) => {
            submitted = args;
          },
        );
        return new StubHost({
          runId: resumedRunId,
          log: resumedLog,
          loadedManifest,
          steps: [],
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-delegation-mode-"),
        });
      },
    });
    await handle.completion();
    const acceptedResult = await accepted;

    expect(resumed?.legacyDelegationMode).toBe(true);
    expect(resumed?.legacyDelegationRoles).toEqual(["orchestrator"]);
    expect(resumed?.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "legacy-delegation-mode-unproven",
          message: expect.stringContaining("no durable manifest snapshot"),
        }),
      ]),
    );
    expect(
      resumed?.manifest.roles.find((role) => role.name === "orchestrator")?.delegation?.mode,
    ).toBe("blocking");
    expect(submitted).toMatchObject({ mode: "nonblocking", tasks: [{ id: "legacy-task" }] });
    expect(acceptedResult).toMatchObject({
      content: [{ text: JSON.stringify({ child_ids: ["child-accepted"] }) }],
    });
  });
});
