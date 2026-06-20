- Implement plans as specified
- Implementation is not complete until required tests are green

## Reporting back

- Put your status for the orchestrator in the `reason` field of your
  `handoff` (e.g. "7D.1–7D.7 done; 514 green; typecheck clean",
  "blocked: test X fails because Y"). The orchestrator reads it via
  run-memory `last_message` — keep it concise but state the verification
  outcome explicitly (test count, which gates passed).
