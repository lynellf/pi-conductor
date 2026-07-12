/**
 * Tests for delegation/report-result-tool.ts — `report_result` tool factory.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
  createReportResultTool,
  type ReportCapture,
} from "../../../src/host/delegation/report-result-tool.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CHILD_ID = "child-abc123def456";
const ATTEMPT = 1;

// Helper to execute the tool with proper typing
async function executeTool(
  tool: ReturnType<typeof createReportResultTool>,
  params: Parameters<typeof tool.execute>[1],
) {
  return tool.execute("call-1", params, undefined, undefined, {} as ExtensionContext);
}

// Helper to extract text content from result
function getTextContent(result: Awaited<ReturnType<typeof executeTool>>): string {
  const content = result.content[0];
  if (content?.type === "text") {
    return content.text;
  }
  return "";
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("createReportResultTool", () => {
  describe("tool shape", () => {
    test("returns a ToolDefinition with correct name", () => {
      const onReport = vi.fn();
      const tool = createReportResultTool({ childId: CHILD_ID, attempt: ATTEMPT, onReport });

      expect(tool.name).toBe("report_result");
      expect(tool.label).toBe("report_result");
      expect(tool.parameters).toBeDefined();
    });
  });

  describe("valid report calls", () => {
    test("captures completed status with summary", async () => {
      const onReport = vi.fn();
      const tool = createReportResultTool({ childId: CHILD_ID, attempt: ATTEMPT, onReport });

      const result = await executeTool(tool, {
        status: "completed",
        summary: "Found 42 files matching criteria",
        verification: ["File count: 42", "All matched pattern"],
      });

      expect(onReport).toHaveBeenCalledTimes(1);
      const capture = onReport.mock.calls[0]?.[0] as ReportCapture;
      expect(capture.childId).toBe(CHILD_ID);
      expect(capture.attempt).toBe(ATTEMPT);
      expect(capture.status).toBe("completed");
      expect(capture.summary).toBe("Found 42 files matching criteria");
      expect(capture.verification).toEqual(["File count: 42", "All matched pattern"]);
      expect(result.terminate).toBe(true);
    });

    test("captures failed status", async () => {
      const onReport = vi.fn();
      const tool = createReportResultTool({ childId: CHILD_ID, attempt: ATTEMPT, onReport });

      const result = await executeTool(tool, {
        status: "failed",
        summary: "Build command exited with code 1",
      });

      expect(onReport).toHaveBeenCalledTimes(1);
      const capture = onReport.mock.calls[0]?.[0] as ReportCapture;
      expect(capture.status).toBe("failed");
      expect(capture.summary).toBe("Build command exited with code 1");
      expect(result.terminate).toBe(true);
    });

    test("captures no_changes status", async () => {
      const onReport = vi.fn();
      const tool = createReportResultTool({ childId: CHILD_ID, attempt: ATTEMPT, onReport });

      const result = await executeTool(tool, {
        status: "no_changes",
        summary: "No files matched the search criteria",
      });

      expect(onReport).toHaveBeenCalledTimes(1);
      const capture = onReport.mock.calls[0]?.[0] as ReportCapture;
      expect(capture.status).toBe("no_changes");
      expect(result.terminate).toBe(true);
    });

    test("handles missing verification array", async () => {
      const onReport = vi.fn();
      const tool = createReportResultTool({ childId: CHILD_ID, attempt: ATTEMPT, onReport });

      const result = await executeTool(tool, {
        status: "completed",
        summary: "Done",
      });

      expect(onReport).toHaveBeenCalledTimes(1);
      const capture = onReport.mock.calls[0]?.[0] as ReportCapture;
      expect(capture.verification).toBeUndefined();
      expect(result.terminate).toBe(true);
    });

    test("returns result with child_id and status", async () => {
      const onReport = vi.fn();
      const tool = createReportResultTool({ childId: CHILD_ID, attempt: ATTEMPT, onReport });

      const result = await executeTool(tool, {
        status: "completed",
        summary: "Done",
      });

      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(getTextContent(result));
      expect(parsed.child_id).toBe(CHILD_ID);
      expect(parsed.status).toBe("completed");
    });
  });

  describe("invalid report calls", () => {
    test("rejects invalid status value", async () => {
      const onReport = vi.fn();
      const tool = createReportResultTool({ childId: CHILD_ID, attempt: ATTEMPT, onReport });

      const result = await executeTool(tool, {
        status: "invalid_status",
        summary: "test",
      } as Parameters<typeof tool.execute>[1]);

      // Schema validation fails; onReport is NOT called
      expect(onReport).not.toHaveBeenCalled();
      expect(result.terminate).toBe(false);
    });

    test("rejects missing summary", async () => {
      const onReport = vi.fn();
      const tool = createReportResultTool({ childId: CHILD_ID, attempt: ATTEMPT, onReport });

      const result = await executeTool(tool, {
        status: "completed",
      } as Parameters<typeof tool.execute>[1]);

      expect(onReport).not.toHaveBeenCalled();
      expect(result.terminate).toBe(false);
    });

    test("rejects non-object input", async () => {
      const onReport = vi.fn();
      const tool = createReportResultTool({ childId: CHILD_ID, attempt: ATTEMPT, onReport });

      const result = await executeTool(tool, null as Parameters<typeof tool.execute>[1]);

      expect(onReport).not.toHaveBeenCalled();
      expect(result.terminate).toBe(false);
    });
  });

  describe("duplicate report detection (per-attempt-local array)", () => {
    test("first call is captured, second call would be captured too (host responsibility)", async () => {
      // Note: The tool itself doesn't prevent duplicate calls.
      // The host's attempt-local array in the manager is responsible for detecting
      // duplicate reports. The tool just captures whatever is passed.
      const onReport = vi.fn();
      const tool = createReportResultTool({ childId: CHILD_ID, attempt: ATTEMPT, onReport });

      await executeTool(tool, { status: "completed", summary: "First" });
      await executeTool(tool, { status: "completed", summary: "Second" });

      // Both calls are captured (tool doesn't filter duplicates)
      expect(onReport).toHaveBeenCalledTimes(2);
    });
  });
});
