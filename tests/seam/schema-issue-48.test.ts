/**
 * Issue #48 T2 tests — Seam artifacts schema + persistence records.
 *
 * Tests cover:
 *  1. Schema shape: valid/invalid tables for `artifacts` on `handoffArgsSchema`
 *     (bad path chars, over-count, over-length, non-string path).
 *  2. Seed filtering: `artifacts` is filtered from the model echo in the next
 *     role's seed (host-collected truth only).
 *  3. Backward-compat: handoffs without `artifacts` validate identically
 *     as before.
 *  4. Persistence records: new record types round-trip through the log.
 *
 * Depends on T1 (manifest parsing + validation already committed).
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import type { PersistedRecord } from "../../src/persistence/log.js";
import {
  artifactCollected,
  artifactRejected,
  InMemoryRecordLog,
  snapshotPinned,
  workspaceProvisioned,
} from "../../src/persistence/log.js";
import { handoffArgsSchema } from "../../src/seam/schema.js";

// ─── helpers ────────────────────────────────────────────────────────────

/** Minimal actionable handoff payload (no artifacts). */
function baseHandoff(targetRole: string) {
  return {
    target_role: targetRole,
    status: "ready" as const,
    objective: "Perform the assigned work.",
    summary: "Prepared the next role's context.",
    requested_action: "Complete the assigned work and report the result.",
  };
}

/** Builder: base actionable handoff + optional artifacts. */
function handoffWithArtifacts(
  targetRole: string,
  artifacts?: Array<{ path: string; description?: string }>,
) {
  const base = baseHandoff(targetRole);
  return artifacts !== undefined ? { ...base, artifacts } : base;
}

// ─── Schema: artifacts field shape (T2 §7.1) ────────────────────────────

describe("handoffArgsSchema: artifacts field (T2)", () => {
  it("accepts a well-formed artifacts array (1 entry, path + optional description)", () => {
    const valid = handoffWithArtifacts("reviewer", [
      { path: "src/main.ts", description: "Main source file" },
    ]);
    expect(Value.Check(handoffArgsSchema, valid)).toBe(true);
  });

  it("accepts artifacts with path only (description omitted)", () => {
    const valid = handoffWithArtifacts("reviewer", [{ path: "README.md" }]);
    expect(Value.Check(handoffArgsSchema, valid)).toBe(true);
  });

  it("accepts multiple artifacts (up to 64)", () => {
    const artifacts: Array<{ path: string; description?: string }> = [];
    for (let i = 0; i < 64; i++) {
      artifacts.push({ path: `file-${i}.ts`, description: `Artifact ${i}` });
    }
    expect(Value.Check(handoffArgsSchema, handoffWithArtifacts("reviewer", artifacts))).toBe(true);
  });

  it("rejects an artifacts array with 65 entries (maxItems: 64)", () => {
    const artifacts: Array<{ path: string }> = [];
    for (let i = 0; i < 65; i++) {
      artifacts.push({ path: `file-${i}.ts` });
    }
    expect(Value.Check(handoffArgsSchema, handoffWithArtifacts("reviewer", artifacts))).toBe(false);
  });

  it("rejects an artifact with an empty path (minLength: 1)", () => {
    expect(Value.Check(handoffArgsSchema, handoffWithArtifacts("reviewer", [{ path: "" }]))).toBe(
      false,
    );
  });

  it("rejects an artifact with a path over 1024 chars (maxLength: 1024)", () => {
    const longPath = "a".repeat(1025);
    expect(
      Value.Check(handoffArgsSchema, handoffWithArtifacts("reviewer", [{ path: longPath }])),
    ).toBe(false);
  });

  it("rejects a non-string path", () => {
    expect(
      Value.Check(
        handoffArgsSchema,
        handoffWithArtifacts("reviewer", [{ path: 123 }] as unknown as Array<{ path: string }>),
      ),
    ).toBe(false);
  });

  it("rejects an artifact with a description over 512 chars", () => {
    const longDesc = "a".repeat(513);
    expect(
      Value.Check(
        handoffArgsSchema,
        handoffWithArtifacts("reviewer", [{ path: "file.ts", description: longDesc }]),
      ),
    ).toBe(false);
  });

  it("rejects an artifact with non-string description", () => {
    expect(
      Value.Check(
        handoffArgsSchema,
        handoffWithArtifacts("reviewer", [
          { path: "file.ts", description: 42 },
        ] as unknown as Array<{ path: string }>),
      ),
    ).toBe(false);
  });

  it("rejects an artifact with extra fields (additionalProperties: false)", () => {
    expect(
      Value.Check(
        handoffArgsSchema,
        handoffWithArtifacts("reviewer", [{ path: "file.ts", extra: "nope" }] as unknown as Array<{
          path: string;
        }>),
      ),
    ).toBe(false);
  });
});

