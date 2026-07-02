/**
 * Conductor-owned `MessageRenderer`s for the two `conduct.role.*`
 * `CustomMessage` `customType`s — Phase 5.
 *
 * The default `CustomMessageComponent` flattens all streamed
 * `CustomMessage` body content to `customMessageText` (light gray)
 * via its `defaultTextStyle.color` override, which makes markdown
 * headings read as raw syntax and JSON arguments read as raw text
 * (see `the TUI bridge polish spec Diagnosis).
 *
 * This module registers a conductor-owned renderer for the
 * streamed `conduct.role.text` `customType` that takes over the
 * `CustomMessage` rendering for that type. The renderer:
 *
 *   - wraps the body in a `Container` with a structural role label
 *     (`Text`, **bolded** via `theme.bold` and colored by role
 *     family) on top and the body as a `Markdown` child underneath;
 *   - uses the SDK's `getMarkdownTheme()` directly with no
 *     `defaultTextStyle.color` override, so element-level theme
 *     functions (`theme.heading`, `theme.code`, `theme.codeBlock`,
 *     …) actually style the respective blocks. The body is the
 *     LLM's text verbatim (Phase 5.5 dropped the sink's `### role`
 *     prefix); any code fences the LLM emits are rendered as code
 *     blocks by the markdown theme's native handling.
 *   - returns `undefined` on any throw (defense-in-depth — the SDK
 *     already wraps the renderer call in try/catch and falls
 *     through to the default box, see
 *     `dist/modes/interactive/components/custom-message.js`).
 *
 * The `ConductMessageDetails` type is the seam contract the sink
 * (`src/extension/display-sink-wiring.ts`) writes and the renderer
 * reads. `is_orchestrator` is the only field the renderer branches
 * on for color; `role` drives the label text. `kind` is `"text"` or
 * `"tool"` (Phase 7B.UX restored the `"tool"` kind for tool-call and
 * tool-result display events). The sink computes `is_orchestrator`
 * from the active run's manifest (see `current-orchestrator.ts`).
 *
 * Phase 1 (open-issues-round-2): `"text_stream"` removed — text now
 * emits as a single `"text"` per assistant turn, so the label-less
 * continuation renderer is no longer needed.
 *
 * ## Why a local `CustomMessage` shape
 *
 * The SDK's `MessageRenderer<T = unknown>` expects `CustomMessage<T>`
 * as its first parameter, but the SDK does not re-export
 * `CustomMessage` from its package root (verified against
 * `dist/index.d.ts` 2026-06-20). The SDK's `exports` field blocks
 * the deep import path (`dist/core/messages.js`) in strict
 * NodeNext. We mirror the relevant shape locally so the renderer
 * is type-narrowed on `details` without a cast-from-`unknown`.
 * At registration time, the function is assigned to
 * `MessageRenderer<ConductMessageDetails>` via a structural cast
 * (the SDK's parameter type and the local shape have the same
 * fields, so the call site is type-safe in practice).
 *
 * ## Module size
 *
 * This file stays under the AGENTS.md ~400-LOC ceiling by
 * delegating the role-family color pick to a single helper and
 * keeping the renderer a thin closure over a shared container
 * builder. The renderer is pure (it reads `details` only via the
 * getter it was constructed with; the getter itself is the only
 * "live" reference), so the same renderer instance is safe to
 * register at extension factory time and reuse for the lifetime
 * of the process.
 */

import {
  getMarkdownTheme,
  type MessageRenderer,
  type MessageRenderOptions,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Text } from "@earendil-works/pi-tui";

/**
 * Kind discriminator the display sink stamps on every `CustomMessage`.
 * - `"text"` — LLM text (conduct.role.text)
 * - `"tool"` — tool call/result summary (conduct.role.tool)
 *
 * Phase 7B.UX restored the `"tool"` kind and the `conduct.role.tool`
 * customType. The sink folds both `tool_call` and `tool_result`
 * DisplayEvents into `kind: "tool"` — the formatter's content already
 * carries the `✓`/`✗` marker for end events, so the renderer does not
 * need a third discriminator.
 *
 * Phase 1 (open-issues-round-2): `"text_stream"` removed — text now
 * emits as a single `"text"` per assistant turn.
 */
export type ConductMessageKind = "text" | "tool";

