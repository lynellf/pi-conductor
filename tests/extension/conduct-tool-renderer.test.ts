/**
 * Tests for the `conduct.role.tool` message renderer (Phase 7B.UX).
 *
 * Coverage:
 *   - Renderer returns a `Container` for tool_call summary content.
 *   - Renderer returns a `Container` for tool_result ✓ / ✗ content.
 *   - Renderer returns `undefined` on throw (defense-in-depth).
 *   - `createConductMessageRenderers` returns BOTH `conduct.role.text`
 *     and `conduct.role.tool` keys.
 *   - M1 (amended): body is `Markdown` (blockquote-wrapped), not `Text`.
 *   - M2: role label uses `TOOL_LABEL_COLOR`, not orchestrator colors.
 */

import type { MessageRenderOptions, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  type ConductMessageDetails,
  createConductMessageRenderers,
} from "../../src/extension/conduct-message-renderer.js";

/**
 * Stub `Theme` whose styling functions return their text input
 * prefixed with the color name (for assertion). Same pattern as
 * `conduct-message-renderer.test.ts`.
 */
function makeStubTheme(): Theme {
  const tag = (color: string | undefined, text: string) => `[${color ?? "?"}]${text}`;
  return {
    fg: (color: ThemeColor, text: string) => tag(color, text),
    bg: (color: ThemeColor, text: string) => tag(`bg:${color}`, text),
    bold: (text: string) => tag("bold", text),
    italic: (text: string) => tag("italic", text),
    underline: (text: string) => tag("underline", text),
    inverse: (text: string) => tag("inverse", text),
    strikethrough: (text: string) => tag("strikethrough", text),
  } as unknown as Theme;
}

const OPTIONS: MessageRenderOptions = { expanded: true };

/**
 * Build a `CustomMessage<ConductMessageDetails>` for tests.
 */
function makeMessage(args: {
  readonly customType: "conduct.role.tool" | "conduct.role.text";
  readonly content: string;
  readonly details?: ConductMessageDetails;
}): never {
  return {
    customType: args.customType,
    content: args.content,
    details: args.details,
  } as unknown as never;
}

/** Get the `conduct.role.tool` renderer with a runtime guard. */
function toolRenderer(renderers: ReturnType<typeof createConductMessageRenderers>) {
  const r = renderers["conduct.role.tool"];
  if (r === undefined) throw new Error("conduct.role.tool renderer not registered");
  return r;
}

/** Get the `conduct.role.text` renderer with a runtime guard. */
function textRenderer(renderers: ReturnType<typeof createConductMessageRenderers>) {
  const r = renderers["conduct.role.text"];
  if (r === undefined) throw new Error("conduct.role.text renderer not registered");
  return r;
}

/**
 * Reach into a `Text` or `Markdown` component to read the
 * `text` it was constructed with.
 */
function getInternalText(component: { readonly text?: unknown }): string {
  return typeof component.text === "string" ? component.text : "(no text)";
}

