import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDelegateSubmission } from "../../src/host/delegation/admission.js";
import { type DelegateResult, executeDelegate } from "../../src/host/delegation/delegate-tool.js";
import {
  acceptedDelegationRecord,
  schedulerSubmissionId,
} from "../../src/host/delegation/scheduler-identity.js";
import { toMachineDefinition } from "../../src/manifest/definition.js";
import { parseManifest } from "../../src/manifest/parse.js";
import type { Manifest } from "../../src/manifest/types.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { createManifestSnapshot } from "../../src/persistence/trajectory-records.js";
import type { DelegateSubmissionArgs } from "../../src/seam/schema.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const taskArgs: DelegateSubmissionArgs = {
  tasks: [
    {
      id: "task-1",
      subagent: "coder",
      objective: "Inspect the repository.",
      expected_output: "Return a concise report.",
    },
  ],
};
const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
const identity = {
  runId: "run-154-compat",
  logicalParentId: "parent-154-compat",
  parentRole: "orchestrator",
  parentVisitIndex: 1,
} as const;

function manifestYaml(description?: string, advisoryEnabled = false): string {
  return `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    delegation:
      allowed_subagents: [coder]
      max_children_per_session: 1
      max_parallel: 1
${advisoryEnabled ? `delegation_advisory:\n  schema_version: 1\n  provider: typesafe_jev\n  model: jev-latest\n  mode: shadow\n  max_parallel: 4\n  request_timeout_ms: 5000\n  max_attempts: 1\n` : ""}subagents:
  - name: coder
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: child.md
    completion_protocol: report_result
${description === undefined ? "" : `    description: ${JSON.stringify(description)}\n`}`;
}

function manifestPolicy(manifest: Manifest) {
  const policy = manifest.roles[0]?.delegation;
  if (policy === undefined) throw new Error("test manifest has no delegation policy");
  return policy;
}

function firstChildProfileFingerprint(record: ReturnType<typeof acceptedDelegationRecord>): string {
  const child = record.children[0];
  if (child === undefined) throw new Error("acceptance record has no child");
  return child.profile_fingerprint;
}

function stableDelegateResults(result: DelegateResult) {
  return result.results.map((child) => ({
    task_id: child.task_id,
    subagent: child.subagent,
    status: child.status,
    summary: child.summary,
    ...(child.verification === undefined ? {} : { verification: child.verification }),
    base_commit: child.base_commit,
    head_commit: child.head_commit,
    session_file: child.session_file,
    usage: child.usage,
    ...(child.completion_evidence === undefined
      ? {}
      : { completion_evidence: child.completion_evidence }),
  }));
}

async function makeRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-issue-154-profile-compat-"));
  roots.push(root);
  await writeFile(join(root, "child.md"), "Work on the assigned task.\n", "utf8");
  await execFile("git", ["init", "--quiet"], { cwd: root });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: root });
  await execFile("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  return root;
}

