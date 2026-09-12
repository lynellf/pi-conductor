/** Validate and stage a complete child patch before host worktree application (#106 §4). */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, posix } from "node:path";
import { Value } from "typebox/value";
import type { SandboxAdmissionRecord } from "../../../persistence/sandbox-admission.js";
import {
  type SandboxPatchStage,
  sandboxIntegrationJournalSchema,
  sandboxPatchStageSchema,
} from "../../../persistence/sandbox-ingestion.js";
import type { SandboxProjectMaterializationDescriptor } from "../../../persistence/sandbox-materialization.js";
import { withSandboxDirectory } from "./anchored-file-access.js";
import type { SandboxOperationGate } from "./operation-gate.js";
import { verifySandboxProjectBase } from "./project-materialization.js";
import { isSandboxWritablePath } from "./writable-authority.js";
import { assertSandboxWritableEntries } from "./writable-entries.js";

const MAX_ENTRIES = 10000;
const MAX_BYTES = 256 * 1024 * 1024;

/** Host-owned inputs; the gate remains held through durable application outcome. */
export interface SandboxProjectIngestionOptions {
  readonly gate: SandboxOperationGate;
  readonly admission: SandboxAdmissionRecord;
  readonly project: SandboxProjectMaterializationDescriptor;
  readonly runStateDir: string;
  readonly signal: AbortSignal;
  /** Revalidate captured Git controls immediately before host worktree mutation. */
  readonly verifyWorktree: () => Promise<void>;
  /** Deterministic host fault injection; never provided by a task or command. */
  readonly beforeApplyEntry?: (index: number) => Promise<void>;
}

/** Partial application is retained and blocks further automatic integration. */
export class SandboxProjectIngestionError extends Error {
  constructor(
    message: string,
    readonly stagePath: string,
    readonly integration: "not-started" | "integration_incomplete" | "completed",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SandboxProjectIngestionError";
  }
}

/** Apply one settled child's delta once; retries after an apply marker require parent recovery. */
export async function ingestSandboxProject(
  options: SandboxProjectIngestionOptions,
): Promise<SandboxPatchStage> {
  return options.gate.run(options.signal, async (signal) => {
    const project = await verifySandboxProjectBase(options.project, {
      admission: options.admission,
      runStateDir: options.runStateDir,
      expectedRunId: options.gate.owner.runId,
      expectedChildId: options.gate.owner.childId,
    });
    const applyingPath = join(project.projectPath, "integration-applying.json");
    if (await exists(applyingPath)) {
      const completed = await readCompletedJournal(project.projectPath);
      const error = new SandboxProjectIngestionError(
        completed
          ? "patch already integrated; automatic repeat is disabled"
          : "automatic integration is sealed by a retained application marker; inspect both trees and staging",
        project.projectPath,
        completed ? "completed" : "integration_incomplete",
      );
      options.gate.seal(error);
      throw error;
    }
    const stagePath = join(project.projectPath, `patch-${randomUUID()}`);
    await mkdir(stagePath, { mode: 0o700 });
    await mkdir(join(stagePath, "files"), { mode: 0o700 });
    let applying = false;
    try {
      signal.throwIfAborted();
      const stage = await captureStage(options.admission, project, stagePath, signal);
      await durableJson(join(stagePath, "stage.json"), stage);
      await syncDirectory(stagePath);
      await syncDirectory(project.projectPath);
      await options.verifyWorktree();
      await verifyPristineWorktree(project);
      await verifyStaging(stage, stagePath);
      signal.throwIfAborted();
      // A crash from this point is conservatively an incomplete integration.
      applying = true;
      await durableJson(applyingPath, {
        schemaVersion: 1,
        stage: posix.basename(stagePath),
        outcome: "applying",
      });
      await syncDirectory(project.projectPath);
      await applyStage(stage, stagePath, project, options, signal);
      await durableJson(join(project.projectPath, "integration-complete.json"), {
        schemaVersion: 1,
        stage: posix.basename(stagePath),
        outcome: "completed",
      });
      await syncDirectory(project.projectPath);
      return stage;
    } catch (cause) {
      const error = new SandboxProjectIngestionError(
        applying
          ? "integration_incomplete: inspect retained staging and both trees; automatic integration is sealed"
          : "patch validation failed before worktree application; inspect and repair private output",
        stagePath,
        applying ? "integration_incomplete" : "not-started",
        { cause },
      );
      if (applying) {
        options.gate.seal(error);
        try {
          await durableJson(join(project.projectPath, "integration-incomplete.json"), {
            schemaVersion: 1,
            stage: posix.basename(stagePath),
            outcome: "integration_incomplete",
          });
          await syncDirectory(project.projectPath);
        } catch (persistCause) {
          throw new SandboxProjectIngestionError(
            "integration_incomplete: outcome persistence failed; retained applying marker requires explicit recovery",
            stagePath,
            "integration_incomplete",
            { cause: new AggregateError([cause, persistCause]) },
          );
        }
      }
      throw error;
    }
  });
}

