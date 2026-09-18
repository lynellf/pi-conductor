/**
 * Read-only `conduct continuity-report` CLI — durable-continuity spec §12.
 *
 * Usage:
 *   conduct continuity-report --log-dir <dir> <run-id> --format json|markdown|okf-candidates
 *
 * The command uses the production log reader and the same validators/
 * materializer/renderers as the host. It never mutates the run or repository.
 *
 * Output formats:
 * - `json`: complete materialized operator view (deterministic JSON)
 * - `markdown`: human-readable ledger with provenance and evidence status
 * - `okf-candidates`: non-superseded verified findings with exact evidence
 *
 * Exit codes:
 *   0 — report generated successfully
 *   1 — run not found, malformed/unsupported log, or materialization error
 *   2 — usage error
 *
 * spec §12: "Malformed records, missing required evidence, unsafe paths, and
 * unknown schema versions produce non-zero exit status and bounded diagnostics.
 * The CLI must not use a second interpretation of the schema."
 *
 * Write-owned by: Lane C (DC-LEDGER). Reads the production log reader from
 * `src/persistence/log.ts` and `src/host/log-file.ts`.
 */

import { existsSync } from "node:fs";

import { FileRecordLog } from "../host/log-file.js";
import type { ContinuityLedger } from "../persistence/continuity.js";
import {
  ContinuityMaterializationException,
  materializeContinuity,
} from "../persistence/continuity-materialization.js";
import {
  renderLedgerJson,
  renderLedgerMarkdown,
  renderOkfCandidates,
} from "../persistence/continuity-render.js";
import type { PersistedRecord } from "../persistence/log.js";

// ─── Public API ─────────────────────────────────────────────────────────

export type ContinuityReportFormat = "json" | "markdown" | "okf-candidates";

export interface ContinuityReportOptions {
  readonly logDir: string;
  readonly runId: string;
  readonly format: ContinuityReportFormat;
}

export interface ContinuityReportResult {
  readonly output: string;
  readonly exitCode: 0 | 1 | 2;
  readonly errorMessage?: string;
}

/** Execute the continuity-report CLI and return structured result. */
export async function runContinuityReport(
  opts: ContinuityReportOptions,
): Promise<ContinuityReportResult> {
  const { logDir, runId, format } = opts;

  // Verify log directory exists
  if (!existsSync(logDir)) {
    return {
      output: "",
      exitCode: 1,
      errorMessage: `log directory not found: ${logDir}`,
    };
  }

  // Build the file-backed record log reader
  let log: FileRecordLog;
  try {
    log = new FileRecordLog({ baseDir: logDir });
  } catch (error) {
    return {
      output: "",
      exitCode: 1,
      errorMessage: `failed to open log directory '${logDir}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Read all records for the run
  let records: readonly PersistedRecord[];
  try {
    records = log.records(runId);
  } catch (error) {
    log.close();
    return {
      output: "",
      exitCode: 1,
      errorMessage: `malformed log for run '${runId}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  log.close();

  // Materialize the ledger
  let ledger: ContinuityLedger;
  try {
    ledger = materializeContinuity(records, { run_id: runId });
  } catch (error) {
    if (error instanceof ContinuityMaterializationException) {
      return {
        output: "",
        exitCode: 1,
        errorMessage: `[${error.code}] record=${error.record_id}: ${error.message}`,
      };
    }
    return {
      output: "",
      exitCode: 1,
      errorMessage: `materialization failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Render the appropriate format
  let output: string;
  try {
    switch (format) {
      case "json":
        output = renderLedgerJson(ledger);
        break;
      case "markdown":
        output = renderLedgerMarkdown(ledger);
        break;
      case "okf-candidates":
        output = renderOkfCandidates(ledger);
        break;
      default:
        return {
          output: "",
          exitCode: 2,
          errorMessage: `unknown format '${String(format)}'; expected json|markdown|okf-candidates`,
        };
    }
  } catch (error) {
    return {
      output: "",
      exitCode: 1,
      errorMessage: `rendering failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { output, exitCode: 0 };
}

// ─── Argv parsing ────────────────────────────────────────────────────────

const CONTINUITY_USAGE =
  "Usage: conduct continuity-report --log-dir <path> <run-id> --format json|markdown|okf-candidates";

interface ParsedContinuityArgs {
  readonly logDir: string;
  readonly runId: string;
  readonly format: ContinuityReportFormat;
}

function parseContinuityArgv(argv: readonly string[]): ParsedContinuityArgs | { error: string } {
  if (argv.length === 0) return { error: CONTINUITY_USAGE };

  // Skip "continuity-report" command name if present
  const startIndex = argv[0] === "continuity-report" ? 1 : 0;
  const args = argv.slice(startIndex);

  if (args.length === 0) return { error: CONTINUITY_USAGE };

  let logDir: string | undefined;
  let format: ContinuityReportFormat | undefined;
  let runId: string | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) return { error: CONTINUITY_USAGE };
    if (arg === "--log-dir") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--"))
        return { error: "pi-conductor: --log-dir requires a path" };
      logDir = value;
      i += 2;
    } else if (arg === "--format") {
      const fmt = args[i + 1];
      if (fmt === undefined) return { error: "pi-conductor: --format requires a value" };
      if (fmt === "json" || fmt === "markdown" || fmt === "okf-candidates") {
        format = fmt;
      } else {
        return {
          error: `pi-conductor: --format must be json|markdown|okf-candidates, got '${fmt}'`,
        };
      }
      i += 2;
    } else if (arg.startsWith("-")) {
      return { error: `pi-conductor: unknown option '${arg}'` };
    } else if (runId === undefined) {
      runId = arg;
      i += 1;
    } else {
      return { error: `pi-conductor: unexpected argument '${arg}'` };
    }
  }

  if (logDir === undefined) return { error: "pi-conductor: --log-dir is required" };
  if (runId === undefined) return { error: "pi-conductor: <run-id> is required" };
  if (format === undefined) return { error: "pi-conductor: --format is required" };

  return { logDir, runId, format };
}

// ─── CLI entrypoint (for integration with cli-main.ts) ─────────────────

/**
 * Run the continuity-report CLI from argv. Exported for integration with
 * `cli-main.ts`. Returns the exit code; callers handle stdout/stderr.
 */
export async function runContinuityCli(
  argv: readonly string[],
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    output.log(CONTINUITY_USAGE);
    return 0;
  }

  const parsed = parseContinuityArgv(argv);
  if ("error" in parsed) {
    output.error(parsed.error);
    return 2;
  }

  const result = await runContinuityReport(parsed);
  if (result.exitCode !== 0) {
    if (result.errorMessage !== undefined) {
      output.error(result.errorMessage);
    }
    return result.exitCode;
  }

  output.log(result.output);
  return 0;
}
