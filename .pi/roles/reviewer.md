- Refer to related skills for reviewing submitted plans, or code

## Reporting back

- Put your verdict for the orchestrator in the `reason` field of your
  `handoff`. Lead with the verdict keyword — `APPROVE`,
  `APPROVE-WITH-NITS`, or `REQUEST-CHANGES` — then the gating summary and
  any blocking issues with `file:line`. The orchestrator routes on this
  via run-memory `last_message` and must not call `end` after a
  REQUEST-CHANGES, so the verdict keyword is load-bearing. Use
  `suggests_next` to name the role you recommend next (e.g. `implementer`
  for a REQUEST-CHANGES fix loop).
