# Phase 7B.UX-R — Tool-Call UX Refinement: Error Truncation + Quote-Block Wrapping

**Plan artifact** for implementing
[`docs/tool-ux-refinement-spec.md`](../tool-ux-refinement-spec.md).

**Spec sections implemented by this phase:** §1 (`tool-summary.ts` error
extraction + truncation), §2 (`conduct-message-renderer.ts` blockquote
wrapping), Decisions D1/D2/D3/D4.

**Authority spec cross-reference:** this work **amends** two sections of
`docs/tool-observability-and-spinner-spec.md` (§1 error path, §4/M1 body
component). It does **not** touch `docs/orchestrator-fsm-spec.md`. No
FSM/reducer/persistence/`def` semantics change.

**Revision summary (visit 2 — plan-reviewer-b findings):** This revision
addresses three findings from `plan-reviewer-b`'s first-pass review:

- **[BLOCKING] R.2 spec-amendment step added.** The M1 design pin in
  `docs/tool-observability-and-spinner-spec.md` §4 (body is `Text`, not
  `Markdown`) is reversed by this plan's R.2 (body becomes `Markdown` with
  blockquote wrapping). In a spec-driven repo, the spec must be amended in
  lockstep with the code. R.2 now includes an explicit sub-step for the
  implementer to amend §4 and task 7B.UX.4 in the spec alongside the code
  change. The spec file is added to the Files-touched summary table (action:
  MODIFY; task: R.2). R.2 verification now includes a manual spec-consistency
  read-through. **Decision: the implementer performs the spec edit in R.2**
  (not the planner in this visit) — the spec amendment and code change are
  tightly coupled, and the implementer is already touching the renderer and
  tests in the same change.
- **[NIT] 5 line references corrected** to match actual file content:
  `conduct-tool-renderer.test.ts` "renders a tool_call summary" (~107 →
  ~88), "renders a tool_result ✓" (~125 → ~110), "renders a tool_result ✗"
  (~143 → ~128), "renders safely when details is missing" (~176 → ~163);
  `tool-summary.test.ts` object-error case (~117 → ~178).
- **[NIT] R.2 "renders a tool_call summary" description clarified** — the
  current test asserts only `body instanceof Text` (no `bodyText` assertion).
  The substantive change is flipping the body-type assertion to `body
  instanceof Markdown`; the additional `bodyText` assertion (`"> bash: ls"`)
  is optional.

---

## What I found (investigation notes — basis for the plan)

1. **Wall of JSON root cause confirmed.** `formatToolResultSummary` in
   `src/host/tool-summary.ts` stringifies object results via `JSON.stringify`
   (single-line, no `\n`), then takes "first line" via `indexOf("\n")`. Since
   `JSON.stringify` output has no newlines, `firstLine` = the entire JSON
   string. No length cap exists. A failed tool call with a large object result
   floods the TUI row with raw JSON after the `✗` marker.
2. **Quote-block wrapping requires `Markdown` body.** The current
   `buildToolContainer` uses `Text` for the body (prior decision M1). `Text`
   renders raw characters — `> ` prefixes would show as literal `>` chars, not
   styled blockquotes. Switching to `Markdown` with `getMarkdownTheme()` and
   `> `-prefixed content renders proper markdown blockquotes (indented,
   visually de-emphasized).
3. **The `blockquote` helper pattern already exists** in
   `src/host/display-sink.ts` (private, used for thinking blocks). The
   renderer will have its own local copy (3 lines) to avoid cross-layer
   coupling.
4. **Existing tests that must flip:**
   - `tests/extension/conduct-tool-renderer.test.ts` M1 test (line ~184):
     asserts body is `Text` not `Markdown` → must flip to `Markdown` not
     `Text`.
   - `tests/extension/conduct-tool-renderer.test.ts` body-content assertions
     (lines ~88, ~110, ~128): currently assert only `body instanceof Text`
     (no `bodyText` assertion on the tool_call case) → must flip to `body
     instanceof Markdown`; optionally add `bodyText` assertions asserting
     `"> bash: ls"`, `"> ✓"`, `"> ✗ permission denied"` (blockquote-prefixed).
   - `tests/host/tool-summary.test.ts` object-error case (line ~178):
     currently asserts only `toMatch(/^✗ /)` → should assert the extracted
     `message` field value. New cases needed for `error`, `stderr`, nested
     `error.message`, and truncation.