/**
 * Shared `details` payload shape for the two `conduct.role.*`
 * `customType`s. The sink in `src/extension/display-sink-wiring.ts`
 * is the sole writer; this renderer is the sole reader. Keeping the
 * contract here (rather than at the call sites) makes the
 * sink↔renderer seam grep-able and the typing honest (no
 * cast-from-`unknown` in the renderer).
 *
 * `is_orchestrator` is a derived boolean the sink computes at
 * emission time against the active run's manifest. The renderer
 * never branches on the orchestrator *role name*; it just reads
 * this boolean for color. This keeps the renderer run-agnostic —
 * registering it at extension factory time and reusing it across
 * runs is safe.
 *
 * `kind` is `"text"` or `"tool"` (Phase 7B.UX restored the `"tool"`
 * kind for tool-call and tool-result display events). The renderer
 * does not currently branch on `kind` — the `conduct.role.tool`
 * renderer ignores it; the `conduct.role.text` renderer treats it
 * as text. Retained on the contract for grep-ability of the seam
 * shape.
 */
export interface ConductMessageDetails {
  readonly role: string;
  readonly kind: ConductMessageKind;
  readonly is_orchestrator: boolean;
}

/**
 * Local structural mirror of the SDK's `CustomMessage<T>` shape
 * (subset we use: `details`, `content`, `customType`). The SDK
 * does not re-export `CustomMessage` and blocks the deep-import
 * path via its `exports` field; see the file-level note.
 *
 * `content` is widened to `string | readonly { type: string }[]`
 * so the type is a structural *supertype* of the SDK's
 * `string | (TextContent | ImageContent)[]`. The renderer's
 * parameter is contravariant, so a wider local type is what
 * makes the function assignable to the SDK's
 * `MessageRenderer<ConductMessageDetails>` without a cast.
 */
interface ConductCustomMessage {
  readonly customType: string;
  readonly content: string | readonly { readonly type: string }[];
  readonly details?: ConductMessageDetails;
}

/** Role-label color for the orchestrator (mdHeading — yellow + bold in the default theme). */
const ORCHESTRATOR_LABEL_COLOR: ThemeColor = "mdHeading";
/** Role-label color for any non-orchestrator role (accent — the standard role emphasis). */
const WORKER_LABEL_COLOR: ThemeColor = "accent";
/** Fallback color when the orchestrator role is unknown (`null` — no active run). */
const UNKNOWN_LABEL_COLOR: ThemeColor = "muted";
/**
 * Role-label color for tool-call / tool-result messages (conduct.role.tool).
 * A muted secondary surface distinct from the orchestrator/worker/unknown
 * colors. Used by the tool renderer exclusively — NOT by `pickLabelColor`.
 */
const TOOL_LABEL_COLOR: ThemeColor = "dim";

/**
 * Pick the role-label color. The renderer is run-agnostic: the
 * orchestrator boolean is already on `details`, so this helper is
 * pure and testable in isolation.
 */
function pickLabelColor(is_orchestrator: boolean, orchestratorRole: string | null): ThemeColor {
  if (is_orchestrator) return ORCHESTRATOR_LABEL_COLOR;
  if (orchestratorRole === null) return UNKNOWN_LABEL_COLOR;
  return WORKER_LABEL_COLOR;
}

/**
 * Build the `Container` for one `CustomMessage`. Pure: takes the
 * theme (passed by the SDK), the message, and a getter for the
 * orchestrator role (kept as a getter so the renderer can be
 * registered at factory time without a stale closure). The
 * getter is a thin pass-through to `getCurrentOrchestratorRole`
 * in production and to whatever the test sets in unit tests.
 *
 * The container's children:
 *
 *   1. `Text` — the role label, **bolded** via `theme.bold` and
 *      colored by role family. The label text is `details.role`
 *      (e.g., "orchestrator", "worker").
 *   2. `Markdown` — the body, using the SDK's `getMarkdownTheme()`
 *      with no `defaultTextStyle.color` override. Element-level
 *      theme functions style the respective blocks. The body is
 *      the LLM's text verbatim (no `### role` prefix — Phase 5.5).
 *
 * No purple background box. The role label is the sole visual
 * anchor. The default renderer's `customMessageBg` is intentionally
 * not used here.
 */
