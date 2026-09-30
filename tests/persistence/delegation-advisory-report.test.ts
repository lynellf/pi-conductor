/** Offline issue #154 report aggregation over fixture log records. */

import { describe, expect, it } from "vitest";
import { renderDelegationAdvisoryReportMarkdown } from "../../src/persistence/delegation-advisory-report-markdown.js";
import type { DelegationAdvisoryReport } from "../../src/persistence/delegation-advisory-report-types.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const reportModulePath = "../../src/persistence/delegation-advisory-report.js";

type ReportBuilder = (records: readonly unknown[]) => unknown;

async function loadReportBuilder(): Promise<ReportBuilder | undefined> {
  let loaded: unknown;
  try {
    loaded = await import(reportModulePath);
  } catch {
    return undefined;
  }
  if (typeof loaded !== "object" || loaded === null) return undefined;
  const candidate = (loaded as Record<string, unknown>).buildDelegationAdvisoryReport;
  return typeof candidate === "function" ? (candidate as ReportBuilder) : undefined;
}

async function buildReport(records: readonly PersistedRecord[]): Promise<unknown> {
  const builder = await loadReportBuilder();
  return builder?.(records) ?? {};
}

const fingerprint = "a".repeat(64);
const hostileProfileName = "<script>|inject</script>";
const childIds = ["child-1", "child-2", "child-3", "child-4", "child-5"] as const;

function acceptedChildren(): PersistedRecord {
  return {
    type: "delegation_submission_accepted",
    schema_version: 1,
    run_id: "run-private",
    submission_id: "submission-private",
    logical_parent_id: "parent-private",
    parent_role: "orchestrator",
    parent_visit_index: 1,
    tool_call_id: "tool-private",
    input_fingerprint: fingerprint,
    children: childIds.map((child_id, index) => ({
      child_id,
      task_id: `task-${index + 1}`,
      subagent: index === 0 ? hostileProfileName : index === 1 ? "implementer" : "reviewer",
      model: "test:model",
      branch: `branch-${child_id}`,
      worktree_path: `/private/worktrees/${child_id}`,
      base_commit: "base-private",
      task_fingerprint: fingerprint,
      profile_fingerprint: fingerprint,
      context_fingerprint: fingerprint,
      prompt_fingerprint: fingerprint,
      projection_fingerprint: { kind: "exact", path_count: 2, sha256: fingerprint },
    })),
    ts: 1,
  };
}

function terminal(
  childId: (typeof childIds)[number],
  status: "completed" | "no_changes" | "blocked" | "failed" | "cancelled",
): PersistedRecord {
  const common = {
    run_id: "run-private",
    child_id: childId,
    task_id: `task-${childIds.indexOf(childId) + 1}`,
    subagent:
      childIds.indexOf(childId) === 0
        ? hostileProfileName
        : childIds.indexOf(childId) < 2
          ? "implementer"
          : "reviewer",
    model: "test:model",
    branch: `branch-${childId}`,
    worktree_path: `/private/worktrees/${childId}`,
    base_commit: "base-private",
    head_commit: "head-private",
    ts: 2,
  };
  if (status === "completed" || status === "no_changes") {
    return {
      type: "subagent_completed",
      ...common,
      status,
      summary: "PRIVATE CHILD SUMMARY",
      session_file: "/private/sessions/child.jsonl",
      usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, tokens: 2, cost: 0 },
    };
  }
  return {
    type: "subagent_failed",
    ...common,
    status,
    failure_reason: "PRIVATE FAILURE TEXT",
    head_commit: null,
    session_file: null,
    usage: null,
  };
}

function dispatchAdvisory(
  childId: "child-1" | "child-2",
  values: {
    readonly objective: number;
    readonly output: number;
    readonly selfContained: number;
    readonly scope: {
      readonly choice: "single_contract" | "related_bundle" | "unrelated_bundle";
      readonly confidence: number;
      readonly probabilities: Readonly<{
        single_contract: number;
        related_bundle: number;
        unrelated_bundle: number;
      }>;
    };
    readonly profileFit: {
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    };
  },
): PersistedRecord {
  return {
    type: "delegation_dispatch_advisory",
    schema_version: 1,
    run_id: "run-private",
    logical_parent_id: "parent-private",
    child_id: childId,
    task_id: `task-${childIds.indexOf(childId) + 1}`,
    subagent: childId === "child-1" ? hostileProfileName : "implementer",
    input_sha256: fingerprint,
    status: "completed",
    requested_model: "jev-latest",
    actual_model: "jev-1.13",
    usage: { input_tokens: 4, output_tokens: 2 },
    ts: 3,
    judgments: {
      objective_verifiable: { noul: values.objective },
      output_checkable: { noul: values.output },
      self_contained: { noul: values.selfContained },
      scope: values.scope,
      profile_fit: values.profileFit,
    },
  };
}

function unavailableAdvisory(
  type: "delegation_dispatch_advisory" | "delegation_result_advisory",
  childId: "child-3",
): PersistedRecord {
  const common = {
    schema_version: 1 as const,
    run_id: "run-private",
    logical_parent_id: "parent-private",
    child_id: childId,
    task_id: "task-3",
    subagent: "reviewer",
    input_sha256: fingerprint,
    status: "unavailable" as const,
    failure: { code: "request_timeout" as const, attempts: 1 },
    requested_model: "jev-latest",
    ts: 4,
  };
  if (type === "delegation_dispatch_advisory") return { type, ...common };
  return { type, ...common, host_status: "failed" };
}