describe("createConductMessageRenderers — tool renderer", () => {
  it("returns conduct.role.text, conduct.role.text_stream, and conduct.role.tool keys", () => {
    const renderers = createConductMessageRenderers();
    expect(Object.keys(renderers).sort()).toEqual([
      "conduct.role.text",
      "conduct.role.text_stream",
      "conduct.role.tool",
    ]);
    expect(typeof renderers["conduct.role.text"]).toBe("function");
    expect(typeof renderers["conduct.role.text_stream"]).toBe("function");
    expect(typeof renderers["conduct.role.tool"]).toBe("function");
  });

  it("renders a tool_call summary (e.g. 'bash: ls') as a Container (blockquote-wrapped Markdown body)", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers();
    const renderer = toolRenderer(renderers);

    const message = makeMessage({
      customType: "conduct.role.tool",
      content: "bash: ls",
      details: { role: "worker", kind: "tool", is_orchestrator: false },
    });

    const component = renderer(message, OPTIONS, theme);
    expect(component).toBeInstanceOf(Container);

    const container = component as Container;
    expect(container.children).toHaveLength(2);

    const [label, body] = container.children;
    expect(label).toBeInstanceOf(Text);
    expect(body).toBeInstanceOf(Markdown);
    const bodyText = getInternalText(body as unknown as { text?: string });
    expect(bodyText).toBe("> bash: ls");
  });

  it("renders a tool_result ✓ indicator as a Container (blockquote-wrapped Markdown body)", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers();
    const renderer = toolRenderer(renderers);

    const message = makeMessage({
      customType: "conduct.role.tool",
      content: "✓",
      details: { role: "orchestrator", kind: "tool", is_orchestrator: true },
    });

    const component = renderer(message, OPTIONS, theme);
    expect(component).toBeInstanceOf(Container);
    const [, body] = (component as Container).children;
    expect(body).toBeInstanceOf(Markdown);
    const bodyText = getInternalText(body as unknown as { text?: string });
    expect(bodyText).toBe("> ✓");
  });

  it("renders a tool_result ✗ <first line> indicator as a Container (blockquote-wrapped Markdown body)", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers();
    const renderer = toolRenderer(renderers);

    const message = makeMessage({
      customType: "conduct.role.tool",
      content: "✗ permission denied",
      details: { role: "worker", kind: "tool", is_orchestrator: false },
    });

    const component = renderer(message, OPTIONS, theme);
    expect(component).toBeInstanceOf(Container);
    const [, body] = (component as Container).children;
    expect(body).toBeInstanceOf(Markdown);
    const bodyText = getInternalText(body as unknown as { text?: string });
    expect(bodyText).toBe("> ✗ permission denied");
  });

  it("returns undefined on a forced throw (defense-in-depth)", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers();
    const renderer = toolRenderer(renderers);

    const exploding = {
      customType: "conduct.role.tool",
      content: "ignored",
      get details() {
        throw new Error("forced");
      },
    } as unknown as never;

    const result = renderer(exploding, OPTIONS, theme);
    expect(result).toBeUndefined();
  });

  it("renders safely when details is missing (defensive fallback; Markdown body)", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers();
    const renderer = toolRenderer(renderers);

    const message = {
      customType: "conduct.role.tool",
      content: "bash: ls",
    } as unknown as never;

    const component = renderer(message, OPTIONS, theme);
    expect(component).toBeInstanceOf(Container);
    const [label, body] = (component as Container).children;
    expect(label).toBeInstanceOf(Text);
    expect(body).toBeInstanceOf(Markdown);
    const labelText = getInternalText(label as unknown as { text?: string });
    expect(labelText).toContain("(unknown)");
    const bodyText = getInternalText(body as unknown as { text?: string });
    expect(bodyText).toBe("> bash: ls");
  });

  // ─── M1 (amended): Body is Markdown (blockquote-wrapped), not Text ──

  it("M1 (amended): body child is a Markdown component (blockquote-wrapped), not Text", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => "orchestrator");
    const tRenderer = toolRenderer(renderers);
    const textR = textRenderer(renderers);

    const toolMsg = makeMessage({
      customType: "conduct.role.tool",
      content: "bash: ls",
      details: { role: "worker", kind: "tool", is_orchestrator: false },
    });
    const textMsg = makeMessage({
      customType: "conduct.role.text",
      content: "hello world",
      details: { role: "worker", kind: "text", is_orchestrator: false },
    });

    // Tool renderer (amended M1): body is Markdown (blockquote-wrapped)
    const toolComponent = tRenderer(toolMsg, OPTIONS, theme) as Container;
    const toolBody = toolComponent.children[1];
    expect(toolBody).toBeInstanceOf(Markdown);
    expect(toolBody instanceof Text).toBe(false);
    const toolBodyText = getInternalText(toolBody as unknown as { text?: string });
    expect(toolBodyText).toBe("> bash: ls");

    // Text renderer: body is still Markdown (unchanged)
    const textComponent = textR(textMsg, OPTIONS, theme) as Container;
    const textBody = textComponent.children[1];
    expect(textBody).toBeInstanceOf(Markdown);
  });

  // ─── M2: Role label uses TOOL_LABEL_COLOR ────────────────────────

  it("M2: tool renderer label uses TOOL_LABEL_COLOR ('dim'), not ORCHESTRATOR_LABEL_COLOR ('mdHeading')", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => "orchestrator");
    const renderer = toolRenderer(renderers);

    // Render a tool message with is_orchestrator=true. The tool
    // renderer must still use 'dim', NOT 'mdHeading'.
    const message = makeMessage({
      customType: "conduct.role.tool",
      content: "bash: ls",
      details: { role: "orchestrator", kind: "tool", is_orchestrator: true },
    });
    const component = renderer(message, OPTIONS, theme) as Container;
    const [label] = component.children;
    const labelText = getInternalText(label as unknown as { text?: string });

    // Tool label should use 'dim' color, not 'mdHeading'.
    expect(labelText).toContain("[dim]");
    expect(labelText).not.toContain("[mdHeading]");
  });

  it("M2: tool renderer label uses TOOL_LABEL_COLOR even for worker role", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => "orchestrator");
    const renderer = toolRenderer(renderers);

    const message = makeMessage({
      customType: "conduct.role.tool",
      content: "✓",
      details: { role: "worker", kind: "tool", is_orchestrator: false },
    });
    const component = renderer(message, OPTIONS, theme) as Container;
    const [label] = component.children;
    const labelText = getInternalText(label as unknown as { text?: string });

    // Tool label uses 'dim', not 'accent' (worker color).
    expect(labelText).toContain("[dim]");
    expect(labelText).not.toContain("[accent]");
  });
});
