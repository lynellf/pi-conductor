/** Settled child-session observation without persistence or FSM access — Issue #57 §§6–7. */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { ChildFileToolCalls } from "../../persistence/child-completion.js";
import type { SessionState } from "../cost.js";
import { capChildText, type LegacyChildReport } from "./child-result.js";
import type { ChildTerminal, SpawnChildConfig } from "./delegate-tool.js";
import type { DelegationManager } from "./manager.js";

/** Single-assignment valid legacy report capture from the terminating child tool. */
export interface ReportCapture {
  readonly report: () => LegacyChildReport | null;
  readonly summaryTruncated: () => boolean;
  capture(report: LegacyChildReport, truncated: boolean): void;
}

/** Make the host-owned capture buffer for one legacy report_result tool. */
export function createReportCapture(): ReportCapture {
  let value: LegacyChildReport | null = null;
  let truncated = false;
  return {
    report: () => value,
    summaryTruncated: () => truncated,
    capture(report, didTruncate) {
      if (value !== null) return;
      value = report;
      truncated = didTruncate;
    },
  };
}

/** Await terminal settlement while retaining only bounded text and counters. */
export function observeChildTerminal(args: {
  readonly session: AgentSession;
  readonly state: SessionState;
  readonly model: string;
  readonly config: SpawnChildConfig;
  readonly manager: DelegationManager;
  readonly reportCapture: ReportCapture;
}): { readonly promise: Promise<ChildTerminal>; fail(reason: string): void } {
  let finish: ((terminal: ChildTerminal) => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let settled = false;
  let finalResponse: string | null = null;
  let finalResponseTruncated = false;
  const calls = emptyFileToolCalls();
  const seenReadTuples = new Set<string>();
  let duplicateReadCalls = 0;
  const complete = (terminal: ChildTerminal): void => {
    if (settled) return;
    settled = true;
    unsubscribe?.();
    finish?.(terminal);
  };
  const promise = new Promise<ChildTerminal>((resolve) => {
    finish = resolve;
  });
  const selectedSummaryTruncated = (): boolean =>
    args.config.profile.completion_protocol === "minimal"
      ? finalResponseTruncated
      : args.reportCapture.summaryTruncated();

  unsubscribe = args.session.subscribe((event) => {
    observeFileToolStart(event, calls, seenReadTuples, () => {
      duplicateReadCalls += 1;
    });
    if (event.type === "message_end") {
      const message = event.message as AssistantMessage;
      if (message.role === "assistant") {
        const captured = captureTextOnlyFinalResponse(message);
        finalResponse = captured.text;
        finalResponseTruncated = captured.truncated;
      }
      return;
    }
    if (event.type !== "agent_end") return;
    if (event.willRetry) {
      // The SDK has committed to retry this provider error. It is no longer
      // this child attempt's terminal cause; a later non-retrying settlement
      // will retain any final error instead.
      args.state.clearRetryableModelError();
      return;
    }
    const cancelled = args.manager.wasCancelled(args.config.childId);
    complete({
      started: true,
      model: args.model,
      report: args.reportCapture.report(),
      finalResponse,
      summaryTruncated: selectedSummaryTruncated(),
      cancelled,
      sessionError: cancelled ? null : terminalSessionError(args.state),
      fileToolCalls: calls,
      duplicateReadCalls,
      sessionFile: args.session.sessionFile ?? null,
      usage: args.state.usage(),
    });
  });

  return {
    promise,
    fail(reason) {
      complete({
        started: true,
        model: args.model,
        report: args.reportCapture.report(),
        finalResponse,
        summaryTruncated: selectedSummaryTruncated(),
        cancelled: args.manager.wasCancelled(args.config.childId),
        sessionError: reason,
        fileToolCalls: calls,
        duplicateReadCalls,
        sessionFile: args.session.sessionFile ?? null,
        usage: args.state.usage(),
      });
    },
  };
}

/** Capture only text blocks from the latest assistant message; never retain thinking/tool arguments. */
export function captureTextOnlyFinalResponse(message: AssistantMessage): {
  readonly text: string | null;
  readonly truncated: boolean;
} {
  const text = message.content
    .filter(
      (part): part is Extract<AssistantMessage["content"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .trim();
  if (text.length === 0) return { text: null, truncated: false };
  const capped = capChildText(text);
  return { text: capped.text, truncated: capped.truncated };
}

function terminalSessionError(state: SessionState): string | null {
  return state.terminalReason === null ? null : (state.failureDetail ?? state.terminalReason);
}

function observeFileToolStart(
  event: AgentSessionEvent,
  calls: { -readonly [K in keyof ChildFileToolCalls]: number },
  seenReadTuples: Set<string>,
  onDuplicateRead: () => void,
): void {
  if (event.type !== "tool_execution_start" || !isChildFileTool(event.toolName)) return;
  calls[event.toolName] += 1;
  if (event.toolName !== "read") return;
  const key = canonicalReadTuple(event.args);
  if (seenReadTuples.has(key)) onDuplicateRead();
  seenReadTuples.add(key);
}

function isChildFileTool(name: string): name is keyof ChildFileToolCalls {
  return (
    name === "read" ||
    name === "grep" ||
    name === "find" ||
    name === "ls" ||
    name === "edit" ||
    name === "write"
  );
}

function canonicalReadTuple(args: unknown): string {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  return JSON.stringify({
    path: typeof record.path === "string" ? record.path : null,
    offset: typeof record.offset === "number" ? record.offset : null,
    limit: typeof record.limit === "number" ? record.limit : null,
  });
}

function emptyFileToolCalls(): { -readonly [K in keyof ChildFileToolCalls]: number } {
  return { read: 0, grep: 0, find: 0, ls: 0, edit: 0, write: 0 };
}