function resultAdvisory(
  childId: "child-1" | "child-2",
  hostStatus: "completed" | "no_changes",
  claims: {
    readonly choice: "supported" | "contradicted" | "not_assessable";
    readonly confidence: number;
    readonly probabilities: Readonly<{
      supported: number;
      contradicted: number;
      not_assessable: number;
    }>;
  },
  objectiveAddressed: number,
): PersistedRecord {
  return {
    type: "delegation_result_advisory",
    schema_version: 1,
    run_id: "run-private",
    logical_parent_id: "parent-private",
    child_id: childId,
    task_id: `task-${childIds.indexOf(childId) + 1}`,
    subagent: "implementer",
    input_sha256: fingerprint,
    status: "completed",
    requested_model: "jev-latest",
    actual_model: "jev-1.13",
    usage: { input_tokens: 4, output_tokens: 2 },
    ts: 5,
    host_status: hostStatus,
    judgments: {
      claims_supported: claims,
      objective_addressed: { noul: objectiveAddressed },
    },
  };
}

function fixtureRecords(): PersistedRecord[] {
  return [
    acceptedChildren(),
    terminal("child-1", "completed"),
    terminal("child-2", "no_changes"),
    terminal("child-3", "failed"),
    terminal("child-4", "cancelled"),
    terminal("child-5", "blocked"),
    dispatchAdvisory("child-1", {
      objective: 0.1,
      output: 0.2,
      selfContained: 0.4,
      scope: {
        choice: "single_contract",
        confidence: 0.9,
        probabilities: { single_contract: 0.7, related_bundle: 0.2, unrelated_bundle: 0.1 },
      },
      profileFit: {
        choice: hostileProfileName,
        confidence: 0.6,
        probabilities: { [hostileProfileName]: 0.6, reviewer: 0.3, none_fit: 0.1 },
      },
    }),
    dispatchAdvisory("child-2", {
      objective: 0.2,
      output: 0.4,
      selfContained: 0.6,
      scope: {
        choice: "related_bundle",
        confidence: 0.4,
        probabilities: { single_contract: 0.2, related_bundle: 0.6, unrelated_bundle: 0.2 },
      },
      profileFit: {
        choice: "reviewer",
        confidence: 0.7,
        probabilities: { implementer: 0.2, reviewer: 0.7, none_fit: 0.1 },
      },
    }),
    unavailableAdvisory("delegation_dispatch_advisory", "child-3"),
    resultAdvisory(
      "child-1",
      "completed",
      {
        choice: "contradicted",
        confidence: 0.85,
        probabilities: { supported: 0.1, contradicted: 0.8, not_assessable: 0.1 },
      },
      0.9,
    ),
    resultAdvisory(
      "child-2",
      "no_changes",
      {
        choice: "supported",
        confidence: 0.55,
        probabilities: { supported: 0.6, contradicted: 0.3, not_assessable: 0.1 },
      },
      0.6,
    ),
    unavailableAdvisory("delegation_result_advisory", "child-3"),
  ];
}

describe("buildDelegationAdvisoryReport", () => {
  it("joins accepted children and terminal outcomes while counting unavailable and missing advisories", async () => {
    const report = await buildReport(fixtureRecords());

    expect(report).toMatchObject({
      coverage: {
        admitted_tasks: 5,
        dispatch: { completed: 2, unavailable: 1, missing: 2 },
        terminal_children: 5,
        result: { completed: 2, unavailable: 1, missing: 2 },
      },
      noul: {
        objective_verifiable: {
          by_probability_bucket: {
            "<0.2": { total: 1, status_counts: { completed: 1 } },
            "0.2–0.4": { total: 1, status_counts: { no_changes: 1 } },
          },
        },
      },
    });
  });

  it("reports Choice status rates, profile-fit agreement, and contradictions by host status", async () => {
    const report = await buildReport(fixtureRecords());

    expect(report).toMatchObject({
      choices: {
        scope: {
          by_argmax: {
            single_contract: { total: 1, status_counts: { completed: 1 } },
            related_bundle: { total: 1, status_counts: { no_changes: 1 } },
          },
          by_confidence_bucket: {
            "0.4–0.6": { total: 1 },
            "≥0.8": { total: 1 },
          },
        },
        profile_fit: {
          agreement: { judged: 2, agreed: 1, rate: 0.5 },
          outcomes: {
            agree: { total: 1, status_counts: { completed: 1 } },
            disagree: { total: 1, status_counts: { no_changes: 1 } },
          },
        },
        claims_supported: {
          contradicted_by_host_status: {
            completed: { total: 1, contradicted: 1, rate: 1 },
            no_changes: { total: 1, contradicted: 0, rate: 0 },
          },
        },
      },
    });
  });

  it("HTML-escapes dynamic profile labels in the Markdown table", async () => {
    const report = await buildReport(fixtureRecords());
    const markdown = renderDelegationAdvisoryReportMarkdown(report as DelegationAdvisoryReport);

    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).not.toContain("<script>");
  });

  it("is deterministic and excludes run identities, paths, and child prose", async () => {
    const records = fixtureRecords();
    const first = await buildReport(records);
    const second = await buildReport([...records].reverse());
    const serialized = JSON.stringify(first);

    expect(JSON.stringify(second)).toBe(serialized);
    expect(serialized).not.toContain("run-private");
    expect(serialized).not.toContain("/private/worktrees");
    expect(serialized).not.toContain("PRIVATE CHILD SUMMARY");
    expect(serialized).not.toContain("PRIVATE FAILURE TEXT");
  });
});
