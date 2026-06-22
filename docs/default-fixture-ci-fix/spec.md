# Spec: Default Fixture CI Fix

## What I found

- `tests/host/defaults.test.ts` loads the default bundle through `src/host/defaults.ts`.
- `src/host/defaults.ts` reads `tests/fixtures/default-conductor/.pi/conductor.yaml` and two prompt files under `.pi/roles/` using `readFileSync(join(process.cwd(), ...))`.
- The fixture files exist locally, and `pnpm test tests/host/defaults.test.ts` passes locally.
- `git ls-files tests/fixtures/default-conductor` returns no files.
- `git check-ignore -v` shows the fixture files are ignored by `.gitignore` line `\.pi/`.
- Therefore CI fails because a clean checkout does not contain the untracked ignored fixture files.

## Objective

Make CI green for `tests/host/defaults.test.ts` by ensuring the existing default conductor fixture is present in clean checkouts, without changing loader behavior or unrelated runtime behavior.

## Scope

In scope:
- Track the existing default fixture files under `tests/fixtures/default-conductor/.pi/`.
- Add the narrow `.gitignore` exception needed for this test fixture.

Out of scope:
- Changing `src/host/defaults.ts` path resolution.
- Moving the fixture directory.
- Embedding default YAML/prompts in TypeScript.
- Changing test expectations, manifest semantics, or package publishing behavior.

## Success Criteria

- `git ls-files tests/fixtures/default-conductor/.pi` lists:
  - `tests/fixtures/default-conductor/.pi/conductor.yaml`
  - `tests/fixtures/default-conductor/.pi/roles/orchestrator.md`
  - `tests/fixtures/default-conductor/.pi/roles/worker.md`
- `git check-ignore` no longer reports these three fixture files as ignored.
- `pnpm test tests/host/defaults.test.ts` passes from the repository root.
- Full `pnpm test` passes before handing off implementation.

## Boundaries

- Always: keep the exception limited to this fixture path.
- Ask first: any change to the loader, package `files`, or public defaults API.
- Never: blanket-unignore all `.pi/` directories or commit runtime `.pi/` state.

## Summary of changed

Initial spec created after investigation; root cause identified as ignored/untracked fixture files, not a loader logic defect.
