/** Host-owned progressive-disclosure request controller — Issue #51. */

import type { Role } from "../core/types.js";
import type { ProgressiveDisclosurePolicy } from "../manifest/types.js";
import type { PersistedRecord, ProgressiveDisclosureRecord } from "../persistence/log.js";
import type { RequestFilesArgs } from "../seam/schema.js";
import type { RequestFilesBridgeHandler, RequestFilesBridgeResult } from "./rpc/delegate-bridge.js";
import {
  expandProgressiveProjection,
  ProgressiveProjectionError,
  type ProgressiveProjectionExpansionResult,
  type ProgressiveProjectionGitAuthority,
} from "./workspace/progressive-projection.js";

/** Build the serialized, fail-closed host controller for one role visit's disclosures. */
export function createRequestFilesBridgeHandler(options: {
  readonly commit: string;
  readonly policy: ProgressiveDisclosurePolicy;
  readonly role: Role;
  readonly runId: string;
  readonly visitIndex: number;
  /** Captured before session setup; absence is a typed unavailable request outcome. */
  readonly authority: ProgressiveProjectionGitAuthority | undefined;
  /** Existing confined-tool policy applies equally to disclosed files. */
  readonly isReadOnly: boolean;
  readonly persistRecord: (record: PersistedRecord) => void;
}): RequestFilesBridgeHandler {
  let requestFilesTail: Promise<void> = Promise.resolve();
  let progressiveDisclosureCompromised = false;

  return (args) => {
    const request = requestFilesTail.then(async () => {
      if (progressiveDisclosureCompromised) {
        return projectionCompromisedRequest({ ...options, args });
      }
      const handled = await handleRequestFiles({ ...options, args });
      if (handled.compromised) progressiveDisclosureCompromised = true;
      return handled.result;
    });
    requestFilesTail = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  };
}

interface RequestFilesHandlingResult {
  readonly compromised: boolean;
  readonly result: RequestFilesBridgeResult;
}

async function handleRequestFiles(options: {
  readonly args: RequestFilesArgs;
  readonly commit: string;
  readonly policy: ProgressiveDisclosurePolicy;
  readonly role: Role;
  readonly runId: string;
  readonly visitIndex: number;
  /** Captured before session setup; absence is a typed unavailable request outcome. */
  readonly authority: ProgressiveProjectionGitAuthority | undefined;
  /** Existing confined-tool policy applies equally to disclosed files. */
  readonly isReadOnly: boolean;
  readonly persistRecord: (record: PersistedRecord) => void;
}): Promise<RequestFilesHandlingResult> {
  let disclosedPaths: readonly string[] = [];
  try {
    const expansion =
      options.authority === undefined
        ? ({ kind: "unavailable", code: "workspace-unavailable" } as const)
        : await expandProgressiveProjection(
            options.authority,
            options.policy,
            options.args.paths,
            options.commit,
            options.isReadOnly,
          );
    const outcome = requestFilesOutcome(expansion);
    disclosedPaths = outcome.disclosedPaths;
    options.persistRecord(progressiveDisclosureRecord(options, outcome.kind, disclosedPaths));
    return { compromised: false, result: outcome.result };
  } catch (error) {
    const materializedPaths =
      error instanceof ProgressiveProjectionError ? error.disclosedPaths : disclosedPaths;
    return {
      compromised: true,
      result: projectionCompromisedRequest({ ...options, disclosedPaths: materializedPaths }),
    };
  }
}

function projectionCompromisedRequest(options: {
  readonly args: RequestFilesArgs;
  readonly role: Role;
  readonly runId: string;
  readonly visitIndex: number;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly disclosedPaths?: readonly string[];
}): RequestFilesBridgeResult {
  const disclosedPaths = options.disclosedPaths ?? [];
  try {
    options.persistRecord(progressiveDisclosureRecord(options, "unavailable", disclosedPaths));
  } catch {
    // A failed fallback audit must not allow a later request to widen the projection.
  }
  return {
    content: [
      {
        type: "text",
        text: "Request unavailable because progressive disclosure is compromised for this role visit.",
      },
    ],
    details: { outcome: "unavailable", code: "projection-compromised" },
    isError: true,
    terminate: true,
  };
}

function progressiveDisclosureRecord(
  options: {
    readonly args: RequestFilesArgs;
    readonly role: Role;
    readonly runId: string;
    readonly visitIndex: number;
  },
  outcome: ProgressiveDisclosureRecord["outcome"],
  disclosedPaths: readonly string[],
): ProgressiveDisclosureRecord {
  return {
    type: "progressive_disclosure",
    run_id: options.runId,
    role: options.role,
    visit_index: options.visitIndex,
    requested_paths: [...options.args.paths],
    reason: options.args.reason,
    outcome,
    disclosed_paths: disclosedPaths,
    ts: Date.now(),
  };
}

function requestFilesOutcome(expansion: ProgressiveProjectionExpansionResult): {
  readonly kind: ProgressiveDisclosureRecord["outcome"];
  readonly disclosedPaths: readonly string[];
  readonly result: RequestFilesBridgeResult;
} {
  switch (expansion.kind) {
    case "approved":
      return {
        kind: "approved",
        disclosedPaths: expansion.disclosedPaths,
        result: {
          content: [
            {
              type: "text",
              text: `Approved ${expansion.disclosedPaths.length} requested file(s).`,
            },
          ],
          details: {
            outcome: "approved",
            disclosed_paths: expansion.disclosedPaths,
          },
          isError: false,
          terminate: false,
        },
      };
    case "denied": {
      const path = "path" in expansion ? expansion.path : undefined;
      return {
        kind: "denied",
        disclosedPaths: [],
        result: {
          content: [
            {
              type: "text",
              text: `Request denied: ${expansion.code} for '${path ?? "request"}'.`,
            },
          ],
          details: {
            outcome: "denied",
            code: expansion.code,
            ...(path === undefined ? {} : { path }),
          },
          isError: true,
          terminate: false,
        },
      };
    }
    case "pin-mismatch":
      return {
        kind: "unavailable",
        disclosedPaths: [],
        result: {
          content: [
            {
              type: "text",
              text: "Request unavailable because the workspace no longer matches the pinned snapshot.",
            },
          ],
          details: {
            outcome: "unavailable",
            code: "pin-mismatch",
            expected_pinned_commit: expansion.expectedPinnedCommit,
            workspace_head: expansion.workspaceHead,
          },
          isError: true,
          terminate: false,
        },
      };
    case "unavailable": {
      const details =
        "path" in expansion
          ? { outcome: "unavailable", path: expansion.path }
          : { outcome: "unavailable", code: expansion.code };
      return {
        kind: "unavailable",
        disclosedPaths: [],
        result: {
          content: [
            {
              type: "text",
              text: "Request unavailable from the pinned workspace.",
            },
          ],
          details,
          isError: true,
          terminate: false,
        },
      };
    }
  }
}
