# Real-model smoke — `/conduct` `ask_user` bridge (2026-06-20)

> **Status:** Passed. The worker surfaced `ask_user`, the user answered, and
> the run reached `done` with the answer in the session JSONL. Follow-up manual
> testing confirmed dialog-level `Ctrl+C` cancels the prompt and returns no
> answer/selection as a normal, non-terminating tool result; the role can then
> ask again, hand off, or end.
>
> **Surface:** `/conduct verify ask_user smoke` inside `pi`, launched with the
> local extension loaded via `-e ./extensions/conduct.ts` and the smoke manifest
> under `scratch/phase-3-ask-user-smoke/conductor.yaml`.
>
> **Models used:** base `pi` session: `openrouter/fusion`; conductor role
> sessions: `openrouter:openrouter/fusion`.

## Reproducing

From the repo root, after `pnpm build`:

```bash
pi --approve -e ./extensions/conduct.ts \
  --conduct-manifest scratch/phase-3-ask-user-smoke/conductor.yaml \
  --model openrouter/fusion
```

Inside `pi`:

```text
/conduct verify ask_user smoke
```

When the worker opens the dialog, answer:

```text
blue
```

## Observed result

- Run id: `afe4e032-8cb1-4d47-ba3a-bb0ce9404591`
- Terminal state: `done`
- Answer recorded in the run log: `blue`
- Role path traversed: `orchestrator → worker → orchestrator → done`

## Scrubbed run-log highlights

| # | Record | Key fields |
|---|---|---|
| 1 | `session_started` | orchestrator visit 1 |
| 2 | `transition_accepted` | orchestrator → worker via `handoff` |
| 3 | `session_started` | worker visit 1 |
| 4 | `ask_user` display | `Which color should I use for this smoke?` |
| 5 | `ask_user` result | `blue` |
| 6 | `transition_accepted` | worker → orchestrator via `handoff` |
| 7 | `session_started` | orchestrator visit 2 |
| 8 | `transition_accepted` | orchestrator → `done` via `end` |

## Cancel note

I also tried `Ctrl+C` while the `ask_user` dialog was open. In the current `pi`
TUI, that dismisses the prompt and returns no answer (`"(no answer)"` for input,
`"(no selection)"` for select). That is the accepted Phase 3 dialog-cancel
behavior: it is a normal `ask_user` tool result, not a machine transition and
not whole-run abort. In a follow-up manual run, the role handled the missing
answer, the orchestrator asked again, the user answered, and the run reached
`done`.
