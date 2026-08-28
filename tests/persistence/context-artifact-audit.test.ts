import { describe, expect, it } from "vitest";

import { contextArtifactsAudit } from "../../src/host/delegation/context-artifact-audit.js";
import type { ResolvedContextArtifact } from "../../src/host/delegation/context-artifacts.js";
import { InMemoryRecordLog, type SubagentStartedRecord } from "../../src/persistence/log.js";

const resolved: readonly ResolvedContextArtifact[] = Object.freeze([
  Object.freeze({
    id: "inline",
    source: "inline",
    provenance: Object.freeze({ kind: "parent_inline" }),
    text: "Inline audit text.",
    byte_length: 18,
    sha256: "a".repeat(64),
  }),
  Object.freeze({
    id: "file",
    source: "file",
    provenance: Object.freeze({
      kind: "parent_materialized_file",
      path: "contract.md",
      base_commit: "base",
    }),
    text: "Repository bytes must not enter JSONL.",
    byte_length: 38,
    sha256: "b".repeat(64),
  }),
]);

describe("Issue #60 context artifact persistence audit", () => {
  it("retains inline text but only bounded metadata for a file source", () => {
    const audit = contextArtifactsAudit(resolved);

    expect(audit).toEqual({
      version: 1,
      total_utf8_bytes: 56,
      artifacts: [
        {
          ordinal: 0,
          id: "inline",
          source: "inline",
          provenance: { kind: "parent_inline" },
          byte_length: 18,
          sha256: "a".repeat(64),
          text: "Inline audit text.",
        },
        {
          ordinal: 1,
          id: "file",
          source: "file",
          provenance: {
            kind: "parent_materialized_file",
            path: "contract.md",
            base_commit: "base",
          },
          byte_length: 38,
          sha256: "b".repeat(64),
        },
      ],
    });
    expect(JSON.stringify(audit)).not.toContain("Repository bytes must not enter JSONL.");
    expect(Object.isFrozen(audit)).toBe(true);
    expect(Object.isFrozen(audit.artifacts)).toBe(true);
  });

  it("writes the exact explicit empty inventory for a new no-artifact start", () => {
    expect(contextArtifactsAudit([])).toEqual({
      version: 1,
      total_utf8_bytes: 0,
      artifacts: [],
    });
  });

  it("round-trips a historical start without inferring or rewriting an inventory", () => {
    const log = new InMemoryRecordLog();
    const historical: SubagentStartedRecord = {
      type: "subagent_started",
      run_id: "run",
      child_id: "child",
      task_id: "task",
      subagent: "focused",
      model: "stub:model",
      session_file: "child.jsonl",
      worktree_path: "/worktree",
      branch: "branch",
      base_commit: "base",
      ts: 1,
    };

    log.append(historical);
    const record = log.records("run")[0];

    expect(record?.type).toBe("subagent_started");
    expect(record !== undefined && "context_artifacts" in record).toBe(false);
  });
});
