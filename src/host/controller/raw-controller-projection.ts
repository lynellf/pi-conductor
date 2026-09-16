/** Safe controller-facing record projection; raw run records remain host-private — issue #116. */

/** Remove child-private transcript and context fields from opaque record references. */
export function projectControllerRecord(
  record: unknown,
  pinnedDefinition?: unknown,
): unknown | undefined {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return record;
  const value = record as Record<string, unknown>;
  if (typeof value.type === "string" && value.type.startsWith("controller_effect_"))
    return undefined;
  if (
    value.type === "subagent_started" ||
    value.type === "subagent_completed" ||
    value.type === "subagent_failed"
  ) {
    // Pre-output definitions retain their original terminal contract. Any explicit
    // output/effect policy enables redaction for the whole run, including reviewers.
    return hasPrivateOutputs(pinnedDefinition) ? childProjection(value) : structuredClone(record);
  }
  return structuredClone(record);
}

function hasPrivateOutputs(definition: unknown): boolean {
  if (!isObject(definition) || !isObject(definition.config)) return true;
  const config = definition.config;
  if ("effects" in definition || "child_outputs" in config || !Array.isArray(config.adapters))
    return true;
  return config.adapters.some(
    (adapter: unknown) =>
      !isObject(adapter) ||
      ["effect_id", "output_consumers", "source_consumers", "result_consumers"].some(
        (key) => key in adapter,
      ),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childProjection(value: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of [
    "type",
    "run_id",
    "child_id",
    "task_id",
    "subagent",
    "model",
    "status",
    "usage",
    "ts",
  ])
    if (key in value) projected[key] = structuredClone(value[key]);
  return projected;
}
