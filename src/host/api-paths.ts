import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Resolve the run-log directory, creating an isolated default when omitted. */
export async function resolveBaseDir(baseDir: string | undefined): Promise<string> {
  if (baseDir !== undefined) return baseDir;
  return mkdtemp(join(tmpdir(), "pi-conductor-run-"));
}
