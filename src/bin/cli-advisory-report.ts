/** Read-only `conduct advisory-report` CLI for issue #154. */

import { readdirSync, statSync } from "node:fs";
import { FileRecordLog } from "../host/log-file.js";
import { buildDelegationAdvisoryReport } from "../persistence/delegation-advisory-report.js";
import { renderDelegationAdvisoryReportMarkdown } from "../persistence/delegation-advisory-report-markdown.js";
import type { PersistedRecord } from "../persistence/log.js";

/** Usage for the aggregate-only offline report. */
export const ADVISORY_REPORT_USAGE = "Usage: conduct advisory-report <runs-dir> [--json]";

interface ParsedAdvisoryReportArgs {
  readonly runsDir: string;
  readonly json: boolean;
}

function parse(argv: readonly string[]): ParsedAdvisoryReportArgs | { readonly error: string } {
  const args = argv[0] === "advisory-report" ? argv.slice(1) : argv;
  let runsDir: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) return { error: ADVISORY_REPORT_USAGE };
    if (arg === "--json") {
      if (json) return { error: ADVISORY_REPORT_USAGE };
      json = true;
    } else if (arg.startsWith("-")) {
      return { error: `pi-conductor: unknown option '${arg}'` };
    } else if (runsDir === undefined) {
      runsDir = arg;
    } else {
      return { error: ADVISORY_REPORT_USAGE };
    }
  }
  if (runsDir === undefined) return { error: ADVISORY_REPORT_USAGE };
  return { runsDir, json };
}

function readRunRecords(runsDir: string): readonly PersistedRecord[] {
  if (!statSync(runsDir).isDirectory()) throw new Error("runs-dir is not a directory");
  const runIds = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name.slice(0, -".jsonl".length))
    .sort(compareText);
  const log = new FileRecordLog({ baseDir: runsDir });
  try {
    return runIds.flatMap((runId) => log.records(runId));
  } finally {
    log.close();
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Execute `conduct advisory-report`; it never mutates run logs or makes network calls. */
export async function runAdvisoryReportCli(
  argv: readonly string[],
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  if (
    (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) ||
    (argv.length === 2 &&
      argv[0] === "advisory-report" &&
      (argv[1] === "--help" || argv[1] === "-h"))
  ) {
    output.log(ADVISORY_REPORT_USAGE);
    return 0;
  }
  const parsed = parse(argv);
  if ("error" in parsed) {
    output.error(parsed.error);
    return 2;
  }
  try {
    const records = readRunRecords(parsed.runsDir);
    const report = buildDelegationAdvisoryReport(records);
    output.log(
      parsed.json
        ? JSON.stringify(report, null, 2)
        : renderDelegationAdvisoryReportMarkdown(report),
    );
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : "failed to read advisory report data");
    return 1;
  }
}
