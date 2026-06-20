# Real-model smoke — TUI bridge renderer polish (2026-06-20)

> **Status:** Pending manual run. The code is in place
> (`src/extension/conduct-message-renderer.ts`, registered from
> `extensions/conduct.ts`); the unit-test surface is green. The
> eyeball-TUI smoke is the human-owned step the overseer files
> after running `pi install -l ./` and exercising `/conduct` with
> a multi-role manifest. This file is the template; the
> observed-result section is filled in after the run.
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
/conduct <a goal that exercises both text and tool emissions>
```

## Acceptance — what to look for

- **Headings visually distinct.** A `### orchestrator` line in a
  streamed `conduct.role.text` should read as a heading (yellow
  + bold, or equivalent theme color), not as raw `###` syntax.
- **Role label.** Each streamed entry should have a structural
  role label above the body — `orchestrator` in one color,
  `worker` in another.
- **JSON/tool args.** A `handoff: {"target_role": "…"}` line in a
  `conduct.role.tool` entry should read as code-fenced (cyan or
  green in the default theme), not as raw unstyled text.
- **Fail-safe.** A renderer that throws (or `undefined` for any
  reason) falls through to pi's default `CustomMessageComponent`
  (purple-boxed `[customType]` label + flattened gray markdown).
  If you ever see the default box instead of the styled version,
  that's the fallback working — not a regression.

## Observed result

- Run id: TBD
- Eyeball pass: TBD
- Screenshot: TBD
