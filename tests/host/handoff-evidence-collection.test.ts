/**
 * Issue #135, Phase 3: host collection service (worktree snapshot + execution
 * capture). Reads only — the service performs read-only git queries and turns
 * host-observed execution facts into bounded, redacted records.
 *
 * Tests cover (plan, Phase 3 RED):
 *   - clean worktree snapshot;
 *   - pre-existing dirty work (dirty at run-start baseline) flagged preexisting;
 *   - changes during the visit flagged new;
 *   - non-git backend → explicit `unavailable` reason;
 *   - git failure (no commits) → explicit `unavailable` reason;
 *   - bounds truncation counts omissions;
 *   - redaction cases (credential-like strings, absolute paths, multi-line
 *     commands);
 *   - captured execution facts carry host-observed exit status, duration,
 *     digest, and never raw full output.
 *
 * Persisted shape mirrors the Phase 2 schema: a snapshot worktree is
 * `{ head, dirty_paths }` (no `kind`), an unavailable worktree is
 * `{ kind: "unavailable", reason }`, a captured command carries
 * `{ command, host_exit_status, elapsed_ms, output_digest, output_head }`,
 * and an unavailable command is `{ kind: "unavailable", reason }`.
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectHandoffEvidence,
  collectRunStartBaseline,
} from "../../src/host/handoff-evidence/index.js";
import {
  HANDOFF_EVIDENCE_MAX_COMMANDS,
  HANDOFF_EVIDENCE_MAX_DIRTY_PATHS,
  HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES,
} from "../../src/manifest/handoff-evidence.js";
import type {
  CommandCapture,
  HandoffEvidenceRecord,
  HandoffUnavailable,
} from "../../src/persistence/handoff-evidence-schema.js";

const emptyPolicy = Object.freeze({
  max_dirty_paths: 64,
  max_commands: 16,
  max_command_identity_chars: 512,
  max_output_head_bytes: 1024,
});

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hoe-repo-"));
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

/** The snapshot worktree facet (the `worktree` union member without `kind`). */
type SnapshotWorktreeFacet = Exclude<HandoffEvidenceRecord["worktree"], HandoffUnavailable>;

/** Narrow a handoff-evidence record to its snapshot facet. Omitting `worktree`
 * and re-adding it as the snapshot facet *replaces* the field (a `&
 * HandoffEvidenceRecord` intersection fails to narrow under strict TS). */
type SnapshotRecord = Omit<HandoffEvidenceRecord, "worktree"> & {
  readonly worktree: SnapshotWorktreeFacet;
};

/** Distinguish the snapshot worktree facet from the unavailable marker. The
 * snapshot member has no `kind`; the `in` operator narrows to the one that
 * does (accessing `kind` on the bare union member without it errors). */
function hasUnavailableKind(worktree: HandoffEvidenceRecord["worktree"]): boolean {
  return "kind" in worktree && worktree.kind === "unavailable";
}

function isSnapshot(record: HandoffEvidenceRecord): record is SnapshotRecord {
  return !hasUnavailableKind(record.worktree);
}

/** Distinguish the unavailable worktree facet so its `reason` is addressable. */
type UnavailableRecord = Omit<HandoffEvidenceRecord, "worktree"> & {
  readonly worktree: HandoffUnavailable;
};

function isUnavailable(record: HandoffEvidenceRecord): record is UnavailableRecord {
  return hasUnavailableKind(record.worktree);
}

/**
 * Return one command capture by index, asserting it is a real command (not an
 * unavailable marker and not absent). Strict TS needs this because a record's
 * `commands` array is a union of command captures and unavailable markers,
 * and `noUncheckedIndexedAccess` makes indexing possibly-undefined.
 */
function assertCommandCapture(
  commands: readonly (CommandCapture | HandoffUnavailable)[],
  index: number,
): CommandCapture {
  const item = commands[index];
  if (item === undefined || ("kind" in item && item.kind === "unavailable")) {
    throw new Error("expected a command capture");
  }
  // Narrowing above leaves a command capture, but TS keeps the unavailable
  // member in the negation; the guard makes the cast safe.
  return item as CommandCapture;
}