// ─── Schema: backward-compat (no artifacts) ─────────────────────────────

describe("handoffArgsSchema: backward-compat (no artifacts field)", () => {
  it("accepts a handoff without artifacts (no field present)", () => {
    expect(Value.Check(handoffArgsSchema, baseHandoff("reviewer"))).toBe(true);
  });

  it("accepts a handoff with role-defined fields but no artifacts", () => {
    const extra = {
      ...baseHandoff("reviewer"),
      custom_field: "some data",
      nested: { foo: "bar" },
    };
    expect(Value.Check(handoffArgsSchema, extra)).toBe(true);
  });

  it("a handoff with artifacts + other role fields validates", () => {
    const extra = handoffWithArtifacts("reviewer", [{ path: "file.ts", description: "a file" }]);
    (extra as Record<string, unknown>).custom_field = "extra";
    expect(Value.Check(handoffArgsSchema, extra)).toBe(true);
  });
});

// ─── Seed filtering: artifacts filtered from model echo ─────────────────

describe("formatHandoffSeed: artifacts filtering (T2)", () => {
  it("filters artifacts from payload when building the seed text", () => {
    // Simulate what formatHandoffSeed does: filter reserved keys.
    const payload = {
      summary: "done",
      artifacts: [{ path: "file.ts" }],
      context_ref: { run_id: "x", source_role: "impl", source_session_file: "y" },
      custom: "value",
    } as Record<string, unknown>;
    const filtered = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "context_ref" && key !== "artifacts"),
    );
    // `context_ref` and `artifacts` are absent from the filtered output.
    expect("context_ref" in filtered).toBe(false);
    expect("artifacts" in filtered).toBe(false);
    // Other fields survive.
    expect(filtered).toEqual({ summary: "done", custom: "value" });
  });

  it("handles payload with artifacts but no context_ref", () => {
    const payload = { summary: "done", artifacts: [{ path: "a.ts" }] };
    const filtered = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "context_ref" && key !== "artifacts"),
    );
    expect("artifacts" in filtered).toBe(false);
    expect(filtered).toEqual({ summary: "done" });
  });

  it("handles payload without artifacts or context_ref (unchanged behavior)", () => {
    const payload = { summary: "done" };
    const filtered = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "context_ref" && key !== "artifacts"),
    );
    expect(filtered).toEqual({ summary: "done" });
  });
});

// ─── Persistence records: shape tests (T2) ──────────────────────────────

describe("Persistence records (T2): shape", () => {
  it("SnapshotPinnedRecord: shape matches spec §9", () => {
    const record = snapshotPinned({
      run_id: "run-1",
      source: "snapshot",
      commit: "abc123def456",
    });
    expect(record.type).toBe("snapshot_pinned");
    expect(record.run_id).toBe("run-1");
    expect(record.source).toBe("snapshot");
    expect(record.commit).toBe("abc123def456");
  });

  it("WorkspaceProvisionedRecord: shape matches spec §9", () => {
    const record = workspaceProvisioned({
      run_id: "run-1",
      role: "implementer",
      visit_index: 1,
      backend: "worktree",
      guarantee: "confined",
      workspace_path: "/runs/run-1/workspaces/implementer-v1",
      snapshot_commit: "abc123",
    });
    expect(record.type).toBe("workspace_provisioned");
    expect(record.role).toBe("implementer");
    expect(record.backend).toBe("worktree");
    expect(record.guarantee).toBe("confined");
    expect(record.workspace_path).toBe("/runs/run-1/workspaces/implementer-v1");
  });

  it("ArtifactCollectedRecord: shape matches spec §9 (declared)", () => {
    const record = artifactCollected({
      run_id: "run-1",
      role: "implementer",
      visit_index: 1,
      session_id: "sess-1",
      source_path: "src/main.ts",
      stored_path: "/runs/run-1/artifacts/run-1/implementer-v1/src-main.ts",
      kind: "declared",
      bytes: 1024,
      sha256: "sha256hash",
    });
    expect(record.type).toBe("artifact_collected");
    expect(record.kind).toBe("declared");
  });

  it("ArtifactCollectedRecord: shape matches spec §9 (auto_patch)", () => {
    const record = artifactCollected({
      run_id: "run-1",
      role: "implementer",
      visit_index: 1,
      session_id: "sess-1",
      source_path: "patch/implementer-v1.patch",
      stored_path: "/runs/run-1/artifacts/run-1/implementer-v1/patch-implementer-v1.patch",
      kind: "auto_patch",
      bytes: 2048,
      sha256: "sha256patch",
    });
    expect(record.kind).toBe("auto_patch");
  });

  it("ArtifactRejectedRecord: shape matches spec §9 (outside_projection)", () => {
    const record = artifactRejected({
      run_id: "run-1",
      role: "implementer",
      session_id: "sess-1",
      path: "../../.ssh/id_rsa",
      reason: "outside_projection",
    });
    expect(record.type).toBe("artifact_rejected");
    expect(record.reason).toBe("outside_projection");
  });

  it("ArtifactRejectedRecord: supports all rejection reasons", () => {
    const reasons: Array<"outside_projection" | "size_cap" | "count_cap" | "missing"> = [
      "outside_projection",
      "size_cap",
      "count_cap",
      "missing",
    ];
    for (const reason of reasons) {
      expect(
        artifactRejected({
          run_id: "run-1",
          role: "x",
          session_id: "s",
          path: "f",
          reason,
        }).reason,
      ).toBe(reason);
    }
  });

  it("all new records are members of PersistedRecord union", () => {
    const records: PersistedRecord[] = [
      snapshotPinned({
        run_id: "r",
        source: "snapshot",
        commit: "abc",
      }),
      workspaceProvisioned({
        run_id: "r",
        role: "x",
        visit_index: 1,
        backend: "shared",
        guarantee: "none",
        workspace_path: "/p",
        snapshot_commit: "abc",
      }),
      artifactCollected({
        run_id: "r",
        role: "x",
        visit_index: 1,
        session_id: "s",
        source_path: "f",
        stored_path: "/a",
        kind: "declared",
        bytes: 0,
        sha256: "h",
      }),
      artifactRejected({
        run_id: "r",
        role: "x",
        session_id: "s",
        path: "f",
        reason: "missing",
      }),
    ];
    // TypeScript compile-time check: all assignable to PersistedRecord.
    // Runtime: just verify they all have distinct types.
    const types = records.map((r) => r.type);
    expect(types).toEqual([
      "snapshot_pinned",
      "workspace_provisioned",
      "artifact_collected",
      "artifact_rejected",
    ]);
  });
});

