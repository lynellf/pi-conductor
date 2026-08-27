import { describe, expect, it } from "vitest";

import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";

function manifest(protocol?: string): string {
  return `
version: 2
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: parent
    max_visits: 1
subagents:
  - name: child
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/child.md
${protocol === undefined ? "" : `    completion_protocol: ${protocol}`}
`;
}

describe("Issue #57 completion-protocol manifest migration", () => {
  it("normalizes an omitted profile protocol to legacy report_result", () => {
    expect(parseManifest(manifest()).subagents?.[0]?.completion_protocol).toBe("report_result");
  });

  it.each(["report_result", "minimal"])("parses the explicit %s profile protocol", (protocol) => {
    expect(parseManifest(manifest(protocol)).subagents?.[0]?.completion_protocol).toBe(protocol);
  });

  it("rejects an unknown protocol before a parent can receive delegate", () => {
    expect(() => parseManifest(manifest("automatic"))).toThrow(ManifestParseError);
  });
});
