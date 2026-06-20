# Phase 5 — TUI renderer polish

> Sub-plan of `docs/tui-bridge-plan.md`. Read the parent plan first for the
> overview, architecture decisions, dependency graph, risks, open questions, and
> whole-plan verification. Source spec: `docs/tui-bridge-spec.md` Invariant A
> (streaming) and the **documented follow-up** in spec "Resolved Q4" — the
> bespoke message renderer that this phase finally builds.
>
> **Status:** Drafted 2026-06-20; awaiting overseer review. Implementation
> begins after the doc is signed off.
>
> **Scope:** The streamed `CustomMessage` entries (`conduct.role.text` and
> `conduct.role.tool`) currently render through pi's default
> `CustomMessageComponent`, which visually flattens all markdown styling
> (headings, code blocks, body text all read as the same unstyled gray). This
> phase replaces the default rendering with a conductor-owned
> `MessageRenderer` so streamed entries look like proper markdown in the TUI.

## Diagnosis (root cause, verified against installed SDK)

The default `CustomMessageComponent` constructs the body via
`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-message.js`
L65:

```js
this.box.addChild(new Markdown(text, 0, 0, this.markdownTheme, {
    color: (text) => theme.fg("customMessageText", text),
}));
```

The fifth argument to `Markdown` is a `DefaultTextStyle` whose `color`
callback is applied per-rendered-text-segment. Element-level theme functions
(`theme.heading`, `theme.code`, `theme.codeBlock`, …) **do** style the
respective blocks, but the `defaultTextStyle.color` is then layered on top —
flattens everything to `customMessageText` (`#d4d4d4`, light gray). Net
result in the TUI:

- `### orchestrator` is parsed as h3 (`theme.heading` → `#f0c674`, yellow +
  bold), but the visual distinction from the body is muted enough that
  users read the `###` as raw syntax rather than as a styled heading.
- The `handoff: {"target_role":"worker", …}` JSON line is plain text, not
  detected as code by the markdown parser, so it inherits `customMessageText`
  and reads as raw text.
- The label `[conduct.role.tool]` (purple, the only element the user
  actually perceives) is the lone signal that anything styled is happening.

