# Spec: Tool-Call UX Refinement — Error Truncation + Quote-Block Wrapping

## Revision summary

Initial spec. Amends two sections of the existing
[`docs/tool-observability-and-spinner-spec.md`](./tool-observability-and-spinner-spec.md)
(§1 error extraction and §4/M1 body component). Does **not** touch the base
spec (`docs/orchestrator-fsm-spec.md`) — this is a display-layer refinement
scoped entirely under Phase 7B (the UX shell).

---

## What I found (investigation notes — basis for the plan)

### Issue 1 — "Wall of JSON" on failed tool calls

**Root cause confirmed.** `formatToolResultSummary` in
`src/host/tool-summary.ts` (lines ~155–175) handles the error path as follows:

```ts
const raw: string =
  typeof result === "string"
    ? result
    : (() => {
        const json = JSON.stringify(result);
        return json !== undefined ? json : String(result);
      })();
const newlineIdx = raw.indexOf("\n");
const firstLine = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx);
return `✗ ${firstLine}`;
```

When `result` is an object (common for failed tool calls — the SDK's
`ToolExecutionEndEvent.result` is typed `any`), `JSON.stringify` produces a
**single-line** string with no `\n` characters. The `newlineIdx` is `-1`, so
`firstLine` = the **entire** JSON string. There is **no length cap** on the
error line. A large error object (e.g., a bash failure returning `{ stdout,
stderr, exitCode, ... }` or a structured error with a deep stack) renders as a
wall of JSON on one line after the `✗` marker.

Even for string results, a very long single-line error message has no
truncation — it floods the TUI row.

**What already works:** The `✗` marker IS shown (the formatter runs, the cross
mark appears). The success path (`!isError → '✓'`) is unaffected. The
first-line extraction works correctly for multi-line string results. Only the
object-result and long-single-line cases are broken.

### Issue 2 — Quote-block wrapping for tool calls

**Current rendering.** The `conduct.role.tool` renderer
(`buildToolContainer` in `src/extension/conduct-message-renderer.ts`) builds a
`Container` with two `Text` children:
1. `Text` — role label, colored with `TOOL_LABEL_COLOR` (`"dim"`)
2. `Text` — body: the formatter-produced summary or `✓`/`✗` indicator

The body is `Text` (not `Markdown`) per decision M1 in the prior spec. `Text`
renders raw characters — no markdown parsing. To render a markdown blockquote
(`> `-prefixed content), the body must be a `Markdown` component using
`getMarkdownTheme()`, which is the same theme the `conduct.role.text` renderer
already uses for its body. The markdown theme has a native `blockquote` styling
function that renders `> `-prefixed lines as indented, visually de-emphasized
blocks.

**What already works:** The role label, `TOOL_LABEL_COLOR`, the `Container`
structure, and the defense-in-depth try/catch are all correct and stay
unchanged. Only the body component type and content wrapping change.

### Files responsible

| File | Role | Change type |
|------|------|-------------|
| `src/host/tool-summary.ts` | Pure formatter — error extraction + truncation | MODIFY (error path only) |
| `src/extension/conduct-message-renderer.ts` | Tool renderer — body component + quote wrapping | MODIFY (`buildToolContainer` only) |
| `tests/host/tool-summary.test.ts` | Formatter unit tests | MODIFY (add error-extraction + truncation cases) |
| `tests/host/display-forwarding.test.ts` | Host→display integration test | VERIFY (existing error-path case may need assertion update) |
| `tests/extension/conduct-tool-renderer.test.ts` | Renderer unit tests | MODIFY (flip M1 `Text`→`Markdown`; update body content assertions for `> ` prefix) |

### Spec cross-reference

- **`docs/tool-observability-and-spinner-spec.md` §1** — declares
  `formatToolResultSummary` error path as `✗ <first line>` with coercion via
  `JSON.stringify`. **Amended:** add human-readable error-field extraction
  before stringify fallback, and add a max-length truncation on the first
  line.
- **`docs/tool-observability-and-spinner-spec.md` §4 / Decision M1** —
  declares tool renderer body is `Text`, not `Markdown`. **Amended:** body is
  now `Markdown` with blockquote-wrapped content, so `> `-prefixed lines
  render as markdown blockquotes.
- **`docs/orchestrator-fsm-spec.md`** — **not touched.** No FSM/reducer/
  persistence/`def` semantics change. This is a display-layer feature.

---

## Goal

