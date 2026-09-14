import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateBatch } from "../../src/host/delegation/validate-batch.js";
import type { LoadedManifest } from "../../src/host/manifest.js";
import { FileRecordLog, resumeRun, StubHost, startRun } from "../../src/index.js";
import { ManifestParseError } from "../../src/manifest/types.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import type { DelegateSubmissionArgs } from "../../src/seam/schema.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const SNAPSHOT_MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [delegate, end]
    delegation:
      allowed_subagents: [project-worker]
      max_children_per_session: 1
      max_parallel: 1
subagents:
  - name: project-worker
    models: [stub:worker]
    max_session_cost_usd: 1
    system_prompt: project-worker.md
    workspace:
      snapshot:
        paths: [src, tests, package.json]
        max_files: 3
    execution:
      backend: bubblewrap
      runtime_root: prepared-runtime
      writable_paths: [src, tests]
      network: none
`;

const WIDER_SNAPSHOT_MANIFEST = SNAPSHOT_MANIFEST.replace(
  "paths: [src, tests, package.json]\n        max_files: 3",
  "paths: [src, tests, package.json, private]\n        max_files: 10000",
);

const task: DelegateSubmissionArgs = {
  tasks: [
    {
      id: "snapshot-task",
      subagent: "project-worker",
      objective: "Inspect the approved source snapshot.",
      expected_output: "Report the inspected files.",
    },
  ],
};

describe("Issue #111 public pinned snapshot resume", () => {
  it.each([
    ["widens roots and the limit", WIDER_SNAPSHOT_MANIFEST],
    ["becomes invalid YAML", "snapshot: ["],
  ])("keeps the disk-pinned snapshot when current YAML %s", async (_label, replacement) => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-snapshot-resume-"));
    directories.push(workdir);
    const manifestPath = join(workdir, ".pi", "conductor.yaml");
    const baseDir = join(workdir, "runs");
    await mkdir(join(workdir, ".pi"), { recursive: true });
    await writeFile(manifestPath, SNAPSHOT_MANIFEST, "utf8");

    const started = await startRun(manifestPath, {
      goal: "persist the snapshot profile",
      baseDir,
      hostFactory: ({ runId, log, loadedManifest }) =>
        new StubHost({
          runId,
          log,
          loadedManifest,
          steps: [{ kind: "emit_end", reason: "fixture complete" }],
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-snapshot-resume-"),
        }),
    });
    await started.completion();
    await writeFile(manifestPath, replacement, "utf8");

    let resumedManifest: LoadedManifest | undefined;
    const resumed = await resumeRun(manifestPath, started.runId, {
      goal: "",
      baseDir,
      hostFactory: ({ runId, log, loadedManifest }) => {
        resumedManifest = loadedManifest;
        return new StubHost({
          runId,
          log,
          loadedManifest,
          steps: [],
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-snapshot-resume-"),
        });
      },
    });
    await resumed.completion();

    const persisted = new FileRecordLog({ baseDir })
      .records(started.runId)
      .find((record) => record.type === "manifest_snapshot");
    expect(persisted).toMatchObject({
      normalized_manifest: {
        subagents: [
          {
            workspace: { snapshot: { paths: ["src", "tests", "package.json"], max_files: 3 } },
          },
        ],
      },
    });

    const profile = resumedManifest?.manifest.subagents?.[0];
    const policy = resumedManifest?.manifest.roles[0]?.delegation;
    if (profile === undefined || policy === undefined)
      throw new Error("expected pinned profile and delegation policy");
    expect(profile.workspace?.snapshot).toEqual({
      paths: ["src", "tests", "package.json"],
      max_files: 3,
    });
    expect(
      validateBatch(
        task,
        policy,
        [profile],
        1,
        { isGit: true, isClean: true, headCommit: "a".repeat(40) },
        ["src/main.ts", "tests/main.test.ts", "package.json"],
        true,
      ),
    ).toEqual({
      valid: true,
      tasks: [
        expect.objectContaining({
          taskId: "snapshot-task",
          projectionPaths: ["package.json", "src/main.ts", "tests/main.test.ts"],
        }),
      ],
    });
  });
});

it.each([
  {
    snapshot: { paths: ["src"], max_files: 10 },
    projection: { required: true, allowed_paths: ["src"] },
  },
  { snapshot: { paths: "src", max_files: 10 } },
  { snapshot: { paths: ["src"], max_files: 10, hidden_override: true } },
])("rejects rehashed malformed retained workspace before constructing a host: %j", async (workspace) => {
  const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-snapshot-malformed-"));
  directories.push(workdir);
  const manifestPath = join(workdir, "conductor.yaml");
  const baseDir = join(workdir, "runs");
  await writeFile(manifestPath, SNAPSHOT_MANIFEST);
  const handle = await startRun(manifestPath, {
    goal: "pin snapshot",
    baseDir,
    hostFactory: ({ runId, log, loadedManifest }) =>
      new StubHost({
        runId,
        log,
        loadedManifest,
        steps: [{ kind: "emit_end" }],
        agentDir: makeAndTrackIsolatedAgentDir(),
      }),
  });
  await handle.completion();
  const rows = new FileRecordLog({ baseDir }).records(handle.runId).map((record) => {
    if (record.type !== "manifest_snapshot") return record;
    const normalized_manifest = {
      ...record.normalized_manifest,
      subagents: record.normalized_manifest.subagents?.map((profile) => ({
        ...profile,
        workspace,
      })),
    };
    return {
      ...record,
      normalized_manifest,
      sha256: sha256Canonical({
        schema_version: record.schema_version,
        normalized_manifest,
        definition: record.definition,
      }),
    };
  });
  await writeFile(
    join(baseDir, `${handle.runId}.jsonl`),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
  let constructed = false;
  await expect(
    resumeRun(manifestPath, handle.runId, {
      goal: "",
      baseDir,
      hostFactory: () => {
        constructed = true;
        throw Error("host must not run");
      },
    }),
  ).rejects.toBeInstanceOf(ManifestParseError);
  expect(constructed).toBe(false);
});