async function captureStage(
  admission: SandboxAdmissionRecord,
  project: SandboxProjectMaterializationDescriptor,
  stagePath: string,
  signal: AbortSignal,
): Promise<SandboxPatchStage> {
  const roots = admission.policy.writableRoots;
  return withSandboxDirectory(project.writablePath, async (source) => {
    const observed = await source.entries(MAX_ENTRIES);
    assertSandboxWritableEntries(observed, roots);
    const base = new Map(
      project.baseInventory
        .filter((entry) => entry.type === "file" && isSandboxWritablePath(roots, entry.path))
        .map((entry) => [entry.path, entry]),
    );
    const currentFiles = new Set(
      observed.filter((entry) => entry.type === "file").map((entry) => entry.path),
    );
    const entries: SandboxPatchStage["entries"] = [];
    let byteCount = 0;
    for (const [path] of base) {
      if (currentFiles.has(path)) continue;
      if (entries.length >= MAX_ENTRIES)
        throw new Error("patch deletion count exceeds 10000 entries");
      entries.push({ path, operation: "delete" });
    }
    await withSandboxDirectory(join(stagePath, "files"), async (staging) => {
      for (const entry of observed) {
        signal.throwIfAborted();
        if (entry.type !== "file") continue;
        const digest = await source.digest(entry.path);
        const original = base.get(entry.path);
        if (
          original?.type === "file" &&
          original.sha256 === digest.sha256 &&
          original.executableMode === digest.executableMode
        )
          continue;
        if (byteCount + digest.size > MAX_BYTES || entries.length >= MAX_ENTRIES)
          throw new Error("patch delta exceeds the 10000-entry/256-MiB bound");
        const bytes = await source.read(entry.path, MAX_BYTES - byteCount);
        if (bytes.length !== digest.size || sha256(bytes) !== digest.sha256)
          throw new Error("writable file changed during staging");
        const parent = posix.dirname(entry.path);
        if (parent !== ".") await staging.mkdir(parent);
        await staging.write(entry.path, bytes, digest.executableMode);
        entries.push({ path: entry.path, operation: "write", ...digest });
        byteCount += bytes.length;
      }
    });
    // Detect additions, removal, or type/mode changes while capturing, before any host mutation.
    if (JSON.stringify(observed) !== JSON.stringify(await source.entries(MAX_ENTRIES)))
      throw new Error("writable tree changed during staging");
    const stage = {
      schemaVersion: 1 as const,
      runId: admission.runId,
      childId: admission.childId,
      sandbox: admission.sandbox,
      baseInventoryDigest: project.baseInventoryDigest,
      entries,
      byteCount,
    };
    if (!Value.Check(sandboxPatchStageSchema, stage))
      throw new Error("patch stage is not persistable");
    return stage;
  });
}