Refine the tool-call UX rendering with two targeted fixes:

1. **Error display:** When a tool call fails, surface a concise human-readable
   error message — not a wall of raw JSON. Extract the error message from
   known shapes (`message`, `error`, `stderr`); truncate any first line to a
   readable max length.
2. **Quote-block wrapping:** Wrap tool-call body text in markdown blockquote
   delimiters (`> `) so tool activity is visually de-emphasized relative to
   the agent's actual response prose.

### Success criteria

1. When a tool call fails with an object result containing a `message`,
   `error`, or `stderr` field, the `✗` line shows that field's value (not the
   full JSON).
2. When a tool call fails with an object result that has no recognizable error
   field, the `✗` line shows a **truncated** JSON string (not the full
   object).
3. When a tool call fails with a very long single-line string result, the `✗`
   line is **truncated** to the max length with an ellipsis.
4. Tool-call and tool-result lines render inside markdown blockquotes (`> `
   prefixed) in the TUI, visually de-emphasized relative to agent prose.
5. All existing behavior that already meets spec is preserved: truncation of
   long bash commands, `✓`/`✗` indicators, spinner, machine-tool suppression,
   role-label coloring.

## Non-goals

- **Expandable error details.** v1 truncates; a future enhancement could add
  an expand/collapse affordance for the full error payload. Not in scope.
- **Changing the formatter's success path.** `✓` on success is correct and
  stays as-is.
- **Changing the role label.** The `TOOL_LABEL_COLOR` (`"dim"`) label stays
  as a `Text` component above the blockquoted body.
- **Changing the spinner, status line, or machine-tool suppression.** Those
  are working and untouched.

---

## Module/seam breakdown

### 1. `src/host/tool-summary.ts` — error extraction + truncation (MODIFY)

**Amends prior spec §1 error path.**

Add a named constant for the max error line length:

```ts
/** Maximum length of the error first-line rendered after `✗`.
 *  Lines exceeding this are tail-truncated with `…` (U+2026),
 *  following the same pattern as MAX_BASH_COMMAND_DISPLAY_LENGTH. */
export const MAX_ERROR_LINE_DISPLAY_LENGTH = 120;
```

Add an `extractErrorMessage` helper that tries human-readable error fields
before falling back to stringify:

```ts
/** Extract a human-readable error message from a tool result.
 *  Tries common error fields (`message`, `error`, nested
 *  `error.message`/`error.error`, `stderr`) before falling
 *  back to JSON.stringify → String() coercion. */
function extractErrorMessage(result: unknown): string {
  if (typeof result === "string") return result;
  if (isObject(result)) {
    const msg = safeString(result, "message") ?? safeString(result, "error");
    if (msg !== undefined) return msg;
    const nested = result["error"];
    if (isObject(nested)) {
      const nestedMsg = safeString(nested, "message") ?? safeString(nested, "error");
      if (nestedMsg !== undefined) return nestedMsg;
    }
    const stderr = safeString(result, "stderr");
    if (stderr !== undefined) return stderr;
  }
  const json = JSON.stringify(result);
  return json !== undefined ? json : String(result);
}
```

Add a `truncateLine` helper (same ellipsis pattern as bash truncation):

```ts
/** Tail-truncate a line to `max` chars with `…` (U+2026). */
function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}
```

Update `formatToolResultSummary` error path:

```ts
if (!isError) return "✓";

const raw = extractErrorMessage(result);
const newlineIdx = raw.indexOf("\n");
const firstLine = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx);
const truncated = truncateLine(firstLine, MAX_ERROR_LINE_DISPLAY_LENGTH);
return `✗ ${truncated}`;
```

The success path, machine-tool suppression, and unknown-tool suppression are
**unchanged**.

### 2. `src/extension/conduct-message-renderer.ts` — blockquote wrapping (MODIFY)

**Amends prior spec §4 / Decision M1.**

In `buildToolContainer`:
- Add a local `blockquote` helper (prefix each line with `> `):
  ```ts
  function blockquote(text: string): string {
    return text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  ```
  (This mirrors the existing `blockquote` in `src/host/display-sink.ts`; kept
  local to the renderer to avoid cross-layer coupling for a 3-line helper.)
- **Switch the body child from `Text` to `Markdown`** with
  `getMarkdownTheme()`, passing `blockquote(bodyText)` as the markdown content.
  This renders the tool summary/indicator as a markdown blockquote —
  indented and visually de-emphasized relative to agent prose.

