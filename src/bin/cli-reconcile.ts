/** CLI for inspecting and operator-confirming executable-tool cleanup (issue #97). */

import { ProcessObservationError } from "../host/execution/supervised-process-identity.js";
import {
  inspectToolExecutionCleanup,
  reconcileToolExecutionCleanup,
  type ToolExecutionCleanupInspection,
} from "../host/execution/tool-execution-reconciliation.js";
import { formatObservationDiagnostic } from "./cli-observation-diagnostic.js";

/** Usage and acknowledgment semantics for the reconciliation CLI. */
export const RECONCILE_USAGE =
  "Usage: conduct reconcile-tools --log-dir <path> <run-id> [--execution <id> [--confirm-cleanup --note <text> [--partial-effects <none_observed|inspected_unpublished|immutable_publication_verified>]]]\n  --execution inspects one execution without scanning unrelated entries.\n  --confirm-cleanup attests the original host namespaces, canonical storage, ALL original processes and writers (including unmarked descendants) stopped, and partial effects inspected. Controller executions require --partial-effects.";

type PartialEffects = "none_observed" | "inspected_unpublished" | "immutable_publication_verified";

interface Parsed {
  readonly baseDir: string;
  readonly runId: string;
  readonly executionId?: string;
  readonly note?: string;
  readonly confirmed: boolean;
  readonly partialEffects?: PartialEffects;
}

function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== "reconcile-tools") throw new Error(RECONCILE_USAGE);
  let baseDir: string | undefined;
  let executionId: string | undefined;
  let note: string | undefined;
  let runId: string | undefined;
  let confirmed = false;
  let partialEffects: PartialEffects | undefined;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) throw new Error(RECONCILE_USAGE);
    if (arg === "--log-dir") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--") || baseDir !== undefined)
        throw new Error(RECONCILE_USAGE);
      baseDir = value;
    } else if (arg === "--execution") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--") || executionId !== undefined)
        throw new Error(RECONCILE_USAGE);
      executionId = value;
    } else if (arg === "--note") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--") || note !== undefined)
        throw new Error(RECONCILE_USAGE);
      note = value;
    } else if (arg === "--confirm-cleanup") {
      if (confirmed) throw new Error(RECONCILE_USAGE);
      confirmed = true;
    } else if (arg === "--partial-effects") {
      const value = argv[++i];
      if (
        (value !== "none_observed" &&
          value !== "inspected_unpublished" &&
          value !== "immutable_publication_verified") ||
        partialEffects !== undefined
      )
        throw new Error(RECONCILE_USAGE);
      partialEffects = value;
    } else if (arg.startsWith("-")) throw new Error(RECONCILE_USAGE);
    else if (runId === undefined) runId = arg;
    else throw new Error(RECONCILE_USAGE);
  }
  if (baseDir === undefined || runId === undefined) throw new Error(RECONCILE_USAGE);
  if (
    (note !== undefined && !confirmed) ||
    (partialEffects !== undefined && !confirmed) ||
    (confirmed && (executionId === undefined || note === undefined))
  )
    throw new Error(RECONCILE_USAGE);
  return {
    baseDir,
    runId,
    confirmed,
    ...(executionId !== undefined && { executionId }),
    ...(note !== undefined && { note }),
    ...(partialEffects !== undefined && { partialEffects }),
  };
}

/** Execute the reconciliation CLI and return a process exit code. */
export async function runReconcileCli(
  argv: readonly string[],
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  if (argv.length === 2 && argv[1] === "--help") {
    output.log(RECONCILE_USAGE);
    return 0;
  }
  let args: Parsed;
  try {
    args = parse(argv);
  } catch {
    output.error(RECONCILE_USAGE);
    return 1;
  }
  try {
    if (args.executionId !== undefined && args.note !== undefined) {
      const record = await reconcileToolExecutionCleanup(args.runId, args.executionId, {
        baseDir: args.baseDir,
        acknowledgment: true,
        operatorNote: args.note,
        ...(args.partialEffects === undefined
          ? {}
          : { controllerPartialEffects: args.partialEffects }),
      });
      output.log(JSON.stringify(record));
    } else {
      const inspection: ToolExecutionCleanupInspection = await inspectToolExecutionCleanup(
        args.runId,
        {
          baseDir: args.baseDir,
          ...(args.executionId === undefined ? {} : { executionId: args.executionId }),
        },
      );
      output.log(JSON.stringify(inspection));
    }
    return 0;
  } catch (error) {
    output.error(
      error instanceof ProcessObservationError
        ? formatObservationDiagnostic(error)
        : error instanceof Error
          ? error.message
          : String(error),
    );
    return 1;
  }
}
