import { describe, expect, it } from "vitest";
import { createReportedContextCapture } from "../../src/host/reported-context.js";

function messageEnd(content: readonly unknown[], stopReason = "toolUse") {
  return {
    type: "message_end",
    message: { role: "assistant", stopReason, content },
  } as never;
}

describe("exact v2 reported-context binding", () => {
  it("binds only text in the exact assistant message before the matching control call", () => {
    const capture = createReportedContextCapture();
    capture.observe(messageEnd([{ type: "text", text: "nearby" }]));
    capture.observe(
      messageEnd([
        { type: "text", text: " first " },
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "second" },
        { type: "toolCall", id: "control-1", name: "handoff", arguments: {} },
      ]),
    );
    expect(capture.read("control-1")).toEqual({
      text: "first second",
      utf8_bytes: 12,
      truncated: false,
    });
    expect(capture.read("missing")).toBeNull();
  });

  it("does not substitute trailing or latest-message prose and truncates UTF-8 safely", () => {
    const capture = createReportedContextCapture();
    capture.observe(
      messageEnd([
        { type: "text", text: "😀".repeat(2000) },
        { type: "toolCall", id: "control-2", name: "end", arguments: {} },
        { type: "text", text: "trailing prose" },
      ]),
    );
    const result = capture.read("control-2");
    expect(result?.truncated).toBe(true);
    expect(result?.text.endsWith("\ud83d")).toBe(false);
    expect(capture.read(undefined)).toBeNull();
  });

  it("omits assistant error messages", () => {
    const capture = createReportedContextCapture();
    capture.observe(
      messageEnd(
        [
          { type: "text", text: "provider error" },
          { type: "toolCall", id: "control-3", name: "handoff", arguments: {} },
        ],
        "error",
      ),
    );
    expect(capture.read("control-3")).toBeNull();
  });
});
