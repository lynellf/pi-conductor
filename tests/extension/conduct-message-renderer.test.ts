/**
 * Phase 5 Task 9 — conductor-owned `MessageRenderer` for the
 * two `conduct.role.*` `customType`s.
 *
 * Pins the renderer contract (Pinned SDK surfaces #1–#5 in
 * `docs/tui-bridge-plans/phase-5-renderer-polish.md`):
 *
 *   - Returns a `Container` with a structural role-label `Text`
 *     and a `Markdown` body child.
 *   - The role-label `Text` carries `details.role` as its text
 *     and is colored by role family (orchestrator in one hue,
 *     workers in another, unknown in a muted fallback).
 *   - The `Markdown` body carries `message.content` as its text
 *     and is constructed via `getMarkdownTheme()` with no
 *     `defaultTextStyle.color` override (the bug from
 *     §Diagnosis).
 *   - The renderer's own try/catch wrapper returns `undefined`
 *     on any throw, so the SDK's default `CustomMessageComponent`
 *     takes over. This is the fail-safe behavior the spec calls
 *     for (Pinned #4).
 *
 * The test mocks the `Theme` parameter minimally (a stub whose
 * `fg`/`bg`/`bold`/etc. return their text input with a
 * `[<color>]` prefix for inspection) and asserts structural
 * shape (Container, Text child, Markdown child, label color,
 * label text, body text). It does not depend on a TTY; ANSI
 * output is intentionally NOT asserted.
 */

import type {
  CustomMessage,
  MessageRenderOptions,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  type ConductMessageDetails,
  createConductMessageRenderers,
} from "../../src/extension/conduct-message-renderer.js";

/**
 * Stub `Theme` whose styling functions return their text input
 * prefixed with the color name (for assertion). We don't
 * reproduce pi's full theme surface; the renderer only calls
 * `theme.fg(color, text)` for the role label.
 */
function makeStubTheme(): Theme {
  const tag = (color: string | undefined, text: string) => `[${color ?? "?"}]${text}`;
  return {
    fg: (color: ThemeColor, text: string) => tag(color, text),
    bg: (color, text) => tag(`bg:${color}`, text),
    bold: (text: string) => tag("bold", text),
    italic: (text: string) => tag("italic", text),
    underline: (text: string) => tag("underline", text),
    inverse: (text: string) => tag("inverse", text),
    strikethrough: (text: string) => tag("strikethrough", text),
  } as unknown as Theme;
}

/** Options the SDK passes; we don't act on `expanded` in v1. */
const OPTIONS: MessageRenderOptions = { expanded: true };

/**
 * Build a `CustomMessage<ConductMessageDetails>` for tests.
 * The shape mirrors the SDK's `CustomMessage<T>` (subset the
 * renderer reads).
 */
function makeMessage(args: {
  readonly customType: "conduct.role.text" | "conduct.role.tool";
  readonly content: string;
  readonly details: ConductMessageDetails;
}): CustomMessage<ConductMessageDetails> {
  return {
    customType: args.customType,
    content: args.content,
    details: args.details,
  } as unknown as CustomMessage<ConductMessageDetails>;
}

/**
 * Reach into a `Text` or `Markdown` component to read the
 * `text` it was constructed with. The TUI components keep
 * the constructor text in a private field; we access it
 * here purely for test assertions. This is the structural
 * "shape" check the spec calls for (Pinned #5: "structural
 * shape, not ANSI output").
 */
function getInternalText(component: { readonly text?: unknown }): string {
  return typeof component.text === "string" ? component.text : "(no text)";
}

