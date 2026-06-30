# Phase 2 — Allow multi-colon model ids in `provider:id` resolution (issue #3, primary fix)

**Spec authority:** Orchestrator handoff brief + spec §8.1 ("each entry carries
a model + effort … `provider:id` form") + spec §13 ("`provider:id` form;
bare aliases are a hard reject"). The spec defines the *intent* of the format
but does not pin a colon-count policy. The current runtime choice (exactly
one colon) is implementation-only, not spec-mandated.
**Resolves:** #3 (primary technical fix; doc/comment closure happens in phase 3).

## What I found

Issue #3 is filed by the repo owner with a manifest that includes
`ollama:robit/ornith:9b` — an Ollama tag with two colons. Investigation
uncovered a real bug, not just a docs gap:

### The bug: validation accepts what resolution rejects

**`src/manifest/validate.ts:56`** — `PROVIDER_ID_FORM`:
```ts
const PROVIDER_ID_FORM = /^[a-zA-Z][a-zA-Z0-9_-]*:[a-zA-Z0-9._:/-]+$/;
```
The id character class `[a-zA-Z0-9._:/-]` explicitly includes `:`. So
`ollama:robit/ornith:9b` passes §13's `bare-model-alias` check (id contains
`robit/ornith:9b` — all allowed chars).

**`src/host/production-host-resolve.ts:78-97`** — `splitProviderId`:
```ts
function splitProviderId(role: Role, entry: string): { provider: string; id: string } {
  const first = entry.indexOf(":");
  if (first === -1) throw new MalformedModelEntryError(role, entry);
  // Reject more than one colon — `provider:id` has exactly one separator.
  if (entry.indexOf(":", first + 1) !== -1) {
    throw new MalformedModelEntryError(role, entry);
  }
  ...
}
```
The runtime resolver explicitly rejects a second colon. The same call site
has a test (`tests/host/production-host.test.ts:282-310`) that asserts the
throw for `entry: "anthropic:claude:x"`.

**Net effect for the reporter:** the manifest loads (no `bare-model-alias`
error) and then dies at the first `spawnRole` for the `implementer` role
with `MalformedModelEntryError: role 'implementer' model entry
'ollama:robit/ornith:9b' is not in 'provider:id' form (§8.1)`. The user
sees a runtime error from a manifest the validator said was fine.

### Why this is wrong, not just inconsistent

- **Ollama tags are `model:tag` by convention.** `llama3:8b`, `qwen2.5:14b`,
  `codellama:13b` are standard. A `provider:namespace/model:tag` form is a
  legitimate, common case in the Ollama ecosystem.
- **The spec is silent on colon count.** §8.1 calls it `provider:id` form
  but doesn't say "exactly one colon." The implementation picked that
  constraint; it's not load-bearing.
- **The validator already allows colons in the id** (the regex's character
  class says so). Resolution is the *outlier*.
- **The error message is misleading.** "not in 'provider:id' form" reads as
  a format complaint; the actual rejection is "more than one colon." A user
  looking at `ollama:robit/ornith:9b` reasonably thinks it *is* `provider:id`
  form and concludes the manifest is wrong, when the actual constraint is
  the runtime's "single colon" rule.

### What this phase does

Loosen `splitProviderId` to use the **first** colon as the separator and
allow colons in the id. Drop the second-colon test case. Tighten
`PROVIDER_ID_FORM` to remove the now-redundant `:` from the id character
class (cosmetic — the runtime check is the real gate, and the validator's
regex is a smoke test). Update tests.

This is a behavior change in the resolver. It does not change the
§13 `bare-model-alias` rule's intent — the id still must be a non-empty
identifier-like string. It only changes the colon policy. Manifests that
worked before keep working; manifests that hit the multi-colon case
(`ollama:model:tag`) now work too.

### What this phase does NOT do

- Does not change the `modelRegistry.find(provider, id)` contract. The fix
  only changes how the conductor splits the entry. Whether the resulting
  `(provider, id)` pair exists in the registry is a separate concern
  (`ModelNotFoundError`). The reporter's other two entries —
  `opencode-go:deepseek-v4-flash` and `openrouter:deepseek/deepseek-v4-flash`
  — would still hit `ModelNotFoundError` if those providers aren't
  registered in the host's `ModelRegistry`. That's a *configuration* problem
  for the user, not a conductor bug; phase 3's resolution comment explains
  the distinction.
- Does not move the `provider:id` boundary to the SDK. The conductor's
  resolver stays the seam; the SDK gets a `Model` object via
  `modelRegistry.find`, same as today.
- Does not add an "is this provider registered?" pre-flight check at
  manifest-load time. Out of scope; would change the validator's contract.

## Tasks