async function makeRunStateDir(): Promise<string> {
  const runStateDir = await mkdtemp(join(tmpdir(), "pi-conductor-issue-154-run-state-"));
  roots.push(runStateDir);
  return runStateDir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Issue #154 policy-absent profile description compatibility", () => {
  it("keeps manifest snapshots byte-identical when advisory policy is absent", () => {
    const withoutDescription = parseManifest(manifestYaml());
    const withDescription = parseManifest(manifestYaml("A code implementation profile."));
    expect(withDescription.delegation_advisory).toBeUndefined();

    const snapshot = (manifest: Manifest) =>
      createManifestSnapshot({
        runId: identity.runId,
        manifest,
        definition: toMachineDefinition(manifest),
        ts: 1,
      });
    expect(snapshot(withDescription)).toEqual(snapshot(withoutDescription));
  });

  it("retains descriptions when advisory policy is enabled", async () => {
    const root = await makeRepository();
    const runStateDir = await makeRunStateDir();
    const withoutDescription = parseManifest(manifestYaml(undefined, true));
    const withDescription = parseManifest(manifestYaml("A code implementation profile.", true));
    expect(withDescription.subagents?.[0]?.description).toBe("A code implementation profile.");
    const plainSnapshot = createManifestSnapshot({
      runId: identity.runId,
      manifest: withoutDescription,
      definition: toMachineDefinition(withoutDescription),
      ts: 1,
    });
    const describedSnapshot = createManifestSnapshot({
      runId: identity.runId,
      manifest: withDescription,
      definition: toMachineDefinition(withDescription),
      ts: 1,
    });
    expect(describedSnapshot).not.toEqual(plainSnapshot);

    const prepare = (manifest: Manifest) =>
      prepareDelegateSubmission({
        args: taskArgs,
        policy: manifestPolicy(manifest),
        profiles: manifest.subagents ?? [],
        remainingChildren: 1,
        runStateDir,
        runId: identity.runId,
        parentRole: identity.parentRole,
        primaryCheckout: root,
        systemPromptRoot: root,
        spawnAndRunChild: async () => {
          throw new Error("preparation must not spawn a child");
        },
      });
    const [plain, described] = await Promise.all([
      prepare(withoutDescription),
      prepare(withDescription),
    ]);
    expect(described.tasks[0]?.profileFingerprint).not.toBe(plain.tasks[0]?.profileFingerprint);
  });

  it("keeps persisted delegate profile fingerprints unchanged without advisory policy", async () => {
    const root = await makeRepository();
    const runStateDir = await makeRunStateDir();
    const withoutDescription = parseManifest(manifestYaml());
    const withDescription = parseManifest(manifestYaml("A code implementation profile."));
    const prepare = (manifest: Manifest) =>
      prepareDelegateSubmission({
        args: taskArgs,
        policy: manifestPolicy(manifest),
        profiles: manifest.subagents ?? [],
        remainingChildren: 1,
        runStateDir,
        runId: identity.runId,
        parentRole: identity.parentRole,
        primaryCheckout: root,
        systemPromptRoot: root,
        spawnAndRunChild: async () => {
          throw new Error("preparation must not spawn a child");
        },
      });
    const [plain, described] = await Promise.all([
      prepare(withoutDescription),
      prepare(withDescription),
    ]);
    const accepted = (tasks: typeof plain.tasks) =>
      acceptedDelegationRecord(
        identity,
        "tool-call-154-compat",
        taskArgs,
        schedulerSubmissionId(identity, "tool-call-154-compat"),
        "a".repeat(64),
        "b".repeat(64),
        "b".repeat(64),
        tasks,
      );
    const plainLog = new InMemoryRecordLog();
    const describedLog = new InMemoryRecordLog();
    plainLog.append(accepted(plain.tasks));
    describedLog.append(accepted(described.tasks));
    const getAccepted = (log: InMemoryRecordLog) => {
      const record = log
        .records(identity.runId)
        .find((candidate) => candidate.type === "delegation_submission_accepted");
      if (record === undefined || record.type !== "delegation_submission_accepted")
        throw new Error("delegation acceptance record was not persisted");
      return record;
    };

    expect(firstChildProfileFingerprint(getAccepted(describedLog))).toBe(
      firstChildProfileFingerprint(getAccepted(plainLog)),
    );
  });

  it("keeps the dispatched child prompt unchanged", async () => {
    const root = await makeRepository();
    const runStateDir = await makeRunStateDir();
    const withoutDescription = parseManifest(manifestYaml());
    const withDescription = parseManifest(manifestYaml("A code implementation profile."));
    const prepare = (manifest: Manifest) =>
      prepareDelegateSubmission({
        args: taskArgs,
        policy: manifestPolicy(manifest),
        profiles: manifest.subagents ?? [],
        remainingChildren: 1,
        runStateDir,
        runId: identity.runId,
        parentRole: identity.parentRole,
        primaryCheckout: root,
        systemPromptRoot: root,
        spawnAndRunChild: async () => {
          throw new Error("preparation must not spawn a child");
        },
      });
    const [plain, described] = await Promise.all([
      prepare(withoutDescription),
      prepare(withDescription),
    ]);
    const plainChild = plain.tasks[0];
    const describedChild = described.tasks[0];
    if (plainChild === undefined || describedChild === undefined)
      throw new Error("prepared child is missing");
    const normalizeWorktree = (prompt: string) =>
      prompt.replace(/^Worktree: .*$/m, "Worktree: <child>");
    expect(normalizeWorktree(describedChild.systemPrompt)).toBe(
      normalizeWorktree(plainChild.systemPrompt),
    );
  });

  it("keeps the parent-facing delegate result unchanged", async () => {
    const root = await makeRepository();
    const runStateDir = await makeRunStateDir();
    const withoutDescription = parseManifest(manifestYaml());
    const withDescription = parseManifest(manifestYaml("A code implementation profile."));
    const prompts: string[] = [];
    const execute = (manifest: Manifest) =>
      executeDelegate({
        args: taskArgs,
        policy: manifestPolicy(manifest),
        profiles: manifest.subagents ?? [],
        remainingChildren: 1,
        runStateDir,
        runId: identity.runId,
        parentRole: identity.parentRole,
        primaryCheckout: root,
        systemPromptRoot: root,
        spawnAndRunChild: async (child) => {
          prompts.push(child.systemPrompt.replace(/^Worktree: .*$/m, "Worktree: <child>"));
          return {
            started: true,
            model: "stub:model",
            sessionFile: "child-session",
            usage,
            status: "no_changes",
            summary: "No changes were required.",
          };
        },
      });
    const plainResult = await execute(withoutDescription);
    const describedResult = await execute(withDescription);
    expect(stableDelegateResults(describedResult)).toEqual(stableDelegateResults(plainResult));
    expect(prompts[1]).toBe(prompts[0]);
  });
});