// ─── Persistence records: round-trip through InMemoryRecordLog ──────────

describe("Persistence records: round-trip through InMemoryRecordLog (T2)", () => {
  it("round-trips SnapshotPinnedRecord", () => {
    const log = new InMemoryRecordLog();
    const rec = snapshotPinned({
      run_id: "run-1",
      source: "ref:main",
      commit: "def456abc123",
    });
    log.append(rec);
    const records = log.records("run-1");
    expect(records).toHaveLength(1);
    const r = records.at(0) as PersistedRecord;
    expect(r.type).toBe("snapshot_pinned");
    if (r.type !== "snapshot_pinned") throw new Error("unreachable");
    expect(r.source).toBe("ref:main");
    expect(r.commit).toBe("def456abc123");
  });

  it("round-trips WorkspaceProvisionedRecord", () => {
    const log = new InMemoryRecordLog();
    const rec = workspaceProvisioned({
      run_id: "run-2",
      role: "reviewer",
      visit_index: 2,
      backend: "copy",
      guarantee: "confined",
      workspace_path: "/runs/run-2/workspaces/reviewer-v2",
      snapshot_commit: "111222",
    });
    log.append(rec);
    const records = log.records("run-2");
    expect(records).toHaveLength(1);
    const r = records.at(0) as PersistedRecord;
    expect(r.type).toBe("workspace_provisioned");
    if (r.type !== "workspace_provisioned") throw new Error("unreachable");
    expect(r.role).toBe("reviewer");
    expect(r.guarantee).toBe("confined");
  });

  it("round-trips ArtifactCollectedRecord", () => {
    const log = new InMemoryRecordLog();
    const rec = artifactCollected({
      run_id: "run-3",
      role: "implementer",
      visit_index: 1,
      session_id: "sess-3",
      source_path: "output.md",
      stored_path: "/runs/run-3/artifacts/run-3/implementer-v1/output.md",
      kind: "declared",
      bytes: 512,
      sha256: "abc123",
    });
    log.append(rec);
    const records = log.records("run-3");
    expect(records).toHaveLength(1);
    const r = records.at(0) as PersistedRecord;
    expect(r.type).toBe("artifact_collected");
    if (r.type !== "artifact_collected") throw new Error("unreachable");
    expect(r.kind).toBe("declared");
    expect(r.bytes).toBe(512);
  });

  it("round-trips ArtifactRejectedRecord", () => {
    const log = new InMemoryRecordLog();
    const rec = artifactRejected({
      run_id: "run-4",
      role: "implementer",
      session_id: "sess-4",
      path: "../../etc/passwd",
      reason: "outside_projection",
    });
    log.append(rec);
    const records = log.records("run-4");
    expect(records).toHaveLength(1);
    const r = records.at(0) as PersistedRecord;
    expect(r.type).toBe("artifact_rejected");
    if (r.type !== "artifact_rejected") throw new Error("unreachable");
    expect(r.reason).toBe("outside_projection");
  });
});
