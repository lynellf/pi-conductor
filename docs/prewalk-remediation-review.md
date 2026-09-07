# Prewalk remediation review — 2026-09-07

Scope: experimental Prewalk MVP on `prewalk-projection`, against the acknowledged [projection spec](pi-conductor-prewalk-projection-spec.md). This is **not** issue #70 work (already merged), an issue #63 fix claim, or Slice 8 evidence.

## Findings addressed

- **R12, executor seed recovery:** append a delivery intent containing physical conversation identity/file, durable branch boundary and exact seed hash before prompting. Delivery markers require the exact durable user message. Resume reconciles disk history even when the marker is missing or an older marker was written prematurely. Native and projection tests cover both accepted-before-marker and intent-before-acceptance crash windows. Missing nonempty history and duplicate seeds fail closed; only an empty fresh projection transcript may be recreated.
- **R6/R8, production guide limits:** measure executor-transformed context, steer once at 75%, stop and force projection at exhaustion, and enforce guide cost/turn caps. Preserve cumulative guide control through `already_complete`/`blocked` machine-completion prompts. Failures record usage and attempt a recoverable Git exemplar checkpoint. Exhaustion without an executor-handoff checklist fails explicitly instead of inventing TODOs.
- **R7, projection results:** collect paired whole text `read`/`grep`/`find`/`ls` results from durable guide history. Keep deterministic ordering and existing whole-result budget selection; omit exemplar-modified path results. Unsupported, orphaned, duplicate-ID, external-path and mixed image/text results are ineligible. Search roots/output paths are tracked conservatively, including legal bracket-prefixed filenames.
- **R2, native request safety:** conductor-only drops in a repaired dry-run transcript are not applied by the SDK's actual native replay. Such transcripts now report `native_replay_repairs_unavailable`; configured auto/projection fallback remains available. The signed durable guide history is not rewritten.
- Removed the reported trailing whitespace in the historical continuation proposal.

## SDK evidence and compatibility

Runtime evidence is from the repository-installed Pi **0.80.6**, not the newer global installation:

- `core/session-manager.js::_persist` defers fresh transcript creation until the first assistant message.
- `core/agent-session.js::_handleAgentEvent` notifies message-end subscribers before persistence; event receipt is not durable-delivery proof.
- `agent.abort()` forwards cancellation to provider streams. The real-SDK cap fixture models cancellation; the ordinary scripted stub does not honor already-aborted requests.
- `core/tools/grep.js`, `find.js`, and `ls.js` define the output path formats used by retained-result collection.

The seed-intent record is additive. Old markers are reconciled against durable history, not treated as proof. Recovery remains host-owned and does not use the SDK session tree as run persistence.

## Review evidence

Tests were reviewed before implementation, then production call paths, recovery boundaries, module ownership, failure handling and retention provenance were inspected. Each reported remediation had a failing regression before its fix.

An independent fresh-context Codex review used supplied full-file snapshots after its read-only sandbox could not launch file-reading commands. It found two concrete issues: uncontrolled guide-only completion prompts and discarded bracket-prefixed search paths. Five regressions reproduced those issues before correction. A second bounded snapshot review of `b28cd66` confirmed both findings resolved and found no concrete nearby regression. These were **static snapshot reviews**, not independent runtime verification; no sandbox restrictions were weakened.

## Verification

- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] `pnpm test` — **134 files / 1,782 tests passed**
- [x] `pnpm format:check`
- [x] `git diff --check origin/main` — clean
- [x] Protected-contract comparison: no changes to core/seam, `execution-policy.ts`, `prepare-trajectory.ts`, or `node-role-session.ts`. The feature's emission-tool hook is opt-in and runs before capture; it does not reduce or persist. Grep guards pass.
- [x] `pnpm audit` executed and reviewed — **not passing**, details below.
- [ ] Full P2 approval — blocked by inherited audit findings.
- [ ] Slice 8 comparative provider experiment — explicitly deferred; no new live trials were run.

## Inherited audit blocker

Audit reports **7 high, 6 moderate, 1 low, 0 critical** advisories. `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` are unchanged from `origin/main`; the lockfile blob is identical. Dependency upgrades were not folded into this feature remediation.

High advisory groups:

| Dependency / installed version | Dependency path | Advisories / patched floor |
| --- | --- | --- |
| `brace-expansion` 5.0.6 | Pi SDK → minimatch | [3jxr](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp), [mh99](https://github.com/advisories/GHSA-mh99-v99m-4gvg), [rgw5](https://github.com/advisories/GHSA-rgw5-rvv9-x895); latest floor 5.0.9 |
| `undici` 8.5.0 | Pi SDK | [4cwx](https://github.com/advisories/GHSA-4cwx-7wf7-3272); 8.9.0 |
| `nanoid` 3.3.12 | Vitest → Vite → PostCSS | [28wg](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), [2v37](https://github.com/advisories/GHSA-2v37-7h3g-55p8); latest floor 3.3.18 |
| `postcss` 8.5.15 | Vitest → Vite | [r28c](https://github.com/advisories/GHSA-r28c-9q8g-f849); 8.5.18 |

These remain a merge/release gate issue for dependency remediation or an explicit repository-policy decision. Opening a normal review PR is not a claim that P2 passed.

## Remaining limits

Experimental and route-scoped: local stub/SDK tests prove host mechanics, not provider fidelity, task quality, cold-prefill economics, or a benefit over simpler orchestration. The existing P1 artifact remains the route evidence; Slice 8 remains the value gate. Native replay requiring conductor-only message drops is intentionally unavailable until a durable replay-repair mechanism is separately designed and verified.