5. **No invariant tension.** All changes are in `src/host/` (pure formatter)
   and `src/extension/` (renderer). No core/seam/cost/persistence touch. No
   new pi imports. Grep-guard stays green.

---

## Assumptions

1. The SDK's `getMarkdownTheme()` includes a `blockquote` styling function
   that renders `> `-prefixed lines as indented blocks (standard markdown
   behavior — the same theme the text renderer uses for agent prose).
2. `MAX_ERROR_LINE_DISPLAY_LENGTH = 120` is acceptable (D2). The constant is
   exported and trivially adjustable if the overseer prefers a different cap.
3. The M1 amendment (body `Text` → `Markdown`) is acceptable (D4). The plan
   proceeds with the `Markdown` approach; if the overseer rejects it, the
   fallback is `Text` with a literal `> ` prefix (no styled blockquote).

---

## Phase decomposition

**Single phase**, three ordered tasks. The formatter fix (Task R.1) is pure
and testable in isolation; the renderer change (Task R.2) depends on no
formatter change but is in a different layer; Task R.3 is the full gate.
Tasks gate each other: **R.1** (formatter) → **R.2** (renderer) → **R.3**
(full gate). Do not start a task until the prior task's verification is green.

---

## Task R.1 — Error extraction + truncation in `tool-summary.ts`

**Spec sections:** §1, Decisions D1/D2.
**Files:** `src/host/tool-summary.ts` (MODIFY), `tests/host/tool-summary.test.ts` (MODIFY),
`tests/host/display-forwarding.test.ts` (MODIFY — tighten object-error assertion).

- [x] In `src/host/tool-summary.ts`:
      - Add `export const MAX_ERROR_LINE_DISPLAY_LENGTH = 120;` with JSDoc
        (same pattern as `MAX_BASH_COMMAND_DISPLAY_LENGTH` — tail-truncate
        with `…` when `line.length > MAX`).
      - Add private `extractErrorMessage(result: unknown): string` helper:
        1. `typeof result === "string"` → return directly.
        2. `isObject(result)` → try `safeString(result, "message")` ??
           `safeString(result, "error")`; if found, return it.
        3. Try nested: `result["error"]` is object →
           `safeString(nested, "message") ?? safeString(nested, "error")`;
           if found, return it.
        4. Try `safeString(result, "stderr")`; if found, return it.
        5. Fallback: `JSON.stringify(result)` ?? `String(result)`.
      - Add private `truncateLine(line: string, max: number): string` helper:
        `line.length <= max` → return as-is; else `line.slice(0, max - 1) + "…"`.
      - Update `formatToolResultSummary` error path: replace the inline
        coercion + first-line extraction with:
        ```ts
        const raw = extractErrorMessage(result);
        const newlineIdx = raw.indexOf("\n");
        const firstLine = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx);
        const truncated = truncateLine(firstLine, MAX_ERROR_LINE_DISPLAY_LENGTH);
        return `✗ ${truncated}`;
        ```
      - The success path (`!isError → '✓'`), machine-tool suppression, and
        unknown-tool suppression are **unchanged**.
      - Update the `formatToolResultSummary` JSDoc to document the extraction
        order (D1) and the max-length truncation (D2).