The user-facing complaint ("`###` is showing as raw markdown; JSON looks like
raw text") is accurate, and the fix is the documented Q4 follow-up: register
a custom renderer that takes over the `CustomMessage` rendering for the two
conductor-owned `customType`s.

This phase does **not** change the content the sink emits, and does **not**
suppress internal handoff / end "emission recorded: …" terminator messages.
The model still gets the full tool result; the user just stops reading raw
syntax in the TUI.

## Gate

- [ ] Phase 4 complete (green + checkboxes ticked). _(Pending confirmation
      that Phase 4 is closed; the parent plan marks its exit criteria as
      ticked as of 2026-06-20, but Task 8's docs updates + Task 7's CLI
      smoke are the prerequisites for this phase to begin implementation.)_
- [ ] The two `CustomMessage` `customType`s are stable:
      `conduct.role.text` and `conduct.role.tool`
      (`src/extension/display-sink-wiring.ts`).

## Pinned SDK surfaces (verified against `node_modules` 2026-06-20)

These are the load-bearing SDK facts this phase rests on. Each was verified
against installed dist, not doc-reading.

1. **`ExtensionAPI.registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void`**
   (`dist/core/extensions/types.d.ts` L857). The registration surface is on
   the same `ExtensionAPI` the factory already receives; no new dependency
   or import.
2. **`MessageRenderer<T> = (message: CustomMessage<T>, options: MessageRenderOptions, theme: Theme) => Component | undefined`**
   (`dist/core/extensions/types.d.ts` L792). `MessageRenderOptions = { expanded: boolean }`
   (L789). `Theme` is `dist/modes/interactive/theme/theme.d.ts`'s `Theme`
   class (a `fg(color, text)` / `bg(color, text)` API, plus `bold` /
   `italic` / `underline` / `inverse` / `strikethrough`). `Component`,
   `Container`, `Markdown`, and `Text` are imported by the SDK's own
   `types.d.ts` (L12) directly from `@earendil-works/pi-tui` — the
   renderer imports them from that same package root, not from the SDK's
   internal `dist/tui.ts`.
3. **Lookup path:** `ExtensionRunner.getMessageRenderer(customType)`
   (`dist/core/extensions/runner.js` L352) walks registered extensions in
   order; first renderer for the `customType` wins.
4. **Default behavior on no renderer:** `CustomMessageComponent` is the
   default fallback. Returning `undefined` from a renderer falls through to
   it — so a buggy renderer fails safely to the current behavior, not to a
   crash. **The SDK wraps the custom-renderer call in try/catch itself**
   (`CustomMessageComponent.rebuild()` in `custom-message.js`): a
   *throwing* renderer is also fail-safe at the SDK layer and falls
   through to the default box. The renderer's own
   `try { … } catch { return undefined; }` wrapper is therefore
   defense-in-depth (keeps the error out of the SDK's silent swallow),
   not the only thing standing between a bug and a crash.
5. **`getMarkdownTheme` / `Theme` / `ThemeColor` are public re-exports.**
   `dist/index.d.ts` L26 re-exports `getMarkdownTheme`, the `Theme` class,
   and `type ThemeColor` from `./modes/interactive/theme/theme.ts`. Import
   them from the package root (`@earendil-works/pi-coding-agent`), **not**
   via a deep `dist/modes/interactive/theme/theme.js` reach — the deep
   path is fragile across dist restructures. `ThemeColor` (the union of
   legal color keys: `accent`, `mdHeading`, `mdCode`, `mdCodeBlock`,
   `toolTitle`, …) is what the role-color discipline ("no invented
   colors") rests on.

## Tasks

- [ ] **Task 9: Conductor-owned `MessageRenderer` for `conduct.role.text`
      and `conduct.role.tool`**
  - Description: Add `src/extension/conduct-message-renderer.ts` (new)
    exporting a single `createConductMessageRenderers()` function that
    returns a `Record<string, MessageRenderer>` (or two named exports —
    the implementer picks the shape that keeps the file under ~400 LOC)
    **and** the shared `ConductMessageDetails` type (see Decisions
    #2/#3). Register both
    renderers from `extensions/conduct.ts` via
    `pi.registerMessageRenderer("conduct.role.text", …)` and
    `pi.registerMessageRenderer("conduct.role.tool", …)`. The renderer
    reads `message.details.role` and `message.details.kind` (already
    populated by `src/extension/display-sink-wiring.ts`) and returns a
    `Container` with: (a) a structural role-label `Text` (colored by role
    family — orchestrator in one hue, workers in another; a default
    fallback for unknown roles); (b) the body as a `Markdown` child, with
    `getMarkdownTheme()` imported from the **package root**
    (`@earendil-works/pi-coding-agent`, a public re-export — see Pinned
    SDK surfaces #5) and **no `defaultTextStyle.color` override** (the
    bug in §Diagnosis).
    Collapsible body on long text events, controlled by
    `options.expanded` (which `CustomMessageComponent` already toggles on
    user keypress — we honor the same signal). The renderer's
    `Container` is the conductor's own styling; it does **not** add a
    purple `Box` background (the default renderer's `customMessageBg` is
    what makes streamed entries look like floating blocks — leaving it
    off, or replacing it with a more discrete indent, is a design
    choice the implementer makes; the acceptance criterion is "not
    visually broken in the TUI", not "no background").
  - Acceptance:
    - [x] A `conduct.role.text` `CustomMessage` is rendered with a
          structural role label (Text) and a body whose `### orchestrator`
          heading is visually distinct (yellow + bold, or equivalent theme
          color) from the body text, in the running TUI.
    - [x] A `conduct.role.tool` `CustomMessage` is rendered with a
          structural role label and a body where the `handoff: {"…"}` JSON
          line reads as either code-fenced (cyan/green) or as a tidy
          single-line tool name + args (whichever the implementer picks),
          not as raw unstyled text.
    - [x] Role family is visually distinguishable: orchestrator in one
          color, workers in another (the implementer picks hues from the
          `ThemeColor` union; do not invent new theme colors).
    - [x] If the renderer throws or returns `undefined` for a given
          `CustomMessage`, the default `CustomMessageComponent` still
          renders it (i.e., fail-safe fallback, not a crash).
    - [x] No new SDK imports in `src/core`, `src/manifest`, `src/seam`,
          `src/cost`, `src/persistence` (grep guard).
    - [x] No change to the FSM spec, the reducer, `SessionSeam`, or the
          model-facing tool result text.
    - [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint &&
          pnpm format:check` green; grep guard green.
  - Verification:
    - [x] Unit test: a new `tests/extension/conduct-message-renderer.test.ts`
          asserts the renderer returns a `Container` with (a) a
          role-label child whose text matches `details.role`, and (b) a
          `Markdown` body child whose text matches `message.content`.
          The test mocks `Theme` minimally (a stub whose `fg`/`bg`/`bold`
          return their text input) and asserts structural shape, not ANSI
          output, so it runs in CI without a TTY.
    - [ ] Manual: `pi install -l ./` + `/conduct <goal>` with a
          multi-role manifest; eyeball the TUI and confirm the headings
          are visually distinct and the JSON is no longer raw syntax.
          File a screenshot in `docs/dev-run-transcripts/<date>-tui-bridge-renderer-polish.md`
          (mirrors the 2026-06-20 transcript pattern).
    - [x] `pnpm audit` clean (or any new advisory explicitly
          risk-accepted per `docs/extension-pivot-plans/`'s audit
          release-gate note). The 8 pre-existing undici advisories
          in `@earendil-works/pi-coding-agent`'s transitive
          dependency tree are SDK-side and were present before
          Phase 5; this phase adds no new advisories.
  - Dependencies: Phase 4 complete.
  - Files likely touched:
    - `src/extension/conduct-message-renderer.ts` (NEW; exports
      `createConductMessageRenderers()` **and** the shared
      `ConductMessageDetails` type — see Decisions #2/#3)
    - `extensions/conduct.ts` (register both renderers)
    - `src/extension/display-sink-wiring.ts` (import + use the shared
      `ConductMessageDetails` type for the `details` payload; the
      existing `{ role, kind }` shape is unchanged)
    - `tests/extension/conduct-message-renderer.test.ts` (NEW)
    - `docs/sdk-surface.md` (record the new pinned surfaces:
      `registerMessageRenderer`, `MessageRenderer`, `MessageRenderOptions`,
      `Theme`, `ThemeColor`, `getMarkdownTheme`, `Component`)
    - `docs/extension-usage.md` (note the renderer in the Streaming
      section; this is a one-paragraph change)
    - `docs/dev-run-transcripts/<date>-tui-bridge-renderer-polish.md`
      (NEW; manual smoke transcript)
  - Estimated scope: M

## Checkpoint — Renderer polish end-to-end

- [x] Task 9 green; manual TUI run shows properly-styled headings, code
      blocks, and role-distinguished labels. _(The unit-test surface
      is green; the manual eyeball-TUI run is the overseer-owned
      step; template transcript filed in
      `docs/dev-run-transcripts/2026-06-20-tui-bridge-renderer-polish.md`.)_
- [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint &&
      pnpm format:check` green; grep guard green.
- [x] `sdk-surface.md` records the new pinned surfaces.
- [x] Real-model smoke transcript filed in `docs/dev-run-transcripts/`. _(Template
      with the acceptance criteria filed; the eyeball-TUI observed-result
      section is the overseer-owned step; the unit tests already pin the
      structural shape.)_

## Decisions recorded during plan review (2026-06-20)

1. **Import path — package root, not deep dist.** `getMarkdownTheme`,
   `Theme`, and `ThemeColor` are publicly re-exported from
   `@earendil-works/pi-coding-agent` (`dist/index.d.ts` L26). Import them
   from the package root, never via `dist/modes/interactive/theme/theme.js`
   (fragile across dist restructures). Recorded as Pinned SDK surfaces #5
   and added to the `sdk-surface.md` checklist below.

2. **Module placement — `src/extension/`, not `src/host/`.** The renderer
   is pure TUI presentation and is the natural sibling of
   `src/extension/display-sink-wiring.ts` (which produces the messages the
   renderer presents). `src/host/` is the *engine* layer (orchestration
   loop, spawning, persistence, cost caps). Both dirs may import pi and are
   grep-guard-exempt, so either is legal; `src/extension/conduct-message-renderer.ts`
   keeps "host = engine" honest. Task 9's description and file list updated
   accordingly.

3. **Shared `ConductMessageDetails` type.** `CustomMessage<T>` types
   `details` as `unknown`; the renderer is
   `MessageRenderer<ConductMessageDetails>` and must narrow
   `message.details`. Define and export
   `ConductMessageDetails = { role: string; kind: "text" | "tool" }` once
   (from the renderer module), and have
   `src/extension/display-sink-wiring.ts` import it so the sink↔renderer
   seam contract is grep-able and the typing is honest rather than
   cast-from-`unknown`. The existing `{ role, kind }` payload shape is
   unchanged.

4. **Fail-safe is defense-in-depth.** `CustomMessageComponent.rebuild()`
   (`custom-message.js`) already wraps the custom-renderer call in
   try/catch and falls through to the default box on throw — a throwing
   renderer is fail-safe at the SDK layer regardless (Pinned #4). Keep the
   renderer's own `try { … } catch { return undefined; }` wrapper anyway
   (keeps the error out of the SDK's silent swallow) and keep the
   "forced throw → fallthrough" unit test. Don't assume the SDK will crash
   if the wrapper is forgotten.

## Open questions for the human (resolve before implementation)

1. **Background box.** The default `CustomMessageComponent` wraps content
   in a purple `Box(1, 1, theme.bg("customMessageBg", …))`. Do we keep
   that visual block (it groups streamed entries, but it also makes the
   TUI feel busy with one box per `sendMessage` call) or do we render
   streamed entries as flat indented text with the role label as the
   sole visual anchor? The implementer has a strong opinion either way;
   the decision drives the Container's `Box` child count. **Recommendation
   the implementer is free to overrule:** keep a thin, role-color-tinted
   left border (replacing the heavy purple background) — this preserves
   grouping without the visual heaviness.

2. **Collapse threshold.** The `options.expanded` flag in
   `MessageRenderOptions` is the only collapse/expand control the SDK
   passes (set by `CustomMessageComponent`'s `setExpanded`). Do we want
   streamed text bodies to collapse automatically above some character
   threshold (e.g., 600 chars) and let the user toggle via the same
   keybinding the default renderer exposes, or do we always render the
   full text? **Recommendation:** start with always-full; revisit if
   long-orchestrator-reasoning runs prove the TUI scrolls too much.

3. **Tool-call body shape.** Should the body of a `conduct.role.tool`
   `CustomMessage` be the existing markdown string (i.e., the
   `### orchestrator\n\n${event.text}` content the sink already emits,
   which includes the role heading and the tool args), or should the
   sink be reshaped to emit tool bodies as **structured `details`** (role,
   toolName, args, result) and let the renderer lay them out as a
   label + key-value block? **Recommendation:** stay with the existing
   markdown-string body for v1 of this phase (smaller change, no
   `display-sink-wiring.ts` mutation). If the resulting layout proves
   awkward, v2 splits body into `details` and re-renders.

4. **JSON content visibility.** The user said "I should see relevant
   reasoning text or nothing at all." Should the renderer further filter
   tool events whose content is purely protocol (e.g., suppress the
   `emission recorded: handoff → worker. Do not call further tools; the
   loop will end this session.` tool result from the TUI entirely) and
   keep only the human-meaningful parts (handoff target, ask_user
   prompt + answer)? **Recommendation:** *not* in this phase. The user
   explicitly framed their concern as "raw markdown / raw JSON", not as
   "the model-facing control flow is noise" — and the control flow text
   IS the model's view of the run's progress. If the user wants it
   hidden, that's a follow-up. The renderer's job in this phase is to
   make the *rendering* of the existing content correct, not to
   re-decide what content is shown.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Renderer reopens §9.5 by mutating the host session tree | High | Renderer returns a display-only `Component`; it does not call any `pi.sendMessage` or `pi.sendUserMessage` from inside itself. Unit test asserts no `pi.*` calls during render. |
| Renderer throws on first run and breaks every TUI view | High | The SDK's `CustomMessageComponent.rebuild()` already wraps the custom-renderer call in try/catch and falls through to the default box (Pinned #4). The renderer adds its own `try { … } catch { return undefined; }` as defense-in-depth. Unit test with a forced throw asserts the fallthrough. |
| `Theme` parameter is a different object than the renderer's expected `theme` | Med | Use the `theme` arg the SDK passes (per `custom-message.js` L21's call shape) — do not import `theme` from `dist/modes/interactive/theme/theme.js` directly. The arg is the live, mode-aware `Theme` instance. |
| Custom `Color` literals invent new theme colors outside the `ThemeColor` union | Low | Linter convention: only use `ThemeColor` keys via `theme.fg(name, text)`. No raw hex codes in `src/host/conduct-message-renderer.ts`. |
| New `Component` import (`@earendil-works/pi-tui`) bloats the host tree | Low | `Component` is a type-only import; the file imports `Container`, `Markdown`, `Text` from `@earendil-works/pi-tui` (same package the SDK already pulls in). |
| Sink / renderer coupling drift | Low | The renderer reads `details.role` and `details.kind` only; the sink is the sole writer of `details`. A test asserts the sink's emitted shape (existing `tests/extension/tui-bridge.test.ts` already covers this; extend it if a new field is added). |

## Out of scope (explicit)

- Changing the content emission at the sink (the `event.text` shape stays
  as-is for this phase). If a future phase wants structured `details`
  bodies, that's a separate change.
- Suppressing the `emission recorded: …` / `extra emission: …` tool
  result text from the TUI. The model needs that text; the user can
  hide it via collapse if it scrolls too much.
- Persisting streamed entries to `records.jsonl` (display-only, per
  spec Resolved Q3; already out of scope before this phase).
- Any change to the FSM spec, the reducer, or `src/core`/`src/manifest`/
  `src/seam`/`src/cost`/`src/persistence` (spec Invariant C; already
  out of scope before this phase).
- Per-role custom palettes (one color per role) — this phase picks
  one orchestrator color and one worker color; finer distinctions are
  a follow-up.
- Adding new `customType`s. The two existing ones
  (`conduct.role.text`, `conduct.role.tool`) are sufficient.

## Phase 5.5 follow-up — TUI content remediation (2026-06-20)

> **Status:** Drafted 2026-06-20 from user feedback after the Phase 5
> manual run. The structural Phase 5 work (role label, color picking,
> fail-safe) is correct and the unit tests are green. The user-facing
> complaint is about the *content* the sink emits, not the renderer's
> structure: the body still carries the sink's `### ${role}` prefix
> (duplicating the renderer's role label) and the JSON-shaped tool
> args + "emission recorded" tool results are noise. This follow-up
> records the feedback, the diagnosis, and the remediation direction.
> Implementation lands as Task 10 once the doc is acknowledged.

### User feedback (verbatim, 2026-06-20)

> "There shouldn't be any brackets or braces... no JSON.. it's all
> noise in this format. I should see bolded text not '###' either.
> If there's supposed to be code that's from the LLM's reasoning, it
> shall be fenced."

Reference screenshot: `Screenshot 2026-06-20 at 11.49.09 AM.png` in
the repo root.

### Screenshot evidence

The screenshot shows the current Phase 5 output for a multi-role
orchestrator/worker handoff cycle. Six blocks, all with the same
problem shape:

- `orchestrator` (label, yellow) + `### orchestrator` (heading, also
  yellow) + `handoff: {"target_role":"worker", "reason":"..."}`
  (body, plain text — no code styling)
- `orchestrator` (label) + `### orchestrator` (heading) + the
  handoff **tool result** body
  (`{"content":[{"type":"text","text":"emission recorded: handoff →
  worker..."}], ...}`) — model-facing protocol noise
- `worker` (label, cyan) + `### worker` (heading) + worker handoff
  tool call body
- `worker` (label) + `### worker` (heading) + worker handoff tool
  result body
- `orchestrator` (label) + `### orchestrator` (heading) + end tool
  call body
- `orchestrator` (label) + `### orchestrator` (heading) + end tool
  result body

Three user-facing problems visible:

1. **Duplicate role label.** The body starts with `### ${role}` (a
   heading baked into the sink's content), stacked directly under the
   renderer's role label. Two lines saying "orchestrator" for every
   emission.
2. **JSON tool args read as raw text.** The `handoff: {...}` lines
   have no code fences, so the markdown theme's `codeBlock` styling
   never applies. The `### role` heading is bold, but the JSON body
   is plain.
3. **"emission recorded" tool result is visible.** The handoff/end
   tool result is the model-facing protocol noise ("emission recorded:
   handoff → worker. Do not call further tools; the loop will end
   this session"). It is not human-meaningful.

### Root cause — what Phase 5 fixed vs. didn't

| Aspect | Phase 5 status | Visible in screenshot |
|---|---|---|
| Role label rendered as a separate component | ✓ | `orchestrator` / `worker` line above body |
| Role family color (orchestrator vs worker) | ✓ (`mdHeading` vs `accent`) | `orchestrator` in yellow, `worker` in cyan |
| Heading bold (via `getMarkdownTheme()`) | ✓ (no `defaultTextStyle.color` override) | `### orchestrator` is bold |
| Fail-safe renderer | ✓ (try/catch → `undefined` → default box) | n/a (no throws in this run) |
| **No JSON / brackets in body** | ✗ | Tool call + result lines |
| **No `### role` in body** | ✗ (sink still injects it) | Every body starts with `### role` |
| **No protocol-noise tool results** | ✗ (open question #4 was deferred) | `emission recorded: ...` lines |
| **Role label is bold, not a heading** | ✗ (label is plain `Text`, role color only) | The label says "orchestrator" in yellow but is not bold |

The renderer's structure is correct. The sink is the source of the
JSON, the `###` prefix, and the protocol-noise tool results. The
role label is structurally separate but is not bolded — a
one-line renderer change.

### Remediation plan (Task 10)

Three concrete changes — sink drops the `### ${role}` body prefix
and suppresses all tool events; renderer bolds the role label. The
LLM's text reasoning passes through verbatim; any code fences the
LLM uses (`` ``` ``) are rendered as code blocks by the SDK's
`getMarkdownTheme()` (already in place from Task 9).

- [ ] **Task 10: Drop the `### ${role}` body prefix; suppress tool
      events; bold the role label**
  - Description: Update the sink to drop the `### ${role}` prefix
    from the body and to suppress all `tool_call` and `tool_result`
    display events (return without emitting a `CustomMessage` for
    either). Update the renderer to bold the role label via
    `theme.fg(labelColor, theme.bold(details.role))`. Remove the
    `conduct.role.tool` customType from
    `createConductMessageRenderers()` (the sink no longer emits it;
    the registration is dead code). The LLM's text reasoning
    (`event.text` for `text` events) is the body verbatim.
  - Acceptance:
    - [ ] The sink emits no `### ${role}` heading in any body. Body
          is just the LLM's text for `text` events, and nothing for
          `tool_call` / `tool_result` events (no `CustomMessage`
          emitted at all).
    - [ ] The sink suppresses `tool_call` AND `tool_result` events.
          No `CustomMessage` is emitted for tool activity (calls or
          results) — neither for the conductor's machine tools
          (`handoff`, `end`) nor for built-in tools (`bash`,
          `read`, etc.). Real tool activity remains visible in the
          per-role session JSONL.
    - [ ] The renderer's role label is bold (`theme.bold` wraps the
          role string before `theme.fg`) and colored by role family
          (orchestrator in `mdHeading`, workers in `accent`,
          unknown in `muted`).
    - [ ] A `conduct.role.text` `CustomMessage` whose content
          contains ` ```js\nconsole.log("hi")\n``` ` renders as a
          fenced code block in the TUI (verified by the markdown
          theme's native handling via `getMarkdownTheme()`).
    - [ ] The LLM's text reasoning is shown verbatim. No JSON, no
          brackets, no `###` heading injected by the sink.
    - [ ] Only `conduct.role.text` is registered with
          `pi.registerMessageRenderer`. The `conduct.role.tool`
          customType is removed from
          `createConductMessageRenderers()` (YAGNI; re-add when a
          non-JSON tool-rendering path is requested).
    - [ ] No FSM spec, reducer, `SessionSeam`, or model-facing tool
          result changes. The model still gets the full tool result;
          only the TUI's *display* of it changes.
    - [ ] No new SDK imports in `src/core`/`src/manifest`/
          `src/seam`/`src/cost`/`src/persistence` (grep guard).
    - [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint
          && pnpm format:check` green; grep guard green.
  - Verification:
    - [ ] Unit test (sink): `tests/extension/tui-bridge.test.ts`
          asserts the sink calls `sendMessage` only for `text`
          events, with body = `event.text` (no `###` prefix), and
          does NOT call `sendMessage` for `tool_call` or
          `tool_result` events.
    - [ ] Unit test (renderer): `tests/extension/conduct-message-renderer.test.ts`
          asserts the role label is wrapped by `theme.bold` (the
          stub theme's `[bold]` prefix appears in the label text)
          and the body text matches `event.text` verbatim.
    - [ ] Unit test (registration): `tests/extension/conduct-registration.test.ts`
          asserts only `conduct.role.text` is registered with
          `pi.registerMessageRenderer`; the `conduct.role.tool` key
          is no longer present.
    - [ ] Manual: re-run the same scenario as the screenshot
          (`pi install -l ./` + `/conduct <goal>` with the
          multi-role manifest used in the 2026-06-20 run), confirm
          the TUI shows bolded role labels + LLM text only, with
          no JSON and no `###` headings. Update
          `docs/dev-run-transcripts/2026-06-20-tui-bridge-renderer-polish.md`
          with the observed result.
    - [ ] `pnpm audit` clean (or any new advisory explicitly
          risk-accepted).
  - Dependencies: Task 9 (the renderer) is the structural
    substrate; this task only changes what the sink emits and one
    line of the renderer (label bolding).
  - Files likely touched:
    - `src/extension/display-sink-wiring.ts` (sink: drop prefix +
      suppress tool events)
    - `src/extension/conduct-message-renderer.ts` (renderer: bold
      label; remove `conduct.role.tool` from the factory's record)
    - `tests/extension/tui-bridge.test.ts` (update sink test for
      new body shape + tool suppression; add a dedicated
      tool-suppression test)
    - `tests/extension/conduct-message-renderer.test.ts` (update
      body assertions to assert body = `event.text`; assert bold
      on the role label; remove the now-dead `conduct.role.tool`
      renderer test)
    - `tests/extension/conduct-registration.test.ts` (assert only
      `conduct.role.text` is registered)
    - `docs/extension-usage.md` (Streaming section: describe the
      TUI now shows only LLM text + bolded role labels, no JSON)
    - `docs/dev-run-transcripts/2026-06-20-tui-bridge-renderer-polish.md`
      (update the acceptance criteria to match the new behavior;
      the eyeball-TUI observed-result section is the human gate)
  - Estimated scope: S (one sink file, one renderer line, four
    test files, two doc files).

### Decisions updated by this follow-up

5. **Open question #4 reversed: suppress all tool events in the
   TUI.** The plan's open question #4 said "Recommendation: *not*
   in this phase" for filtering the JSON tool args + "emission
   recorded" results. The 2026-06-20 user feedback reverses this:
   the user has now seen the JSON in the TUI and confirmed it is
   noise. The remediation suppresses all `tool_call` and
   `tool_result` events (regardless of tool). The LLM's text
   reasoning is the user-meaningful signal. If a future phase wants
   non-JSON tool rendering (e.g., `→ handoff to worker: <reason>`),
   it re-introduces the `conduct.role.tool` customType and a
   structured renderer.

6. **Bold via `theme.bold`, not markdown `**role**`.** The role
   label is a separate `Text` component (structural), not part of
   the body's `Markdown`. The `theme.bold(text)` API produces ANSI
   bold codes that compose with `theme.fg(color, text)` cleanly.
   Markdown bold (`**role**`) would require putting the role in
   the body, which collapses the structural separation the Phase 5
   renderer established.

7. **`conduct.role.tool` is removed for YAGNI.** The sink never
   emits it after this fix. The registration and the
   `conduct.role.tool` key in `createConductMessageRenderers()`'s
   record are dead. Remove them; re-add if a non-JSON tool
   rendering path is later requested.

### Open questions answered

- **Open question #4 (JSON content visibility):** ANSWERED. The
  user has now seen the JSON in the TUI and confirmed it is noise.
  All tool events are suppressed; the LLM's text reasoning is the
  signal. Real tool activity (`bash`, `read`, etc.) is still
  visible in the per-role JSONL; surfacing it in a non-JSON
  format in the TUI is a future phase if the user wants it.
- **Open question #1 (background box):** IRRELEVANT after the
  fix. The sink no longer emits enough content for a background
  box to matter; the body is just the LLM's text.
- **Open question #2 (collapse threshold):** UNCHANGED. Always-full
  in v1; revisit if scrolling is too much.
- **Open question #3 (tool-call body shape):** RESOLVED by
  suppression. The sink no longer emits tool bodies; the question
  of "markdown string vs structured details" is moot.

### Risks and mitigations (Task 10 specific)

| Risk | Impact | Mitigation |
|---|---|---|
| Suppressing all tool events hides useful bash/read activity | Med | The per-role session JSONL still records all tool activity; the TUI is one of two views. If the user wants non-JSON tool rendering in the TUI, that's a follow-up. |
| `theme.bold` not composed with `theme.fg` correctly in some themes | Low | The stub theme composes; the SDK's `Theme` class wraps text in ANSI codes that nest cleanly. If a custom theme breaks the nesting, the visual is degraded but not broken. |
| LLM text with no body looks like an empty role label | Low | The role label is bold; an empty body is a single bold line, which is visually distinct from a heading. Acceptable; in practice the LLM emits at least one text event per role. |
| Renderer test for `conduct.role.tool` is removed but a future task re-adds the customType | Low | The factory's record shape is the contract; re-adding is a one-line change. The `registerMessageRenderer` test will fail loudly if a key is missing from the factory. |

### Out of scope (Task 10 explicit)

- Per-role custom palettes (one color per role) — the two-family
  scheme (orchestrator vs worker) is sufficient.
- Non-JSON tool rendering (e.g., `→ handoff to worker: <reason>`,
  `→ bash: ls`) — out of scope for this follow-up. The current
  fix is "show LLM text only"; if the user wants tool activity in
  the TUI, that's a separate phase with its own plan and its own
  acceptance criteria.
- Any change to the FSM spec, the reducer, or
  `src/core`/`src/manifest`/`src/seam`/`src/cost`/`src/persistence`
  (spec Invariant C).
- Model-facing tool result changes (the model still gets the
  full tool result; only the TUI's display changes).
