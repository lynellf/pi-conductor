/** Actionable failure raised when a session file cannot authorize restoration. */
export class OrchestratorContextFileError extends Error {
  readonly code:
    | "missing_file"
    | "malformed_jsonl"
    | "invalid_header"
    | "invalid_entry"
    | "duplicate_id"
    | "broken_parent_chain"
    | "cyclic_parent_chain"
    | "unknown_tip"
    | "hash_mismatch"
    | "unresolved_tool_call"
    | "sdk_restore_failed";

  constructor(code: OrchestratorContextFileError["code"], message: string) {
    super(message);
    this.name = "OrchestratorContextFileError";
    this.code = code;
  }
}