describe("createConductMessageRenderers", () => {
  it("returns a renderer for each conduct.role.* customType", () => {
    const renderers = createConductMessageRenderers();
    expect(Object.keys(renderers).sort()).toEqual(["conduct.role.text", "conduct.role.tool"]);
    expect(typeof renderers["conduct.role.text"]).toBe("function");
    expect(typeof renderers["conduct.role.tool"]).toBe("function");
  });

  it("renders a conduct.role.text message as a Container with a Text label + Markdown body", () => {
    const theme = makeStubTheme();
    // Pass a getter that returns the orchestrator role so the
    // worker label gets the worker color (accent); with a null
    // orchestrator role the renderer falls back to muted for
    // everyone (separate test below).
    const renderers = createConductMessageRenderers(() => "orchestrator");
    const renderer = renderers["conduct.role.text"];

    const message = makeMessage({
      customType: "conduct.role.text",
      content: "### worker\n\nhello world",
      details: { role: "worker", kind: "text", is_orchestrator: false },
    });

    const component = renderer(message, OPTIONS, theme);
    expect(component).toBeInstanceOf(Container);

    const container = component as Container;
    expect(container.children).toHaveLength(2);

    const [label, body] = container.children;
    expect(label).toBeInstanceOf(Text);
    expect(body).toBeInstanceOf(Markdown);

    // The label text is `details.role` wrapped by the theme's
    // fg() call. The stub theme prefixes with `[<color>]` so
    // we can assert both the color and the role text in one
    // string match.
    const labelText = getInternalText(label as unknown as { text?: string });
    expect(labelText).toContain("worker");
    expect(labelText).toContain("[accent]"); // worker color

    // The Markdown body carries the original message content.
    const bodyText = getInternalText(body as unknown as { text?: string });
    expect(bodyText).toBe("### worker\n\nhello world");
  });

  it("colors the orchestrator role label with mdHeading (yellow + bold in the default theme)", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => "orchestrator");
    const renderer = renderers["conduct.role.text"];

    const message = makeMessage({
      customType: "conduct.role.text",
      content: "### orchestrator\n\nI am planning",
      details: { role: "orchestrator", kind: "text", is_orchestrator: true },
    });

    const component = renderer(message, OPTIONS, theme);
    const container = component as Container;
    const [label] = container.children;
    const labelText = getInternalText(label as unknown as { text?: string });
    expect(labelText).toContain("orchestrator");
    expect(labelText).toContain("[mdHeading]"); // orchestrator color
  });

  it("uses the muted fallback color when no orchestrator role is known (no active run)", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => null);
    const renderer = renderers["conduct.role.text"];

    const message = makeMessage({
      customType: "conduct.role.text",
      content: "### worker\n\nstranded",
      details: { role: "worker", kind: "text", is_orchestrator: false },
    });

    const component = renderer(message, OPTIONS, theme);
    const [label] = component.children;
    const labelText = getInternalText(label as unknown as { text?: string });
    expect(labelText).toContain("[muted]"); // unknown fallback
  });

  it("renders a conduct.role.tool message with the same shape (Text label + Markdown body)", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => "orchestrator");
    const renderer = renderers["conduct.role.tool"];

    const message = makeMessage({
      customType: "conduct.role.tool",
      content: '### worker\n\nhandoff: {"target_role":"reviewer"}',
      details: { role: "worker", kind: "tool", is_orchestrator: false },
    });

    const component = renderer(message, OPTIONS, theme);
    expect(component).toBeInstanceOf(Container);
    const [label, body] = component.children;
    expect(label).toBeInstanceOf(Text);
    expect(body).toBeInstanceOf(Markdown);

    const labelText = getInternalText(label as unknown as { text?: string });
    expect(labelText).toContain("worker");

    const bodyText = getInternalText(body as unknown as { text?: string });
    expect(bodyText).toContain("handoff:");
    expect(bodyText).toContain('{"target_role":"reviewer"}');
  });

  it("returns undefined on a forced throw (fail-safe to default CustomMessageComponent)", () => {
    // The SDK wraps the renderer call in try/catch itself
    // (Pinned #4); the renderer's own wrapper is
    // defense-in-depth. This test asserts the wrapper works
    // — a renderer that throws returns `undefined` and the
    // SDK's default `CustomMessageComponent` takes over.
    //
    // We force a throw by passing a message whose `details`
    // is a getter that throws. The renderer's narrow-on-`details`
    // access (`message.details` then `.role`) hits the
    // throwing getter and the wrapper catches it.
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => "orchestrator");
    const renderer = renderers["conduct.role.text"];

    const exploding = {
      customType: "conduct.role.text",
      content: "ignored",
      get details() {
        throw new Error("forced");
      },
    } as unknown as CustomMessage<ConductMessageDetails>;

    const result = renderer(exploding, OPTIONS, theme);
    expect(result).toBeUndefined();
  });

  it("renders safely when details is missing (defensive fallback)", () => {
    // The sink always stamps details, but the renderer
    // is defensive: an unstyled `CustomMessage` (no
    // details) still produces a Container with a muted
    // "(unknown)" label and the body Markdown. This keeps
    // the renderer crash-free on any future customType
    // reuse.
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => null);
    const renderer = renderers["conduct.role.text"];

    const message = {
      customType: "conduct.role.text",
      content: "body only",
    } as unknown as CustomMessage<ConductMessageDetails>;

    const component = renderer(message, OPTIONS, theme);
    expect(component).toBeInstanceOf(Container);
    const [label, body] = component.children;
    expect(label).toBeInstanceOf(Text);
    expect(body).toBeInstanceOf(Markdown);
    const labelText = getInternalText(label as unknown as { text?: string });
    expect(labelText).toContain("(unknown)");
    expect(labelText).toContain("[muted]");
  });
});
