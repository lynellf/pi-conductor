---
title: Model identifier format (provider:id)
type: concept
status: active
source_files:
  - src/host/production-host-resolve.ts
  - src/manifest/validate.ts
tags:
  - manifest
  - model
  - resolution
  - validation
updated_at: 2026-07-01
---
# Summary

Model entries in the manifest use `provider:id` form (§8.1). The first colon is
the separator; colons in the id portion are allowed (e.g.
`ollama:robit/ornith:9b`). The runtime resolver is the real gate; the manifest
validator regex is a shape-only smoke test.

# Durable knowledge

- **`provider:id` uses the first colon as the separator.** Everything before
  the first colon is the provider name; everything after (including any
  additional colons) is the model id. This means multi-colon entries like
  `ollama:model:tag` (an Ollama tag with two colons) are valid.
- **The runtime resolver (`splitProviderId`) is the authoritative gate.**
  It rejects entries with no colon, empty provider, or empty id via
  `MalformedModelEntryError`. It does **not** reject multi-colon entries
  (changed from the original "exactly one colon" rule).
- **The validator regex (`PROVIDER_ID_FORM`) is a smoke test only.** It checks
  the `provider:id` shape (provider starts with letter, at least one colon)
  but does **not** enforce colon-count policy. The regex retains `:` in the
  id character class intentionally — it accepts entries that the resolver
  would also accept, avoiding validator/resolver disagreement.
- **`ModelNotFoundError` is a separate concern.** A valid `provider:id` that
  passes both the validator and resolver can still fail at
  `modelRegistry.find(provider, id)`. That is a user-side configuration
  issue, not a conductor bug.
- **Spec §8.1 defines `provider:id` intent.** It does not mandate a specific
  colon count. The implementation's colon policy was tightened from spec.

# Evidence

- `src/host/production-host-resolve.ts:82-96` — `splitProviderId` uses
  `entry.indexOf(":")` (first colon) as the separator; the multi-colon
  rejection branch was removed in commit `cbef5b3`.
- `src/manifest/validate.ts:56-60` — `PROVIDER_ID_FORM` regex comment
  documents that the runtime is the real gate.
- Commit `cbef5b3` (Phase 2 of the open-issues resolution) — commit message
  explicitly states "keep `:` in id char class for consistency."
- `docs/archive/resolve-open-issues/phase-2-allow-multi-colon-model-ids.md`
  — full analysis, tasks, and verification for the change.
- `tests/host/production-host.test.ts` — positive test for multi-colon
  resolver entry (`ollama:robit/ornith:9b`).
- `tests/manifest/validate.test.ts` — positive test confirming multi-colon
  entries pass the bare-model-alias check.

# Related

- `.okf/concepts/manifest-validation-boundary.md` — the strict boundary
  between static structural validation (§13) and runtime availability
  checks (host-side, preflight).
- `.okf/concepts/manifest-validation.md` (none yet — future doc about the
  §13 manifest check pipeline would reference this).