- [x] In `tests/host/tool-summary.test.ts`:
      - **Update the existing object-error case** (line ~178): change from
        `toMatch(/^✗ /)` to assert the extracted `message` field:
        ```ts
        const result = { message: "command failed", code: 127 };
        expect(formatToolResultSummary("bash", result, true)).toBe("✗ command failed");
        ```
      - **Add: object with `error` string field** → `✗ <error value>`.
      - **Add: object with nested `error.message`** → `✗ <nested message>`.
      - **Add: object with `stderr` field (no `message`/`error`)** →
        `✗ <stderr value>`.
      - **Add: object with no recognizable error field** → `✗ <truncated
        JSON>` — assert the output starts with `✗ {` and is ≤
        `MAX_ERROR_LINE_DISPLAY_LENGTH + 2` chars (`✗ ` prefix + truncated
        line).
      - **Add: long single-line string error (> 120 chars)** → truncated with
        `…`. Assert `✗ ` + `line.slice(0, 119) + "…"`.
      - **Add: long multi-line string error** → first line is truncated if
        > 120 chars; second line is ignored (first-line extraction still
        applies before truncation).
      - **Add: boundary case** — error string of exactly 120 chars → no
        truncation (verbatim). Error string of 121 chars → truncated.
      - The existing success, machine-tool, and unknown-tool cases stay
        **unchanged**.
