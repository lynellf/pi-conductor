/** Issue #106 §6 trusted bootstrap protocol; no production runner is wired yet. */

/** Bootstrap's fixed pre-command framing marker. */
export const BUBBLEWRAP_READY_FRAME = "READY\n";

/** Exact release message required before the bootstrap can execute its argv. */
export const BUBBLEWRAP_RELEASE_FRAME = "PI_CONDUCTOR_BOOTSTRAP_RELEASE_V1";

const RELEASE_FRAME_LENGTH = BUBBLEWRAP_RELEASE_FRAME.length;
const RELEASE_READ_LIMIT = RELEASE_FRAME_LENGTH + 1;
const MAX_PENDING_STATUS_BYTES = 64 * 1024;

/** Fixed host-authored Bash source for the Bubblewrap authorization boundary (#106 §6). */
export const BUBBLEWRAP_BOOTSTRAP_SOURCE = `#!/bin/bash
set -eu

printf '%s' '${BUBBLEWRAP_READY_FRAME}' >&4
release=''
release_status=0
if LC_ALL=C IFS= read -r -d '' -n ${RELEASE_READ_LIMIT} -u 3 release; then
  exit 80
else
  release_status=$?
fi
if [ "$release_status" -ne 1 ] || [ "$release" != '${BUBBLEWRAP_RELEASE_FRAME}' ]; then
  exit 81
fi
exec 3<&-
exec 4>&-
exec "$@"
`;

/** One JSON object emitted by Bubblewrap's `--json-status-fd`. */
export type BubblewrapStatusFrame = Readonly<Record<string, unknown>>;

/** Validate the startup identity frame before any `/proc` observation (#106 §6). */
export function requireBubblewrapStartupStatus(frame: BubblewrapStatusFrame): Readonly<{
  childPid: number;
  pidNamespace: number;
}> {
  const childPid = frame["child-pid"];
  const pidNamespace = frame["pid-namespace"];
  if (typeof childPid !== "number" || !Number.isSafeInteger(childPid) || childPid <= 0)
    throw new Error("Bubblewrap startup status has invalid child-pid");
  if (typeof pidNamespace !== "number" || !Number.isSafeInteger(pidNamespace) || pidNamespace <= 0)
    throw new Error("Bubblewrap startup status has invalid pid-namespace");
  return Object.freeze({ childPid, pidNamespace });
}

/** Incrementally decode newline-delimited Bubblewrap JSON status frames. */
export class BubblewrapStatusParser {
  #pending = "";

  push(chunk: string): readonly BubblewrapStatusFrame[] {
    this.#pending += chunk;
    if (Buffer.byteLength(this.#pending, "utf8") > MAX_PENDING_STATUS_BYTES)
      throw new Error("Bubblewrap JSON status frame exceeds maximum size");
    const frames: BubblewrapStatusFrame[] = [];
    while (true) {
      const newline = this.#pending.indexOf("\n");
      if (newline === -1) return frames;
      const line = this.#pending.slice(0, newline);
      this.#pending = this.#pending.slice(newline + 1);
      if (line.length === 0) throw new Error("empty Bubblewrap JSON status frame");
      frames.push(parseStatusFrame(line));
    }
  }

  finish(): readonly BubblewrapStatusFrame[] {
    if (this.#pending.length !== 0)
      throw new Error("incomplete Bubblewrap JSON status frame at EOF");
    return [];
  }
}

/** Write-side pipe interface owned by the host before the user command is released. */
export interface BootstrapReleaseWriter {
  end(frame: string): Promise<void>;
}

/** Persist sandbox-ready before sending its only accepted release frame (#106 §6). */
export async function releaseAfterSandboxReady(
  writer: BootstrapReleaseWriter,
  persistSandboxReady: () => Promise<void>,
): Promise<void> {
  try {
    await persistSandboxReady();
    await writer.end(BUBBLEWRAP_RELEASE_FRAME);
  } catch (error) {
    await closeReleaseWriter(writer);
    throw error;
  }
}

function parseStatusFrame(line: string): BubblewrapStatusFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("invalid Bubblewrap JSON status frame");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Bubblewrap JSON status frame must be an object");
  return Object.freeze({ ...parsed });
}

async function closeReleaseWriter(writer: BootstrapReleaseWriter): Promise<void> {
  try {
    await writer.end("");
  } catch {
    // EOF delivery is best-effort after the primary persistence/write failure.
  }
}
