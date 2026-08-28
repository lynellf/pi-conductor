import { describe, expect, it } from "vitest";

import { effectiveContextArtifactLimits } from "../../src/manifest/context-artifact-limits.js";
import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";

function manifest(limits?: string): string {
  return `
version: 3
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: parent
    max_visits: 1
    tools: [delegate]
    delegation:
      allowed_subagents: [focused]
      max_children_per_session: 2
      max_parallel: 1
${limits === undefined ? "" : `      context_artifact_limits:\n${limits}`}
subagents:
  - name: focused
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: child.md
`;
}

describe("Issue #60 delegation context artifact limits", () => {
  it("keeps an omitted block absent while supplying exact admission defaults", () => {
    const policy = parseManifest(manifest()).roles[1]?.delegation;

    expect(policy?.context_artifact_limits).toBeUndefined();
    expect(effectiveContextArtifactLimits(policy)).toEqual({
      max_items: 8,
      max_item_utf8_bytes: 8192,
      max_total_utf8_bytes: 32768,
    });
  });

  it("parses and freezes all configured limits at their hard maxima", () => {
    const policy = parseManifest(
      manifest(`
        max_items: 16
        max_item_utf8_bytes: 32768
        max_total_utf8_bytes: 131072`),
    ).roles[1]?.delegation;

    expect(policy?.context_artifact_limits).toEqual({
      max_items: 16,
      max_item_utf8_bytes: 32768,
      max_total_utf8_bytes: 131072,
    });
    expect(Object.isFrozen(policy?.context_artifact_limits)).toBe(true);
  });

  it.each([
    ["missing member", "        max_items: 8\n        max_item_utf8_bytes: 8192"],
    [
      "unknown member",
      "        max_items: 8\n        max_item_utf8_bytes: 8192\n        max_total_utf8_bytes: 32768\n        tokens: 1",
    ],
    [
      "zero",
      "        max_items: 0\n        max_item_utf8_bytes: 1\n        max_total_utf8_bytes: 1",
    ],
    [
      "fraction",
      "        max_items: 1.5\n        max_item_utf8_bytes: 1\n        max_total_utf8_bytes: 1",
    ],
    [
      "unsafe integer",
      `        max_items: 1\n        max_item_utf8_bytes: 1\n        max_total_utf8_bytes: ${Number.MAX_SAFE_INTEGER + 1}`,
    ],
    [
      "item above hard max",
      "        max_items: 1\n        max_item_utf8_bytes: 32769\n        max_total_utf8_bytes: 32769",
    ],
    [
      "total above hard max",
      "        max_items: 1\n        max_item_utf8_bytes: 1\n        max_total_utf8_bytes: 131073",
    ],
    [
      "total below item",
      "        max_items: 1\n        max_item_utf8_bytes: 8192\n        max_total_utf8_bytes: 8191",
    ],
  ])("rejects %s", (_name, limits) => {
    expect(() => parseManifest(manifest(limits))).toThrow(ManifestParseError);
  });
});