The label child stays as `Text` with `TOOL_LABEL_COLOR`. The defense-in-depth
try/catch stays. `createToolRenderer` is unchanged except for the body
construction inside `buildToolContainer`.

**M1 amendment:** the tool renderer body is now `Markdown` (blockquote-wrapped),
not `Text`. The prior M1 rationale ("single-line summary, not markdown") no
longer holds — the content IS markdown (blockquote syntax) by design, to
achieve the visual de-emphasis the user requested.

### 3. `src/extension/display-sink-wiring.ts` — NO CHANGE

The sink already emits tool events as `conduct.role.tool` with the
formatter-produced text as `content`. The blockquote wrapping happens at the
renderer level, not the sink level — the sink stays unchanged.

---

## Invariant cross-check (against AGENTS.md §"Non-negotiable invariants")

| # | Invariant | Touched? | How preserved |
|---|-----------|----------|---------------|
| 1 | Host-agnostic core | **No** | `tool-summary.ts` in `src/host/` (not guarded); zero pi imports. `conduct-message-renderer.ts` in `src/extension/` (not guarded). |
| 2 | Reducer purity | **No** | No `reduce`/`reduceLifecycle` change. |
| 3 | Pinned `def` snapshot | **No** | No `MachineDefinition` change. |
| 4 | Every state change via `reduce` | **No** | Display tap is not a state change. |
| 5 | Snapshot-appended checkpoint | **No** | No persistence change. |
| 6 | Single owner for reduce+persistence+spawning | **No** | No tool/handoff/end change. |
| 7 | `meta.role === current_role` assertion | **No** | No reducer/meta change. |
| 8 | `payload` is `unknown` at reducer | **No** | No reducer/payload change. |
| 9 | One TypeBox schema | **No** | No schema change. |
| 10 | No `ctx.newSession`/`ctx.fork` in `extensions/` | **No** | No extension spawning change. |

**Verdict: no invariant tension.** Pure display-layer refinement.

---

## Decisions

### D1 — Error extraction order: known fields → stringify fallback

Before falling back to `JSON.stringify`, try `result.message`, `result.error`,
`result.error.message`, `result.error.error`, and `result.stderr` (in that
order). This covers the common error shapes from pi's built-in tools (bash
failures carry `stderr`; structured errors carry `message` or `error`). If
none match, stringify + truncate — the wall-of-JSON scenario is mitigated by
the max-length cap even in the fallback case.

### D2 — Max error line length: 120 chars

`MAX_ERROR_LINE_DISPLAY_LENGTH = 120`. This is long enough to show a typical
error message ("command not found: foo", "permission denied: /path/to/file")
but short enough to prevent TUI flooding. Follows the same ellipsis truncation
pattern as `MAX_BASH_COMMAND_DISPLAY_LENGTH` (slice to `max - 1` + `…`).

### D3 — Quote-block wrapping at the renderer level, not the formatter

The formatter (`tool-summary.ts`) stays pure — it produces `bash: ls`, `✓`,
`✗ error msg`. The renderer (`conduct-message-renderer.ts`) wraps the content
in `> `-prefixed markdown before passing to `Markdown`. This keeps data
formatting and presentation separated. The formatter's existing tests stay
green (no `> ` prefix in their expected output).

### D4 — Body switches from `Text` to `Markdown` (M1 amendment)

The prior M1 decision ("body is `Text`, not `Markdown`") is amended: the body
is now `Markdown` with blockquote-wrapped content. The `Markdown` component
uses `getMarkdownTheme()` (same as the text renderer), so blockquotes render
with the theme's native `blockquote` styling. The role label stays as `Text`.

---

## Open questions for the overseer

1. **`MAX_ERROR_LINE_DISPLAY_LENGTH` value (D2).** 120 chars is proposed. If
   the overseer prefers a different cap (e.g., 80 for stricter TUI
   discipline, or 200 for more diagnostic detail), direct the change. Does
   not block implementation — the constant is exported and trivially
   adjustable.
2. **M1 amendment confirmation (D4).** The prior spec explicitly decided
   `Text` not `Markdown` for the tool body. This amendment reverses that for
   the blockquote feature. **Confirm the M1 reversal is acceptable**, or
   direct an alternative (e.g., keeping `Text` with a literal `> ` prefix,
   which would show `>` characters but not render as a styled blockquote).
   Does not block implementation — the plan proceeds with the `Markdown`
   approach.
