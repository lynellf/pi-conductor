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

import type { MessageRenderOptions, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
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
    bg: (color: ThemeColor, text: string) => tag(`bg:${color}`, text),
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
 * renderer reads). Phase 5.5 narrowed the sink to `text` events
 * only, so the only `customType` the renderer is registered for
 * is `conduct.role.text`.
 */
function makeMessage(args: {
  readonly customType: "conduct.role.text";
  readonly content: string;
  readonly details: ConductMessageDetails;
}): never {
  // Cast to `never`: the SDK does not re-export `CustomMessage`, so we
  // can't name the renderer's exact parameter type. The local
  // `CustomMessage<T>` shape is structurally equivalent but
  // `exactOptionalPropertyTypes` rejects the cross-package assignment;
  // `never` is assignable to the SDK's parameter type without a breach.
  return {
    customType: args.customType,
    content: args.content,
    details: args.details,
  } as unknown as never;
}

/** Get the `conduct.role.text` renderer with a runtime guard (no non-null assertion). */
function textRenderer(renderers: ReturnType<typeof createConductMessageRenderers>) {
  const r = renderers["conduct.role.text"];
  if (r === undefined) throw new Error("conduct.role.text renderer not registered");
  return r;
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
  it("returns renderers for conduct.role.text, conduct.role.text_stream, and conduct.role.tool", () => {
    const renderers = createConductMessageRenderers();
    // Phase 7B.UX restored the `conduct.role.tool` customType for
    // tool-call and tool-result display events.
    // tui-stream-readability Phase 1 added conduct.role.text_stream
    // for label-less stream continuation chunks.
    expect(Object.keys(renderers).sort()).toEqual([
      "conduct.role.text",
      "conduct.role.text_stream",
      "conduct.role.tool",
    ]);
    expect(typeof renderers["conduct.role.text"]).toBe("function");
    expect(typeof renderers["conduct.role.text_stream"]).toBe("function");
    expect(typeof renderers["conduct.role.tool"]).toBe("function");
  });

  it("renders a conduct.role.text message as a Container with a bold role-label Text + a Markdown body carrying the LLM text verbatim", () => {
    const theme = makeStubTheme();
    // Pass a getter that returns the orchestrator role so the
    // worker label gets the worker color (accent); with a null
    // orchestrator role the renderer falls back to muted for
    // everyone (separate test below).
    const renderers = createConductMessageRenderers(() => "orchestrator");
    const renderer = textRenderer(renderers);

    const message = makeMessage({
      customType: "conduct.role.text",
      // Phase 5.5: the sink emits the LLM's text verbatim — no
      // `### role` prefix. The renderer's structural role label
      // is the only place the role name appears.
      content: "hello world",
      details: { role: "worker", kind: "text", is_orchestrator: false },
    });

    const component = renderer(message, OPTIONS, theme);
    expect(component).toBeInstanceOf(Container);

    const container = component as Container;
    expect(container.children).toHaveLength(2);

    const [label, body] = container.children;
    expect(label).toBeInstanceOf(Text);
    expect(body).toBeInstanceOf(Markdown);

    // The label text is `details.role` wrapped by `theme.bold`
    // and then colored by `theme.fg`. The stub theme prefixes
    // each wrap with its tag (`[bold]`, then `[accent]`), so we
    // can assert the bold wrap, the color, and the role text in
    // one string match.
    const labelText = getInternalText(label as unknown as { text?: string });
    expect(labelText).toContain("worker");
    expect(labelText).toContain("[accent]"); // worker color
    expect(labelText).toContain("[bold]"); // Phase 5.5: label is bolded

    // The Markdown body carries the LLM's text verbatim — no
    // `### worker` prefix, no JSON, no brackets.
    const bodyText = getInternalText(body as unknown as { text?: string });
    expect(bodyText).toBe("hello world");
  });

  it("colors the orchestrator role label with mdHeading and bolds it", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => "orchestrator");
    const renderer = textRenderer(renderers);

    const message = makeMessage({
      customType: "conduct.role.text",
      content: "I am planning",
      details: { role: "orchestrator", kind: "text", is_orchestrator: true },
    });

    const component = renderer(message, OPTIONS, theme);
    const container = component as Container;
    const [label] = container.children;
    const labelText = getInternalText(label as unknown as { text?: string });
    expect(labelText).toContain("orchestrator");
    expect(labelText).toContain("[mdHeading]"); // orchestrator color
    expect(labelText).toContain("[bold]"); // Phase 5.5: label is bolded
  });

  it("uses the muted fallback color (and still bolds the label) when no orchestrator role is known (no active run)", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => null);
    const renderer = textRenderer(renderers);

    const message = makeMessage({
      customType: "conduct.role.text",
      content: "stranded",
      details: { role: "worker", kind: "text", is_orchestrator: false },
    });

    const component = renderer(message, OPTIONS, theme);
    const [label] = (component as Container).children;
    const labelText = getInternalText(label as unknown as { text?: string });
    expect(labelText).toContain("[muted]"); // unknown fallback
    expect(labelText).toContain("[bold]"); // Phase 5.5: label is bolded
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
    const renderer = textRenderer(renderers);

    const exploding = {
      customType: "conduct.role.text",
      content: "ignored",
      get details() {
        throw new Error("forced");
      },
    } as unknown as never;

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
    const renderer = textRenderer(renderers);

    const message = {
      customType: "conduct.role.text",
      content: "body only",
    } as unknown as never;

    const component = renderer(message, OPTIONS, theme);
    expect(component).toBeInstanceOf(Container);
    const [label, body] = (component as Container).children;
    expect(label).toBeInstanceOf(Text);
    expect(body).toBeInstanceOf(Markdown);
    const labelText = getInternalText(label as unknown as { text?: string });
    expect(labelText).toContain("(unknown)");
    expect(labelText).toContain("[muted]");
    expect(labelText).toContain("[bold]"); // Phase 5.5: label is bolded even in the fallback
  });

  // ─── text_stream renderer ───────────────────────────────────

  it("renders a conduct.role.text_stream message as a Container with a single Markdown body (no role label)", () => {
    // N12: the text_stream renderer is label-less by design.
    // The Container carries only a Markdown child — no Text
    // role-label component.
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => "orchestrator");
    const renderer = textStreamRenderer(renderers);

    const message = makeMessage({
      customType: "conduct.role.text",
      content: "continuation text for the stream",
      details: { role: "worker", kind: "text_stream", is_orchestrator: false },
    });

    const component = renderer(message, OPTIONS, theme);
    expect(component).toBeInstanceOf(Container);

    const container = component as Container;
    // The container should have exactly one child: the Markdown body
    expect(container.children).toHaveLength(1);
    const [body] = container.children;
    expect(body).toBeInstanceOf(Markdown);
    // There should be NO Text child (no role label)
    expect(body instanceof Text).toBe(false);

    const bodyText = getInternalText(body as unknown as { text?: string });
    expect(bodyText).toBe("continuation text for the stream");
  });

  it("text_stream renderer ignores is_orchestrator (N12)", () => {
    // The label-less renderer does NOT use the is_orchestrator
    // flag. The same Container structure is returned regardless
    // of the orchestrator status.
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers(() => "orchestrator");
    const renderer = textStreamRenderer(renderers);

    // Message with is_orchestrator=true (orchestrator role)
    const message = makeMessage({
      customType: "conduct.role.text",
      content: "orchestrator continuation",
      details: { role: "orchestrator", kind: "text_stream", is_orchestrator: true },
    });

    const component = renderer(message, OPTIONS, theme) as Container;
    // No Text child — the is_orchestrator flag is never read
    expect(component.children).toHaveLength(1);
    expect(component.children[0]).toBeInstanceOf(Markdown);
  });

  it("text_stream renderer returns undefined on a forced throw", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers();
    const renderer = textStreamRenderer(renderers);

    // The text_stream renderer reads message.content directly (not
    // details), so we make content throw to trigger the catch.
    const exploding = {
      customType: "conduct.role.text",
      get content() {
        throw new Error("forced");
      },
    } as unknown as never;

    const result = renderer(exploding, OPTIONS, theme);
    expect(result).toBeUndefined();
  });

  it("text_stream renderer returns Container with Markdown even when details is missing", () => {
    const theme = makeStubTheme();
    const renderers = createConductMessageRenderers();
    const renderer = textStreamRenderer(renderers);

    const message = {
      customType: "conduct.role.text",
      content: "fallback body",
    } as unknown as never;

    const component = renderer(message, OPTIONS, theme);
    expect(component).toBeInstanceOf(Container);
    const container = component as Container;
    expect(container.children).toHaveLength(1);
    expect(container.children[0]).toBeInstanceOf(Markdown);
    const bodyText = getInternalText(container.children[0] as unknown as { text?: string });
    expect(bodyText).toBe("fallback body");
  });
});

/** Get the `conduct.role.text_stream` renderer with a runtime guard. */
function textStreamRenderer(renderers: ReturnType<typeof createConductMessageRenderers>) {
  const r = renderers["conduct.role.text_stream"];
  if (r === undefined) throw new Error("conduct.role.text_stream renderer not registered");
  return r;
}
