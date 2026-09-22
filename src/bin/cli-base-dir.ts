import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** The durable run directory standalone CLI runs lay down. */
const CLI_RUNS_DIRNAME = ".pi-conductor/runs";

export type CliBaseDirOutcome =
  | { readonly ok: true; readonly baseDir: string }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve the CLI's run-log directory for a start.
 *
 * The CLI resolves an omitted `baseDir` to `<cwd>/.pi-conductor/runs` so
 * standalone runs are durably discoverable and resumable. An explicit
 * `--log-dir` is an absolute override that replaces the default entirely.
 *
 * The library's omitted-`baseDir` temporary default (`src/host/api-paths.ts`)
 * is unchanged — this durable default belongs to the CLI only, and no public
 * barrel export is added to share it. Ordinary filesystem errors from
 * creating the directory are returned verbatim; no control-character or
 * path-length policy is applied here.
 */
export async function resolveCliBaseDir(
  cwd: string,
  explicitLogDir: string | undefined,
): Promise<CliBaseDirOutcome> {
  const configured = explicitLogDir !== undefined;
  const source = configured ? explicitLogDir : CLI_RUNS_DIRNAME;
  const path = resolve(cwd, source);
  try {
    await mkdir(path, { recursive: true });
    return { ok: true, baseDir: path };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Cannot create log directory '${source}': ${message}` };
  }
}
