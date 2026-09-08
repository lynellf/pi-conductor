import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  createInitialCheckpoint,
  FileRecordLog,
  type LoadedManifest,
  loadManifestFromString,
  resumeRun,
  StubHost,
  startRun,
} from "../../src/index.js";
import { createManifestSnapshot } from "../../src/persistence/trajectory-records.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const manifest = (mode?: "blocking" | "nonblocking", workerModels = false): string => `
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
    models: ${workerModels ? "[stub:primary, stub:fallback]" : "[stub:worker]"}
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
    await writeFile(path, manifest("blocking"), "utf8");

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
    const path = await writeManifest(workdir, manifest("nonblocking"));
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
    const handle = await resumeRun(path, runId, {
      goal: "",
      baseDir,
      hostFactory: ({ runId: resumedRunId, log: resumedLog, loadedManifest }) => {
        resumed = loadedManifest;
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

    expect(resumed?.legacyDelegationMode).toBeUndefined();
    expect(resumed?.legacyDelegationRoles).toEqual(["orchestrator", "worker"]);
    expect(
      resumed?.manifest.roles.find((role) => role.name === "orchestrator")?.delegation?.mode,
    ).toBeUndefined();
  });

  it("warns when an old run has no manifest snapshot proving its delegation mode", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-delegation-mode-"));
    directories.push(workdir);
    const path = await writeManifest(workdir, manifest("nonblocking"));
    const baseDir = join(workdir, "runs");
    const loaded = loadManifestFromString(manifest("nonblocking"));
    const checkpoint = { ...createInitialCheckpoint(loaded.def), current_role: "done" as const };
    const runId = checkpoint.run_id;
    const log = new FileRecordLog({ baseDir });
    log.append({ type: "checkpoint_snapshot", checkpoint });
    log.append({ type: "run_seeded", run_id: runId, goal: "unproven legacy run", ts: 1 });

    let resumed: LoadedManifest | undefined;
    const handle = await resumeRun(path, runId, {
      goal: "",
      baseDir,
      hostFactory: ({ runId: resumedRunId, log: resumedLog, loadedManifest }) => {
        resumed = loadedManifest;
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

    expect(resumed?.legacyDelegationMode).toBe(true);
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
    ).toBe("nonblocking");
  });

  it("keeps the fallback allowance through the public run path", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-delegation-mode-"));
    directories.push(workdir);
    const path = await writeManifest(workdir, manifest(undefined, true));
    const baseDir = join(workdir, "runs");
    const handle = await startRun(path, {
      goal: "fallback allowance",
      baseDir,
      hostFactory: ({ runId, log, loadedManifest }) =>
        new StubHost({
          runId,
          log,
          loadedManifest,
          steps: [
            { kind: "emit_handoff", target_role: "worker" },
            { kind: "fail", errorMessage: "primary unavailable" },
            { kind: "emit_handoff", target_role: "orchestrator" },
            { kind: "emit_end" },
          ],
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-delegation-mode-"),
        }),
    });
    const result = await handle.completion();
    const records = new FileRecordLog({ baseDir }).records(handle.runId);

    expect(result.exitReason).toBe("done");
    expect(
      records.some((record) => record.type === "model_fallback" && record.role === "worker"),
    ).toBe(true);
  });
});
