/**
 * Issue #135, Phase 3: production-host seam wiring for host-observed handoff
 * evidence (src/host/handoff-evidence/production.ts).
 *
 * Exercises the seam that bridges the read-only collection service to the live
 * role session: workspace extraction, the null-workspace `unavailable` path,
 * the run-scoped baseline cache (captured once at run start), and the persist
 * contract of the accepted-handoff collection seam. Reads only — no workspace
 * mutation and no re-execution of role commands.
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { HandoffEvidencePolicy } from "../../src/core/types.js";
import { collectRunStartBaseline } from "../../src/host/handoff-evidence/index.js";
import {
  captureRunEvidenceBaselineInModule,
  collectEvidenceRecord,
  collectHandoffEvidenceInModule,
  type EvidenceHostContext,
  workspaceEvidenceArgs,
} from "../../src/host/handoff-evidence/production.js";
import type { RoleSession } from "../../src/host/role-session-contract.js";
import type {
  HandoffEvidenceRecord,
  HandoffUnavailable,
} from "../../src/persistence/handoff-evidence-schema.js";

const policy = Object.freeze({
  max_dirty_paths: 64,
  max_commands: 16,
  max_command_identity_chars: 512,
  max_output_head_bytes: 1024,
} as const satisfies HandoffEvidencePolicy);

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hoe-prod-"));
  const run = (args: string[]): void => {
    const res = spawnSync("git", args, { cwd: dir, stdio: "ignore" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed with ${res.status}`);
  };
  run(["init", "-q"]);
  run(["config", "user.email", "test@test.com"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "README.md"), "# Test\n");
  run(["add", "README.md"]);
  run(["commit", "-q", "-m", "initial"]);
  return dir;
}

async function dirty(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, dirname(name)), { recursive: true }).catch(() => undefined);
    await writeFile(join(dir, name), content);
  }
}

function fakeSession(workspace: RoleSession["workspace"]): RoleSession {
  return { workspace } as unknown as RoleSession;
}

function fakeWorkspaceSession(path_or_image: string): RoleSession {
  return fakeSession({
    backend: "git",
    path_or_image,
    guarantee: "confined",
  });
}

function makeContext(
  baseline: Map<string, readonly string[] | null> = new Map(),
): EvidenceHostContext {
  return {
    evidenceBaseline: baseline,
    persistRecord: () => undefined,
  };
}

type UnavailableRecord = Omit<HandoffEvidenceRecord, "worktree"> & {
  readonly worktree: HandoffUnavailable;
};

type SnapshotWorktreeFacet = Exclude<HandoffEvidenceRecord["worktree"], HandoffUnavailable>;
type SnapshotRecord = Omit<HandoffEvidenceRecord, "worktree"> & {
  readonly worktree: SnapshotWorktreeFacet;
};

/** Distinguish the snapshot worktree facet (no `kind`) from the unavailable marker. */
function hasUnavailableKind(worktree: HandoffEvidenceRecord["worktree"]): boolean {
  return "kind" in worktree && worktree.kind === "unavailable";
}

/** Distinguish the unavailable worktree facet so its `reason` is addressable. */
function isUnavailable(record: HandoffEvidenceRecord): record is UnavailableRecord {
  return hasUnavailableKind(record.worktree);
}

/** Narrow to the snapshot facet so `dirty_paths` is addressable. */
function isSnapshot(record: HandoffEvidenceRecord): record is SnapshotRecord {
  return !hasUnavailableKind(record.worktree);
}

describe("workspaceEvidenceArgs", () => {
  it("extracts the provisioned workspace path and backend from a session", () => {
    const args = workspaceEvidenceArgs(fakeWorkspaceSession("/work/sandbox"));
    expect(args).toEqual({
      workspace_path: "/work/sandbox",
      workspace_backend: "git",
    });
  });

  it("returns null fields when the session has no workspace descriptor", () => {
    const args = workspaceEvidenceArgs(fakeSession(undefined));
    expect(args.workspace_path).toBeNull();
    expect(args.workspace_backend).toBeNull();
  });
});