function buildContainer(
  message: ConductCustomMessage,
  options: MessageRenderOptions,
  theme: Theme,
  getOrchestratorRole: () => string | null,
): Container {
  void options;

  const details = message.details;
  const labelColor =
    details === undefined
      ? UNKNOWN_LABEL_COLOR
      : pickLabelColor(details.is_orchestrator, getOrchestratorRole());
  const labelText = theme.fg(labelColor, theme.bold(details?.role ?? "(unknown)"));

  const body = message.content;
  const bodyText =
    typeof body === "string"
      ? body
      : body
          .filter(
            (part): part is { readonly type: string; readonly text: string } =>
              part.type === "text" && "text" in part,
          )
          .map((part) => part.text)
          .join("\n");

  const container = new Container();
  container.addChild(new Text(labelText, 0, 0));
  container.addChild(new Markdown(bodyText, 0, 0, getMarkdownTheme()));
  return container;
}

/** Wrap text in markdown blockquote syntax (`> `-prefixed lines). */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Build the `Container` for a `conduct.role.tool` message (Phase 7B.UX).
 * Compact one-line layout: a role label colored with `TOOL_LABEL_COLOR`
 * (NOT `pickLabelColor`) and the body as a `Markdown` child
 * (blockquote-wrapped for visual de-emphasis; M1 amended).
 *
 * The tool renderer does NOT use `pickLabelColor`, `ORCHESTRATOR_LABEL_COLOR`,
 * `WORKER_LABEL_COLOR`, or `UNKNOWN_LABEL_COLOR` — the tool label is always
 * colored with `TOOL_LABEL_COLOR` regardless of orchestrator status (M2).
 */
function buildToolContainer(
  message: ConductCustomMessage,
  options: MessageRenderOptions,
  theme: Theme,
): Container {
  void options;

  const details = message.details;
  const labelText = theme.fg(TOOL_LABEL_COLOR, details?.role ?? "(unknown)");

  const body = message.content;
  const bodyText =
    typeof body === "string"
      ? body
      : body
          .filter(
            (part): part is { readonly type: string; readonly text: string } =>
              part.type === "text" && "text" in part,
          )
          .map((part) => part.text)
          .join("\n");

  const container = new Container();
  container.addChild(new Text(labelText, 0, 0));
  container.addChild(new Markdown(blockquote(bodyText), 0, 0, getMarkdownTheme()));
  return container;
}

/**
 * Build the `conduct.role.text` renderer.
 */
function createRenderer(
  getOrchestratorRole: () => string | null,
): MessageRenderer<ConductMessageDetails> {
  return (message, options, theme) => {
    try {
      return buildContainer(message, options, theme, getOrchestratorRole);
    } catch {
      return undefined;
    }
  };
}

/**
 * Build the `conduct.role.tool` renderer.
 */
function createToolRenderer(): MessageRenderer<ConductMessageDetails> {
  return (message, options, theme) => {
    try {
      return buildToolContainer(message, options, theme);
    } catch {
      return undefined;
    }
  };
}

/**
 * Build the conductor-owned renderer, keyed by its `customType`.
 * The factory's caller (`extensions/conduct.ts`) iterates the
 * record and registers each with `pi.registerMessageRenderer`.
 *
 * Phase 7B.UX restored the `conduct.role.tool` key — the sink now
 * emits tool_call / tool_result events as `conduct.role.tool` with
 * compact formatter summaries.
 *
 * Phase 1 (open-issues-round-2): `conduct.role.text_stream` key
 * removed — text now emits as a single `conduct.role.text` per
 * assistant turn.
 *
 * @param getOrchestratorRole - Live reference to the active run's
 *                              orchestrator role (or `null` when no
 *                              run is live). The default reads from
 *                              `getCurrentOrchestratorRole` in
 *                              `current-orchestrator.ts`; tests pass
 *                              a stub.
 */
export function createConductMessageRenderers(
  getOrchestratorRole: () => string | null = () => null,
): Record<string, MessageRenderer<ConductMessageDetails>> {
  const textRenderer = createRenderer(getOrchestratorRole);
  const toolRenderer = createToolRenderer();
  return {
    "conduct.role.text": textRenderer,
    "conduct.role.tool": toolRenderer,
  };
}

/** Re-export the local `Component` type so callers (e.g. tests) can type their assertions. */
export type { Component };
