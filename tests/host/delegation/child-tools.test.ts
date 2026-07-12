import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { buildConfinedTools } from "../../../src/host/delegation/child-tools.js";

async function executeTool(tool: ReturnType<typeof buildConfinedTools>[number], params: unknown) {
  return tool.execute("call-1", params as never, undefined, undefined, {} as ExtensionContext);
}

describe("path-confined child tools", () => {
  test("provides inspection tools in both workspace modes and mutation tools only for worktrees", () => {
    expect(buildConfinedTools("read_only", "/tmp/project").map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
    ]);
    expect(buildConfinedTools("worktree", "/tmp/project").map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
    ]);
  });

  test("rejects traversal and absolute paths outside the confined root", async () => {
    const read = buildConfinedTools("read_only", "/tmp/project")[0];
    if (read === undefined) throw new Error("read tool missing");

    const traversal = await executeTool(read, { path: "../outside.txt" });
    const absolute = await executeTool(read, { path: "/etc/passwd" });

    expect(traversal.content[0]).toMatchObject({ type: "text" });
    expect(absolute.content[0]).toMatchObject({ type: "text" });
    expect((traversal.content[0] as { text: string }).text).toContain("escapes");
    expect((absolute.content[0] as { text: string }).text).toContain("escapes");
  });
});
