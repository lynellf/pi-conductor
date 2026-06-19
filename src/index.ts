/**
 * pi-conductor public entrypoint.
 *
 * Phase 1 (foundation): the barrel is intentionally minimal until the core types
 * (Task 2) and manifest surface (Tasks 3–4) land. Host-agnosticism invariant
 * (spec §12): `src/core` and `src/manifest` will import nothing from
 * `@earendil-works/pi-coding-agent`; enforced by `tests/grep-guard.test.ts`.
 */

export const PACKAGE_NAME = "pi-conductor";
