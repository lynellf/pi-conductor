/** Pure source preparation chronology; recovery never accepts unattached terminal evidence (#118). */
import { assertSourceWorkspaceRecord, type SourceWorkspaceIntent } from "./source-workspace.js";

/** Recognize private source records without interpreting arbitrary controller payloads. */
export function isSourceWorkspaceRecord(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    value.type.startsWith("source_workspace_")
  );
}

/** Enforce one pinned intent, one start and at most one terminal for each immutable preparation. */
export function assertSourceWorkspaceHistory(records: readonly unknown[]): void {
  const workspaces = new Map<
    string,
    { intent: SourceWorkspaceIntent; state: "pinned" | "started" | "terminal" }
  >();
  const actions = new Set<string>();
  for (const candidate of records) {
    if (!isSourceWorkspaceRecord(candidate)) continue;
    assertSourceWorkspaceRecord(candidate);
    const record = candidate;
    if (record.type === "source_workspace_intent") {
      const action = JSON.stringify([record.run_id, record.definition_digest, record.action_id]);
      if (workspaces.has(record.workspace_id) || actions.has(action))
        throw new Error("source preparation intent repeats an immutable action");
      actions.add(action);
      workspaces.set(record.workspace_id, { intent: record, state: "pinned" });
      continue;
    }
    const workspace = workspaces.get(record.workspace_id);
    if (workspace === undefined)
      throw new Error("source preparation evidence has no pinned intent");
    for (const key of [
      "run_id",
      "controller_id",
      "definition_digest",
      "activation_id",
      "owner_epoch",
    ] as const)
      if (record[key] !== workspace.intent[key])
        throw new Error("source preparation owner does not match its intent");
    if (record.type === "source_workspace_started") {
      if (workspace.state !== "pinned" || record.action_id !== workspace.intent.action_id)
        throw new Error("source preparation start does not follow its intent");
      workspace.state = "started";
      continue;
    }
    if (workspace.state !== "started")
      throw new Error("source preparation terminal does not follow a unique start");
    if (
      record.type === "source_workspace_prepared" &&
      (record.intent_digest !== workspace.intent.workspace_id ||
        !record.ref.startsWith(`source-workspace/v1/${workspace.intent.workspace_id}/`))
    )
      throw new Error("source publication is not bound to its pinned intent");
    workspace.state = "terminal";
  }
}
