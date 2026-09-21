# Report: issue #137 preserve supported worker-return narrative

**Issue:** Forgejo #137.  **Authority:** the issue acceptance criteria and
`docs/issue-137-return-narrative-preservation/plan.md`.

## Outcome

The worker-return path now carries the supported narrative through the actual
host loop, persistence, replay, and fresh-recipient seed paths. A worker only
needs to provide the concise supported `reason`; `summary` and
`verification` remain optional. Reported narrative is always labelled
untrusted and is not used by the FSM or host gate decisions.

## Remediation of the initial integration finding

The initial review found that `parseReturnEnvelope()` and
`RETURN_ENVELOPE_DIAGNOSTIC_PREFIX` existed only in the seam tests. Production
`createAcceptedControlV2()` still used the generic sanitizer, and persisted
records therefore lacked the stable return-field diagnostics.

The fix is now wired as follows:

- `src/host/accepted-control-v2.ts` calls `parseReturnEnvelope()` for every
  worker return. It preserves `reason`, `summary`, and `verification`, while
  retaining the existing `ignored_hint_fields` names for compatibility. The
  return schema, parser, and diagnostic prefix are also available from the
  public `src/index.ts` barrel.
- `AcceptedControlV2` has an additive bounded
  `ignored_hint_diagnostics` field. Its TypeBox persistence schema validates
  the field and its UTF-8 limits.
- Stable diagnostics use `ignored_return_field:<name>` and are propagated into
  work observations, continuity seeds, run memory, and the operator markdown
  view. Size pressure may omit optional diagnostics from a projected
  observation, but the primary `reason` is retained.
- The parser now actively runs `Value.Check(returnEnvelopeArgsSchema, value)`
  before applying its stricter UTF-8 and semantic bounds. Malformed optional
  fields become explicit ignored diagnostics rather than displacing a valid
  reason.
- Envelope size pruning removes optional narrative fields before it can remove
  the primary reason; an impossible envelope fails closed with the existing
  typed host error.

## Tests added or extended

- `tests/host-generated-continuity/control-seam.test.ts`: direct production
  promotion, persisted diagnostics, and reason retention under size pressure.
- `tests/host-generated-continuity/work-observation.test.ts`: diagnostics
  survive materialization and appear in the recipient seed.
- `tests/host/e2e.test.ts`: a real `StubHost`/`runLoop` v2 handoff with custom
  return fields verifies the persisted accepted-control record.
- Existing issue-137 seam, replay, run-memory, and observation tests remain in
  the focused regression set.

## Verification

All commands were run on the final working tree, excluding the unrelated
untracked `docs/issue-120-sandbox-preapplication-ingestion/` directory from
the change.

| Gate | Result |
|---|---|
| Focused issue-137 + integration set | **76/76 passing** across 7 files |
| `pnpm test` | **397 files, 4224 tests passing** |
| `pnpm typecheck` | pass |
| `pnpm build` | pass; declarations emitted |
| `pnpm lint` | pass; Biome checked 951 files |
| `pnpm format:check` | pass; Biome checked 951 files |
| `pnpm audit --audit-level high` | exit 0; 1 low and 2 moderate advisories, no high/critical output |
| `tests/grep-guard.test.ts` | passing in the focused set and full suite |
| Final independent review | **APPROVED**; return-field compatibility, authority boundaries, byte bounds, and scope verified |

The first full-suite attempt encountered the repository's protected-file mode
check after edits created mode `0664` files. The affected files were restored
to mode `0644`; the final full suite above passed without code or test
exceptions.

## Authority boundary and issue #139

Host-observed execution, workspace, persistence, and gate facts remain
authoritative. The supported return narrative and ignored-field diagnostics
are reported/untrusted context only. The advisory Jev enhancement was posted
to Forgejo issue #139 separately; Jev cannot approve gates, synthesize host
evidence, or override missing/failed checks.

## Scope

No reducer, routing-policy, or transport-policy behavior was changed. The
unrelated issue-120 sandbox-ingestion files are intentionally not included in
the PR.
