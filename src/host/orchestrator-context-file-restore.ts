import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { OrchestratorContextFileError } from "./orchestrator-context-file-errors.js";
import {
  captureOrchestratorContextBoundary,
  type RestoreContextBoundaryOptions,
  type RestoredContextBoundary,
} from "./orchestrator-context-files.js";

/** Restore one durable boundary into a new exact-tip SDK session file. */
export async function restoreOrchestratorContextBoundary(
  options: RestoreContextBoundaryOptions,
): Promise<RestoredContextBoundary> {
  const { boundary, destinationSessionDir, cwd } = options;
  const validated = await captureOrchestratorContextBoundary({
    roleSessionId: boundary.role_session_id,
    sessionFile: boundary.session_file,
    conversationId: boundary.conversation_id,
    leafId: boundary.leaf_id,
    ...(options.executedToolCallIds === undefined
      ? {}
      : { executedToolCallIds: options.executedToolCallIds }),
  });
  let sourceBytesBefore: Buffer;
  try {
    sourceBytesBefore = await readFile(boundary.session_file);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OrchestratorContextFileError("missing_file", `cannot read session file: ${detail}`);
  }
  if (validated.reference.history_sha256 !== boundary.history_sha256) {
    throw new OrchestratorContextFileError(
      "hash_mismatch",
      "session history differs from the boundary reference",
    );
  }
  const source = SessionManager.open(boundary.session_file, destinationSessionDir, cwd);
  const forkSessionFile =
    validated.effectiveEntries.length === validated.entries.length
      ? source.createBranchedSession(boundary.leaf_id)
      : await createEffectiveRetrySession({
          header: validated.header,
          entries: validated.effectiveEntries,
          sourceSessionFile: boundary.session_file,
          destinationSessionDir,
        });
  if (!forkSessionFile) {
    throw new OrchestratorContextFileError(
      "sdk_restore_failed",
      "SDK did not create a fork session file",
    );
  }
  let sourceBytesAfter: Buffer;
  try {
    sourceBytesAfter = await readFile(boundary.session_file);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OrchestratorContextFileError("missing_file", `cannot reread session file: ${detail}`);
  }
  if (!sourceBytesAfter.equals(sourceBytesBefore)) {
    throw new OrchestratorContextFileError(
      "hash_mismatch",
      "source session changed while the exact fork was being created",
    );
  }
  let manager: SessionManager;
  try {
    manager = SessionManager.open(forkSessionFile, destinationSessionDir, cwd);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OrchestratorContextFileError(
      "sdk_restore_failed",
      `created fork cannot be reopened: ${detail}`,
    );
  }
  if (
    validated.effectiveEntries.length === validated.entries.length &&
    manager.getLeafId() !== boundary.leaf_id
  ) {
    throw new OrchestratorContextFileError(
      "sdk_restore_failed",
      "created fork does not end at the committed tip",
    );
  }
  const expectedEntries =
    validated.effectiveEntries.length === validated.entries.length
      ? validated.entries
      : validated.effectiveEntries;
  const restoredEntries = manager.getBranch();
  if (
    restoredEntries.length !== expectedEntries.length ||
    restoredEntries.some(
      (entry, index) => JSON.stringify(entry) !== JSON.stringify(expectedEntries[index]),
    )
  ) {
    throw new OrchestratorContextFileError(
      "sdk_restore_failed",
      "created fork does not preserve the validated provider-visible history",
    );
  }
  return { sessionFile: forkSessionFile, manager, reference: boundary };
}

async function createEffectiveRetrySession(options: {
  readonly header: import("@earendil-works/pi-coding-agent").SessionHeader;
  readonly entries: readonly import("@earendil-works/pi-coding-agent").SessionEntry[];
  readonly sourceSessionFile: string;
  readonly destinationSessionDir: string;
}): Promise<string> {
  await mkdir(options.destinationSessionDir, { recursive: true });
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const file = join(
    options.destinationSessionDir,
    `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`,
  );
  const header = {
    ...options.header,
    id,
    timestamp,
    parentSession: options.sourceSessionFile,
  };
  await writeFile(
    file,
    `${[header, ...options.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  return file;
}
