import { describe, expect, it } from "vitest";
import { collectPrewalkRetainedToolResults } from "../../src/host/prewalk-retained-results.js";
import type { PrewalkDeliveryEntry } from "../../src/host/prewalk-seed-delivery.js";

function pair(name: string, path: string, text: string): PrewalkDeliveryEntry[] {
  return [
    {
      id: "call",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "one", name, arguments: { path } }],
      },
    },
    {
      id: "result",
      message: {
        role: "toolResult",
        toolCallId: "one",
        toolName: name,
        isError: false,
        content: [{ type: "text", text }],
      },
    },
  ];
}

describe("durable guide retained-results collection", () => {
  it.each([
    { tool: "read", path: "/repo/src/a.ts", text: "verbatim\n text", paths: ["src/a.ts"] },
    {
      tool: "grep",
      path: "src",
      text: "a.ts:3: hit\na.ts-4- context\nb.ts:1: hit",
      paths: ["src", "src/a.ts", "src/b.ts"],
    },
    { tool: "grep", path: "src/a.ts", text: "a.ts:3: hit", paths: ["src/a.ts", "src/a.ts/a.ts"] },
    {
      tool: "find",
      path: "src",
      text: "a.ts\nsub/b.ts",
      paths: ["src", "src/a.ts", "src/sub/b.ts"],
    },
    { tool: "ls", path: "docs", text: "a.md\nsub/", paths: ["docs", "docs/a.md", "docs/sub"] },
    { tool: "grep", path: "src", text: "[a.ts:3: old content", paths: ["src", "src/[a.ts"] },
    { tool: "find", path: "src", text: "[a.ts", paths: ["src", "src/[a.ts"] },
    { tool: "ls", path: "src", text: "[a.ts", paths: ["src", "src/[a.ts"] },
  ])("pairs whole $tool results with normalized workspace references", ({
    tool,
    path,
    text,
    paths,
  }) => {
    expect(collectPrewalkRetainedToolResults(pair(tool, path, text), "/repo")).toEqual([
      { tool_call_id: "one", tool_name: tool, referenced_paths: paths, content: text, ts: 1 },
    ]);
  });
  it("ignores prose, thinking, unpaired results and unsupported tools", () => {
    const entries = pair("bash", ".", "not a read");
    entries.push({
      id: "prose",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "do not transfer" },
          { type: "thinking", thinking: "private" },
        ],
      },
    });
    entries.push({
      id: "orphan",
      message: {
        role: "toolResult",
        toolCallId: "orphan",
        toolName: "read",
        content: [{ type: "text", text: "unpaired" }],
      },
    });
    expect(collectPrewalkRetainedToolResults(entries, "/repo")).toEqual([]);
  });
  it.each(["../outside", "/outside", "~/outside"])("rejects out-of-workspace read %s", (path) => {
    expect(collectPrewalkRetainedToolResults(pair("read", path, "secret"), "/repo")).toEqual([]);
  });
  it("does not partially replay a mixed text/image result", () => {
    const entries = pair("read", "image.png", "caption");
    entries[1] = {
      id: "result",
      message: {
        role: "toolResult",
        toolCallId: "one",
        toolName: "read",
        content: [
          { type: "text", text: "caption" },
          { type: "image", data: "image" },
        ],
      },
    };
    expect(collectPrewalkRetainedToolResults(entries, "/repo")).toEqual([]);
  });
  it("drops ambiguous duplicate tool IDs", () => {
    const entries = [...pair("read", "a", "first"), ...pair("read", "b", "second")];
    expect(collectPrewalkRetainedToolResults(entries, "/repo")).toEqual([]);
  });
});