async function verifyPristineWorktree(
  project: SandboxProjectMaterializationDescriptor,
): Promise<void> {
  const stat = await lstat(project.generatedWorktreePath);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o022) !== 0 ||
    stat.dev !== project.worktreeIdentity.device ||
    stat.ino !== project.worktreeIdentity.inode ||
    stat.uid !== project.worktreeIdentity.uid
  )
    throw new Error("generated worktree identity changed");
  await withSandboxDirectory(project.generatedWorktreePath, async (target) => {
    const actual = await target.entries(project.baseInventory.length + 1, true);
    const expected = new Map(project.baseInventory.map((entry) => [entry.path, entry.type]));
    if (
      actual.length !== expected.size ||
      actual.some((entry) => expected.get(entry.path) !== entry.type)
    )
      throw new Error("generated worktree contains unexpected project entries");
    for (const entry of project.baseInventory) {
      if (entry.type !== "file") continue;
      const digest = await target.digest(entry.path);
      if (digest.sha256 !== entry.sha256 || digest.executableMode !== entry.executableMode)
        throw new Error("generated worktree changed before patch application");
    }
  });
}

async function verifyStaging(stage: SandboxPatchStage, stagePath: string): Promise<void> {
  await withSandboxDirectory(join(stagePath, "files"), async (files) => {
    for (const entry of stage.entries) {
      if (entry.operation !== "write") continue;
      const digest = await files.digest(entry.path);
      if (
        digest.sha256 !== entry.sha256 ||
        digest.size !== entry.size ||
        digest.executableMode !== entry.executableMode
      )
        throw new Error("staged patch changed before application");
    }
  });
}

async function applyStage(
  stage: SandboxPatchStage,
  stagePath: string,
  project: SandboxProjectMaterializationDescriptor,
  options: SandboxProjectIngestionOptions,
  signal: AbortSignal,
): Promise<void> {
  await withSandboxDirectory(project.generatedWorktreePath, async (target) => {
    await withSandboxDirectory(join(stagePath, "files"), async (staging) => {
      let index = 0;
      for (const entry of stage.entries) {
        signal.throwIfAborted();
        await options.beforeApplyEntry?.(index++);
        signal.throwIfAborted();
        if (entry.operation === "delete") {
          await target.remove(entry.path);
          continue;
        }
        const bytes = await staging.read(entry.path, entry.size);
        if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
          throw new Error("staged patch changed before application");
        // Removing a former directory only succeeds when all its former tracked files are gone.
        const formerDirectories = project.baseInventory
          .filter(
            (base) =>
              base.type === "directory" &&
              (base.path === entry.path || base.path.startsWith(`${entry.path}/`)),
          )
          .sort((a, b) => b.path.length - a.path.length);
        for (const directory of formerDirectories)
          await target.removeEmptyDirectory(directory.path);
        const parent = posix.dirname(entry.path);
        if (parent !== ".") await target.mkdir(parent);
        await target.write(entry.path, bytes, entry.executableMode);
      }
    });
  });
}

async function readCompletedJournal(projectPath: string): Promise<boolean> {
  return withSandboxDirectory(projectPath, async (files) => {
    const applying: unknown = JSON.parse(
      (await files.read("integration-applying.json", 4096)).toString("utf8"),
    );
    if (!Value.Check(sandboxIntegrationJournalSchema, applying) || applying.outcome !== "applying")
      return false;
    if (!(await exists(join(projectPath, "integration-complete.json")))) return false;
    const completed: unknown = JSON.parse(
      (await files.read("integration-complete.json", 4096)).toString("utf8"),
    );
    return (
      Value.Check(sandboxIntegrationJournalSchema, completed) &&
      completed.outcome === "completed" &&
      completed.stage === applying.stage
    );
  }).catch(() => false);
}

async function durableJson(path: string, value: unknown): Promise<void> {
  if (
    !Value.Check(
      path.endsWith("/stage.json") ? sandboxPatchStageSchema : sandboxIntegrationJournalSchema,
      value,
    )
  )
    throw new Error("sandbox integration metadata is not persistable");
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