- [x] In `tests/host/display-forwarding.test.ts` (line ~261, "forwards
      tool_error with an object result coerced to ✗ <first line>"):
      - The fixture uses `result: { message: "command not found", code: 127 }`
        with `expect.stringMatching(/^✗ /)`. With the new extraction,
        `extractErrorMessage` finds `result.message` → output is
        `✗ command not found`. **Tighten the assertion** from
        `expect.stringMatching(/^✗ /)` to `"✗ command not found"` to verify
        the extraction works end-to-end through the host wiring.
- [x] **Acceptance:** `pnpm typecheck` clean;
      `pnpm test tests/host/tool-summary.test.ts` green;
      `pnpm test tests/host/display-forwarding.test.ts` green.
- [x] **Verify:**
      `pnpm typecheck && pnpm test tests/host/tool-summary.test.ts tests/host/display-forwarding.test.ts`
- [x] **LOC guard:** `tool-summary.ts` is currently ~175 LOC; adding ~25 LOC
      for the two helpers + constant keeps it well under ~400.

---

## Task R.2 — Blockquote wrapping in `conduct-message-renderer.ts`

**Spec sections:** §2, Decisions D3/D4 (M1 amendment).
**Files:** `src/extension/conduct-message-renderer.ts` (MODIFY),
`tests/extension/conduct-tool-renderer.test.ts` (MODIFY).

- [x] In `src/extension/conduct-message-renderer.ts` (`buildToolContainer`):
      - Add a private `blockquote(text: string): string` helper:
        ```ts
        function blockquote(text: string): string {
          return text.split("\n").map((line) => `> ${line}`).join("\n");
        }
        ```
      - **Switch the body child from `Text` to `Markdown`:** replace
        `container.addChild(new Text(bodyText, 0, 0))` with
        `container.addChild(new Markdown(blockquote(bodyText), 0, 0, getMarkdownTheme()))`.
        The `getMarkdownTheme` import is already present (used by the text
        renderer's `buildContainer`).
      - The label child (`Text` with `TOOL_LABEL_COLOR`) is **unchanged**.
      - The defense-in-depth try/catch in `createToolRenderer` is
        **unchanged**.
      - Update the `buildToolContainer` JSDoc and the M1-related comments to
        reflect the amendment: body is now `Markdown` (blockquote-wrapped),
        not `Text`.
- [x] In `tests/extension/conduct-tool-renderer.test.ts`:
      - **Flip the M1 test** (line ~184, "M1: body child is a Text component,
        not Markdown"):
        - Rename to "M1 (amended): body child is a Markdown component
          (blockquote-wrapped), not Text".
        - Assert the tool renderer's body is `instanceof Markdown` and NOT
          `instanceof Text`.
        - Assert the text renderer's body is still `instanceof Markdown`
          (unchanged).
      - **Flip body-type assertions** for the blockquote change:
        - "renders a tool_call summary" (line ~88): the current test asserts
          only `body instanceof Text` (no `bodyText` assertion). The
          substantive change is flipping `expect(body).toBeInstanceOf(Text)`
          to `expect(body).toBeInstanceOf(Markdown)`. Optionally, add a
          `bodyText` assertion: `expect(bodyText).toBe("> bash: ls")`.
        - "renders a tool_result ✓ indicator" (line ~110): flip
          `body instanceof Text` → `body instanceof Markdown`. Optionally,
          add `expect(bodyText).toBe("> ✓")`.
        - "renders a tool_result ✗ <first line> indicator" (line ~128):
          flip `body instanceof Text` → `body instanceof Markdown`.
          Optionally, add `expect(bodyText).toBe("> ✗ permission denied")`.
      - **Update the "renders safely when details is missing" test** (line
        ~163): the body is now `Markdown` (blockquote-wrapped). Assert
        `body instanceof Markdown` instead of `body instanceof Text`.
        Optionally, assert the body text is `"> bash: ls"`.
      - The "returns both keys" test, the "returns undefined on forced throw"
        test, and the M2 label-color tests are **unchanged** (they assert on
        the label, not the body component type).
      - **Update the file-level test docstring** (line ~10): "M1: body is
        `Text`, not `Markdown`" → "M1 (amended): body is `Markdown`
        (blockquote-wrapped), not `Text`".
- [x] **Amend `docs/tool-observability-and-spinner-spec.md` in lockstep with
      the code change (spec-driven repo — the M1 design pin must be reversed
      in the spec alongside the code; the implementer performs this edit):
      - **§4 (lines ~337–341):** replace the `**Body (M1):**` paragraph that
        says "the body child is a **`Text`** component, NOT `Markdown`" with:
        "**Body (M1, amended):** the summary/indicator text is rendered as a
        markdown blockquote for visual de-emphasis, so the body child is a
        **`Markdown`** component (using `getMarkdownTheme()`), with `> `-prefixed
        content to render as a markdown blockquote."
      - **§4 task 7B.UX.4 (line ~480):** update the M1 requirement from "The
        body is a `Text` child (the formatter-produced text), NOT `Markdown`
        (M1)" to "The body is a `Markdown` child (blockquote-wrapped, using
        `getMarkdownTheme()`), not `Text` (M1, amended)".
      - **§4 task 7B.UX.4 test description (line ~490):** update "Body is
        `Text`, not `Markdown` (M1)" to "Body is `Markdown` (blockquote-
        wrapped), not `Text` (M1, amended)".
      - **Revision summary at the top of the spec:** add a bullet noting the
        M1 amendment (body `Text` → `Markdown` with blockquote wrapping) and
        that it is reversed by the tool-UX-refinement phase.
- [x] **Acceptance:** `pnpm typecheck` clean;
      `pnpm test tests/extension/conduct-tool-renderer.test.ts` green.
- [x] **Verify:**
      `pnpm typecheck && pnpm test tests/extension/conduct-tool-renderer.test.ts`
- [x] **Verify (spec consistency):** manually read the amended paragraphs in
      `docs/tool-observability-and-spinner-spec.md` §4 and task 7B.UX.4 to
      confirm they consistently describe `Markdown` (blockquote-wrapped),
      not `Text`. No tool automates this — it is a human read-through.
- [x] **LOC guard:** `conduct-message-renderer.ts` is currently ~250 LOC;
      adding ~5 LOC for the `blockquote` helper keeps it well under ~400.

---

## Task R.3 — Full gate

**Spec sections:** Verification.
**Files:** none (verification only).

- [x] `pnpm typecheck` — clean (strict + `noUncheckedIndexedAccess` +
      `exactOptionalPropertyTypes` + `verbatimModuleSyntax`).
- [x] `pnpm build` — emits `dist/` with `.d.ts`.
- [x] `pnpm test` — all green, **including**:
      - `tests/grep-guard.test.ts` (no new pi imports in guarded dirs —
        `tool-summary.ts` is in `src/host/`; `conduct-message-renderer.ts`
        is in `src/extension/`; neither is guarded).
      - `tests/host/tool-summary.test.ts` (R.1 — error extraction +
        truncation).
      - `tests/host/display-forwarding.test.ts` (R.1 tightened the
        object-error assertion to `"✗ command not found"`; the multi-line
        string-error case at line ~232 is unaffected — `extractErrorMessage`
        returns string results directly, so `"✗ permission denied"` stays).
      - `tests/extension/conduct-tool-renderer.test.ts` (R.2 — blockquote
        wrapping, M1 flip).
      - `tests/extension/conduct-message-renderer.test.ts` (unchanged —
        the text renderer is not touched).
      - `tests/extension/conduct-registration.test.ts` (unchanged — both
        renderer keys still registered).
      - `tests/extension/tui-bridge.test.ts` (unchanged — the sink is not
        touched).
      - `tests/extension/status-spinner.test.ts` (unchanged — spinner not
        touched).
- [x] `pnpm lint` (`biome check .`) — clean.
- [x] `pnpm format:check` — clean.
- [x] `pnpm audit` — no new high/critical advisories introduced.
- [ ] **Manual UX verification** (visual feature — automated tests verify
      the data path, not the rendered appearance):
      1. Run `/conduct <goal>` with a manifest that triggers a tool failure
         (e.g., a `bash` command that exits non-zero, or a `read` on a
         non-existent path).
      2. Observe: the `✗` line shows a concise error message (e.g.,
         `✗ command not found: foo`), NOT a wall of JSON. If the error
         object has no recognizable field, the JSON is truncated to ~120
         chars with `…`.
      3. Observe: tool-call and tool-result lines render inside markdown
         blockquotes (indented, visually de-emphasized) relative to the
         agent's response prose.
      4. Verify existing behavior is preserved: `✓` on success, bash command
         truncation, spinner, machine-tool suppression, role-label coloring.
      - The manual run is **not** a phase gate; record the result as a note.

---

## Files touched summary

| File | Action | Task |
|------|--------|------|
| `src/host/tool-summary.ts` | MODIFY (error extraction + truncation) | R.1 |
| `tests/host/tool-summary.test.ts` | MODIFY (error cases + truncation cases) | R.1 |
| `src/extension/conduct-message-renderer.ts` | MODIFY (blockquote wrapping, Text→Markdown) | R.2 |
| `tests/extension/conduct-tool-renderer.test.ts` | MODIFY (M1 flip, body-content assertions) | R.2 |
| `tests/host/display-forwarding.test.ts` | MODIFY (tighten object-error assertion to extracted `message`) | R.1 |
| `docs/tool-observability-and-spinner-spec.md` | MODIFY (amend §4 M1 body-component pin: `Text` → `Markdown` blockquote; update task 7B.UX.4 M1 requirement + test description; add revision-summary bullet) | R.2 |

---

## Open questions for the overseer

1. **`MAX_ERROR_LINE_DISPLAY_LENGTH` value (D2).** 120 chars proposed. Confirm
   or direct a different cap. Does not block implementation.
2. **M1 amendment confirmation (D4).** The prior spec decided `Text` not
   `Markdown` for the tool body. This plan reverses that for blockquote
   rendering. Confirm the reversal is acceptable, or direct the `Text` +
   literal-`>`-prefix fallback. Does not block implementation.

---

## Summary (parent-plan mirror)

Phase 7B.UX-R — Tool-Call UX Refinement:

- [x] R.1 — Error extraction + truncation in `tool-summary.ts` (extract
      `message`/`error`/`stderr`; truncate to 120 chars with `…`)
- [x] R.2 — Blockquote wrapping in `conduct-message-renderer.ts` (body
      `Text`→`Markdown` with `> `-prefixed content; M1 amendment)
- [x] R.3 — Full gate (`typecheck`/`build`/`test`/`lint`/`format:check`/
      `audit` + manual UX)

**Checkboxes start unchecked.** Ticking is the implementer's job, performed in
the same change that implements each acceptance/verification step (AGENTS.md
tick-box discipline).