describe("collectEvidenceRecord — no provisioned workspace", () => {
  it("produces an explicit unavailable marker rather than a fabricated snapshot", () => {
    const record = collectEvidenceRecord({
      workspace_path: null,
      baseline: null,
      policy,
      run_id: "run-nows",
      handoff_id: "handoff-nows",
      ts: 1_700_000_000_000,
    });
    expect(record.type).toBe("handoff_evidence");
    if (!isUnavailable(record)) throw new Error("expected an unavailable worktree");
    expect(record.worktree.reason).toBe("non_git_backend");
    expect(record.commands).toEqual([]);
    expect(record.omitted).toEqual({ dirty_paths: 0, commands: 0 });
  });
});

describe("captureRunEvidenceBaselineInModule", () => {
  it("captures a git workspace's baseline once and leaves it unchanged on re-entry", async () => {
    const dir = await freshRepo();
    try {
      await dirty(dir, { "alpha.txt": "x\n" });
      const context = makeContext();
      await captureRunEvidenceBaselineInModule(context, fakeWorkspaceSession(dir));
      const first = context.evidenceBaseline.get(dir);
      expect(first).toContain("alpha.txt");

      // New dirt appears after the baseline was captured. The run-scoped
      // baseline must NOT re-capture (captured once at run start), so the
      // cached value stays exactly as it was.
      await dirty(dir, { "beta.txt": "y\n" });
      await captureRunEvidenceBaselineInModule(context, fakeWorkspaceSession(dir));
      expect(context.evidenceBaseline.get(dir)).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not cache a workspace with no provisioned path", () => {
    const context = makeContext();
    expect(() => captureRunEvidenceBaselineInModule(context, fakeSession(undefined))).not.toThrow();
    expect(context.evidenceBaseline.size).toBe(0);
  });

  it("records a null baseline for a non-git backend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoe-prod-nongit-"));
    try {
      await writeFile(join(dir, "notes.txt"), "not git");
      const context = makeContext();
      await captureRunEvidenceBaselineInModule(context, fakeWorkspaceSession(dir));
      // A non-git backend yields a null baseline; caching the null key records
      // that this workspace was resolved, so re-entry is a no-op.
      expect(context.evidenceBaseline.get(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("collectHandoffEvidenceInModule", () => {
  it("persists exactly one record and returns it", async () => {
    const dir = await freshRepo();
    try {
      // Run-scoped baseline captured empty (no dirt at run start).
      const recorded: HandoffEvidenceRecord[] = [];
      const context: EvidenceHostContext = {
        evidenceBaseline: new Map([[dir, []]]),
        persistRecord: (record) => {
          recorded.push(record);
        },
      };
      const returned = await collectHandoffEvidenceInModule(context, fakeWorkspaceSession(dir), {
        policy,
        run_id: "run-persist",
        ts: 1_700_000_000_000,
      });
      // The seam persists exactly once and returns the same object the loop appends.
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toBe(returned);
      expect(returned.type).toBe("handoff_evidence");
      expect(returned.run_id).toBe("run-persist");
      // The seam generates the run-scoped handoff id rather than the caller.
      expect(typeof returned.handoff_id).toBe("string");
      expect(returned.handoff_id.length).toBeGreaterThan(0);
      // A clean git worktree yields a real snapshot (not an unavailable marker).
      expect(isSnapshot(returned)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags non-git baseline paths as preexisting on the current workspace", async () => {
    const dir = await freshRepo();
    try {
      // A baseline path present at run start is flagged preexisting.
      await dirty(dir, { "legacy.txt": "old\n" });
      const baseline = await collectRunStartBaseline(dir);
      await dirty(dir, { "new.txt": "fresh\n" });

      const context = makeContext(new Map([[dir, baseline ?? []]]));
      const record = await collectHandoffEvidenceInModule(context, fakeWorkspaceSession(dir), {
        policy,
        run_id: "run-baseline",
        ts: 1_700_000_000_001,
      });
      if (!isSnapshot(record)) throw new Error("expected a snapshot worktree");
      const legacy = record.worktree.dirty_paths.find((p) => p.path === "legacy.txt");
      const recent = record.worktree.dirty_paths.find((p) => p.path === "new.txt");
      expect(legacy?.preexisting).toBe(true);
      expect(recent?.preexisting).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