describe("collectRunStartBaseline", () => {
  it("returns the dirty paths observed at run start", async () => {
    const dir = await freshRepo();
    try {
      await dirty(dir, { "alpha.txt": "x\n", "beta.txt": "y\n" });
      const baseline = await collectRunStartBaseline(dir);
      expect(baseline).toContain("alpha.txt");
      expect(baseline).toContain("beta.txt");
      expect(baseline).not.toContain("README.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a non-git backend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoe-nongit-"));
    try {
      await writeFile(join(dir, "notes.txt"), "not git");
      expect(await collectRunStartBaseline(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("collectHandoffEvidence — worktree snapshot", () => {
  it("captures a clean worktree snapshot", async () => {
    const dir = await freshRepo();
    try {
      const record = collectHandoffEvidence({
        run_id: "run-clean",
        handoff_id: "handoff-clean",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_000,
      });
      expect(record.type).toBe("handoff_evidence");
      if (!isSnapshot(record)) throw new Error("expected a snapshot worktree");
      expect(record.worktree.head).toMatch(/^[0-9a-f]{40,64}$/);
      expect(record.worktree.dirty_paths).toEqual([]);
      expect(record.omitted).toEqual({ dirty_paths: 0, commands: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags pre-existing dirty work from the run-start baseline", async () => {
    const dir = await freshRepo();
    try {
      // Pre-existing dirt present at run-start baseline time.
      await dirty(dir, { "legacy.txt": "old\n" });
      const baseline = await collectRunStartBaseline(dir);

      // A change made during the visit.
      await dirty(dir, { "new.txt": "fresh\n" });

      const record = collectHandoffEvidence({
        run_id: "run-baseline",
        handoff_id: "handoff-baseline",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_001,
        baseline,
      });
      if (!isSnapshot(record)) throw new Error("expected snapshot");
      const legacy = record.worktree.dirty_paths.find((p) => p.path === "legacy.txt");
      const recent = record.worktree.dirty_paths.find((p) => p.path === "new.txt");
      expect(legacy).toBeDefined();
      expect(legacy?.preexisting).toBe(true);
      expect(recent).toBeDefined();
      expect(recent?.preexisting).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags every path as new when no baseline was captured", async () => {
    const dir = await freshRepo();
    try {
      await dirty(dir, { "sneaky.txt": "z\n" });
      const record = collectHandoffEvidence({
        run_id: "run-nobaseline",
        handoff_id: "handoff-nobaseline",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_002,
      });
      if (!isSnapshot(record)) throw new Error("expected snapshot");
      const path = record.worktree.dirty_paths.find((p) => p.path === "sneaky.txt");
      expect(path).toBeDefined();
      expect(path?.preexisting).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an explicit non_git_backend reason for a non-git backend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoe-nongit2-"));
    try {
      await writeFile(join(dir, "notes.txt"), "not git");
      const record = collectHandoffEvidence({
        run_id: "run-nongit",
        handoff_id: "handoff-nongit",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_003,
      });
      if (!isUnavailable(record)) throw new Error("expected unavailable worktree");
      expect(record.worktree.kind).toBe("unavailable");
      expect(record.worktree.reason).toBe("non_git_backend");
      expect(record.commands).toEqual([]);
      expect(record.omitted).toEqual({ dirty_paths: 0, commands: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an explicit git_operation_failed reason when HEAD is unreadable", async () => {
    // A repo with no commits: rev-parse --git-dir succeeds, HEAD fails.
    const dir = await mkdtemp(join(tmpdir(), "hoe-nohead-"));
    try {
      const res = spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
      if (res.status !== 0) throw new Error(`git init failed with ${res.status}`);
      const record = collectHandoffEvidence({
        run_id: "run-nohead",
        handoff_id: "handoff-nohead",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_004,
      });
      if (!isUnavailable(record)) throw new Error("expected unavailable worktree");
      expect(record.worktree.kind).toBe("unavailable");
      expect(record.worktree.reason).toBe("git_operation_failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts omitted paths when the cap is exceeded", async () => {
    const dir = await freshRepo();
    try {
      // Populate 2 * policy.max_dirty_paths to force truncation + omission.
      const files: Record<string, string> = {};
      const n = HANDOFF_EVIDENCE_MAX_DIRTY_PATHS * 2;
      for (let i = 0; i < n; i += 1) files[`d${i}.txt`] = `${i}\n`;
      await dirty(dir, files);
      const record = collectHandoffEvidence({
        run_id: "run-bounds",
        handoff_id: "handoff-bounds",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_005,
      });
      if (!isSnapshot(record)) throw new Error("expected snapshot");
      expect(record.worktree.dirty_paths.length).toBe(HANDOFF_EVIDENCE_MAX_DIRTY_PATHS);
      expect(record.omitted.dirty_paths).toBe(HANDOFF_EVIDENCE_MAX_DIRTY_PATHS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never surfaces git internal paths", async () => {
    const dir = await freshRepo();
    try {
      await dirty(dir, { "tracked.txt": "changed\n" });
      const record = collectHandoffEvidence({
        run_id: "run-gitinternal",
        handoff_id: "handoff-gitinternal",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_006,
      });
      if (!isSnapshot(record)) throw new Error("expected snapshot");
      for (const path of record.worktree.dirty_paths) {
        expect(path.path).not.toContain(".git");
        expect(path.path.startsWith(".git")).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("collectHandoffEvidence — execution capture", () => {
  it("captures host-observed exit status, duration, digest, and a bounded head", async () => {
    const dir = await freshRepo();
    try {
      const record = collectHandoffEvidence({
        run_id: "run-cmd",
        handoff_id: "handoff-cmd",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_010,
        observations: [
          {
            command: "echo hello",
            host_exit_status: 0,
            elapsed_ms: 42,
            output: Buffer.from("hello world\n", "utf8"),
          },
          {
            command: "false",
            host_exit_status: 1,
            elapsed_ms: 3,
            output: Buffer.from("boom\n", "utf8"),
          },
        ],
      });
      if (!isSnapshot(record)) throw new Error("expected snapshot");
      expect(record.commands.length).toBe(2);
      // Observations are chronological (oldest first); the record is most
      // recent first, so `false` (newer) leads and `echo hello` trails.
      const a = assertCommandCapture(record.commands, 0);
      const b = assertCommandCapture(record.commands, 1);
      expect(a.command).toBe("false");
      expect(a.host_exit_status).toBe(1);
      expect(a.elapsed_ms).toBe(3);
      expect(a.output_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(a.output_head).toBe("boom\n");
      // `echo hello` trails as the oldest capture.
      expect(b.host_exit_status).toBe(0);
      expect(b.command).toBe("echo hello");
      expect(b.elapsed_ms).toBe(42);
      // Never store the raw full output verbatim; only digest + head.
      expect(JSON.stringify(record)).not.toContain("hello world\n");
      expect(Buffer.byteLength(b.output_head, "utf8")).toBeLessThanOrEqual(
        HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never leaks a raw credential or absolute path from a captured command", async () => {
    const dir = await freshRepo();
    try {
      const secret = "secret".repeat(8);
      const record = collectHandoffEvidence({
        run_id: "run-secret",
        handoff_id: "handoff-secret",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_011,
        observations: [
          {
            command: `curl -H "Authorization: Bearer ${secret}" /home/tester/.ssh/id_rsa`,
            host_exit_status: 0,
            elapsed_ms: 150,
            output: Buffer.from("ok\n", "utf8"),
          },
        ],
      });
      if (!isSnapshot(record)) throw new Error("expected snapshot");
      const cmd = assertCommandCapture(record.commands, 0);
      expect(cmd.command).toContain("[redacted]");
      expect(cmd.command).not.toContain(secret);
      expect(cmd.command).not.toContain("/home/tester/.ssh/id_rsa");
      // Digest is the real sha256 of the raw output; head is a bounded redaction.
      expect(cmd.output_head).toBe("ok\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("redacts credentials and absolute paths from the output head", async () => {
    const dir = await freshRepo();
    try {
      const secret = "supersecret".repeat(6);
      const record = collectHandoffEvidence({
        run_id: "run-output-secret",
        handoff_id: "handoff-output-secret",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_014,
        observations: [
          {
            command: "echo done",
            host_exit_status: 0,
            elapsed_ms: 8,
            output: Buffer.from(`log /home/tester/.secrets\nkey=${secret}\n`, "utf8"),
          },
        ],
      });
      if (!isSnapshot(record)) throw new Error("expected snapshot");
      const cmd = assertCommandCapture(record.commands, 0);
      expect(cmd.output_head).not.toContain("/home/tester/.secrets");
      expect(cmd.output_head).not.toContain(secret);
      expect(cmd.output_head).toContain("[redacted]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("collapses multi-line commands to a single line", async () => {
    const dir = await freshRepo();
    try {
      const record = collectHandoffEvidence({
        run_id: "run-multiline",
        handoff_id: "handoff-multiline",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_012,
        observations: [
          {
            command: "echo a\n  echo b\r\necho c",
            host_exit_status: 0,
            elapsed_ms: 5,
            output: Buffer.from("", "utf8"),
          },
        ],
      });
      if (!isSnapshot(record)) throw new Error("expected snapshot");
      const cmd = assertCommandCapture(record.commands, 0);
      expect(cmd.command).not.toContain("\n");
      expect(cmd.command).not.toContain("\r");
      expect(cmd.command).toContain("echo a");
      expect(cmd.command).toContain("echo c");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("truncates and counts omitted commands at the cap", async () => {
    const dir = await freshRepo();
    try {
      const observations = Array.from({ length: HANDOFF_EVIDENCE_MAX_COMMANDS + 5 }, (_, i) => ({
        command: `cmd ${i}`,
        host_exit_status: 0,
        elapsed_ms: i,
        output: Buffer.from(`out ${i}\n`, "utf8"),
      }));
      const record = collectHandoffEvidence({
        run_id: "run-cmdbounds",
        handoff_id: "handoff-cmdbounds",
        workspace_path: dir,
        policy: emptyPolicy,
        ts: 1_700_000_000_013,
        observations,
      });
      if (!isSnapshot(record)) throw new Error("expected snapshot");
      expect(record.commands.length).toBe(HANDOFF_EVIDENCE_MAX_COMMANDS);
      expect(record.omitted.commands).toBe(5);
      // Most recent first: the highest index leads.
      const first = assertCommandCapture(record.commands, 0);
      expect(first.command).toBe(`cmd ${observations.length - 1}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