- [ ] **T2.1** Edit `src/host/production-host-resolve.ts`:
      - Remove the "more than one colon" branch in `splitProviderId` (lines
        87-90). Use the first colon as the separator; everything after is
        the id. Empty provider and empty id stay as `MalformedModelEntryError`
        (regression protection).
      - Update the JSDoc on `splitProviderId` (lines 79-81): the "Strict
        form: exactly one `:`" comment becomes "Strict form: at least one
        `:`, provider side non-empty, id side non-empty." Update the
        "Internal: … resolution contract" comment to reflect that the
        resolver is now first-colon, not single-colon.
      - Update the JSDoc on `resolveModel` (line 58-65) only if it claims
        "exactly one colon" — if it doesn't, no change needed.
- [ ] **T2.2** Edit `src/manifest/validate.ts`:
      - Tighten `PROVIDER_ID_FORM` to remove the now-redundant `:` from the
        id character class (change `[a-zA-Z0-9._:/-]+` to
        `[a-zA-Z0-9._/-]+`). Rationale: the runtime is the real gate; the
        regex should not promise a colon policy that the runtime doesn't
        enforce. Keep the validator's role (smoke test for `provider:id`
        *shape*) — just don't pre-allow colons in the id.
      - Update the inline comment on `PROVIDER_ID_FORM` (line 56-57) to
        explain: provider must start with a letter, id is
        `letters/digits/._-` plus `/`, no colons (the colon is the
        boundary).
- [ ] **T2.3** Edit `tests/host/production-host.test.ts`:
      - Remove the `{ name: "multiple colons (only one allowed)", entry:
        "anthropic:claude:x" }` case from the malformed-entries table
        (lines 282-310) — it no longer applies.
      - Add a positive test for multi-colon: `resolveModel("implementer",
        "ollama:robit/ornith:9b", registry)` returns
        `{ model, logical: "ollama:robit/ornith:9b" }` after registering
        a fake model under provider=`ollama`, id=`robit/ornith:9b`. Add a
        corresponding `find` spy assertion: `expect(findSpy).toHaveBeenCalledWith("ollama",
        "robit/ornith:9b")`.
      - Keep all the existing malformed cases (no colon, empty provider,
        empty id, empty string).
- [ ] **T2.4** Edit `tests/manifest/validate.test.ts` (only if a test
      exercises the regex's id-side colon): the existing
      `bare-model-alias` test uses `claude-sonnet` (no colon in id), so
      it still passes. Add a positive test asserting that
      `ollama:robit/ornith:9b` is NOT flagged — confirms validator and
      resolver agree.
- [ ] **T2.5** Edit `CHANGELOG.md`: add a new `## [Unreleased]` block
      at the top of the file (above `## [0.5.1] - 2026-06-26`, which
      is the current latest header) containing a `### Bug fixes`
      section. Use `### Bug fixes` — NOT `### Fixed` — to match the
      convention used in `[0.5.1]` and `[0.4.1]`. Suggested wording
      under `### Bug fixes`: "Allow `provider:id` entries with colons
      in the id (e.g. Ollama tags `ollama:model:tag`); the resolver
      now uses the first colon as the separator."

## Verification

- `pnpm test -- tests/host/production-host.test.ts` passes (resolver
  tests, including the new positive case for multi-colon).
- `pnpm test -- tests/manifest/validate.test.ts` passes (validator
  tests, including the new positive case for `ollama:robit/ornith:9b`).
- `pnpm typecheck` clean (no type changes expected, but verifies JSDoc
  edits didn't break anything).
- `pnpm lint` clean (Biome — verify the inline regex change passes
  format check).
- `pnpm test` (full suite) — no regression in the rest of the host /
  manifest / core suites.
- Manual smoke (optional, not a gate): the reporter's manifest from
  issue #3 now passes the §13 `bare-model-alias` check AND the runtime
  resolver; whether `modelRegistry.find("ollama", "robit/ornith:9b")`
  returns a registered model is a user-side concern, distinct from
  this fix.

## Out of scope

- A pre-flight "is this provider registered?" validator. Would change
  the §13 contract; defer to a separate enhancement.
- A better error message for `ModelNotFoundError` (e.g. naming the
  provider the user might have meant). Out of scope for this fix;
  the existing message names the role and the full entry, which is
  enough to debug.
- Changing the `bare-model-alias` test name or §13 wording. The rule
  ("not in `provider:id` form") is still right; we just changed what
  "form" means in one edge case.

## Risk assessment

Low. The change is strictly more permissive in the resolver (a case
that threw now returns). The validator's regex is tightened in a way
that *removes* a permissive character from the id class — but no
test or production code path exercises a manifest entry that relies
on a colon in the id being accepted by the *validator*; the old
regex accepting such entries was always going to fail at the
resolver. So the validator's behavior change is a no-op for real
manifests (it stops accepting what would have been rejected at
runtime), and a bug-fix in the resolver lets the previously-rejected
case through.
