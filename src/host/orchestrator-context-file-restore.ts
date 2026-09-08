import { readFile } from "node:fs/promises";

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
  const forkSessionFile = source.createBranchedSession(boundary.leaf_id);
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
  if (manager.getLeafId() !== boundary.leaf_id) {
    throw new OrchestratorContextFileError(
      "sdk_restore_failed",
      "created fork does not end at the committed tip",
    );
  }
  const restoredEntries = manager.getBranch();
  if (
    restoredEntries.length !== validated.entries.length ||
    restoredEntries.some(
      (entry, index) => JSON.stringify(entry) !== JSON.stringify(validated.entries[index]),
    )
  ) {
    throw new OrchestratorContextFileError(
      "sdk_restore_failed",
      "created fork does not preserve the validated provider-visible history",
    );
  }
  return { sessionFile: forkSessionFile, manager, reference: boundary };
}
