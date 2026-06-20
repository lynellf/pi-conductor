# Real-model smoke — TUI bridge renderer polish (2026-06-20)

> **Status:** Pending manual run. The code is in place
> (`src/extension/conduct-message-renderer.ts`, registered from
> `extensions/conduct.ts`); the unit-test surface is green. The
> eyeball-TUI smoke is the human-owned step the overseer files
> after running `pi install -l ./` and exercising `/conduct` with
> a multi-role manifest. This file is the template; the
> observed-result section is filled in after the run.
>
> **Phase 5.5 update (2026-06-20):** the sink now emits only `text`
> events (the LLM's reasoning verbatim) and suppresses all
> `tool_call`/`tool_result` events; the renderer bolds the role
> label. The acceptance criteria below reflect the remediated
> behavior. The eyeball-TUI run is still the human gate.
>
> **Surface:** `/conduct <goal>` inside `pi`, launched with the
> local extension loaded via `-e ./extensions/conduct.ts`.
>
> **Models used:** TBD by the human run (matches the 2026-06-20
> transcript pattern: base pi session + role sessions, with the
> conductor's `displaySink` wired to the conductor-owned
> `MessageRenderer`).

## Reproducing

From the repo root, after `pnpm build`:

```bash
pi --approve -e ./extensions/conduct.ts \
  --conduct-manifest <a multi-role manifest path> \
  --model <model>
```

Inside `pi`:

```text
/conduct <a goal that exercises a multi-role handoff cycle>
```

## Acceptance — what to look for

- **Bold role label.** Each streamed entry should have a **bold**
  role label above the body — `orchestrator` in one color,
  `worker` in another. The label is the sole visual anchor; there
  is no purple background box.
- **LLM text verbatim, no `###` heading.** The body is the LLM's
  text exactly as emitted — no `### ${role}` prefix injected by the
  sink (the role label already names the role).
- **No JSON, no brackets, no tool activity.** Tool calls, tool
  results, and the `handoff`/`end` "emission recorded: …" protocol
  noise are **not** shown in the TUI. Real tool activity remains in
  the per-role session JSONL.
- **Code fences render as code.** Any fenced blocks the LLM emits
  (```` ```js\n…\n``` ````) should render as styled code blocks
  (cyan/green in the default theme), not as raw text — the markdown
  theme's native handling via `getMarkdownTheme()` applies.
- **Fail-safe.** A renderer that throws (or returns `undefined` for
  any reason) falls through to pi's default `CustomMessageComponent`
  (purple-boxed `[customType]` label + flattened gray markdown). If
  you ever see the default box instead of the styled version, that's
  the fallback working — not a regression.

## Observed result

- Run id: TBD
- Eyeball pass: TBD
- Screenshot: TBD
