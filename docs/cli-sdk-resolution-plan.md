# CLI SDK resolution repair

This repairs the existing Phase 7C.3 standalone CLI contract. The host boundary
remains as specified in `archive/orchestrator-fsm-spec.md` §12; pi packages stay
peers as required by `archive/publishing-readiness-spec.md`.

## Evidence and assumptions

- Pi 0.80.6's package manager uses `--legacy-peer-deps` for managed npm
  installations. Its extension loader supplies aliases for host-owned peers.
- Plain Node execution of the installed `dist/bin/conduct.js` reproduces
  `ERR_MODULE_NOT_FOUND` before argument parsing.
- The CLI should use an explicit `PI_PACKAGE_DIR`, otherwise a package-local
  SDK, otherwise the npm Pi installation behind the first executable `pi` on
  `PATH`. An invalid explicit override or selected installation is an error.
- Keep resolution scoped to conductor's runtime imports of declared Pi peers,
  including their subpaths. Preserve ordinary dependency resolution, the public
  `runCli` export, and the extension's existing loader behavior.
- Support an importable on-disk Node SDK. Shell wrappers or bundled binaries
  without a discoverable SDK require `PI_PACKAGE_DIR`.
- Verification against installed Pi 0.85.1 exposed the removal of the public
  `AuthStorage` export and `ModelRegistry.create`. The CLI must construct its
  registry through `ModelRuntime.create` on newer SDKs, retaining the pinned
  0.80.6 factory path. The test-only `StubHost` must access its legacy auth
  factory lazily so its barrel export does not prevent native ESM loading.

Sources: [Pi package manager](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/src/core/package-manager.ts),
[Pi extension loader](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/src/core/extensions/loader.ts),
[Pi 0.85.1 SDK model runtime](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md#model),
[Node synchronous resolution hooks](https://nodejs.org/download/release/v22.18.0/docs/api/module.html#customization-hooks).
Node requires dynamic import after hook registration; hooks are available before
the repository's Node 22.19.0 minimum.

## Repair and verification

One bounded implementation slice; no machine state or orchestration changes.

- [x] Add a packed CLI reproduction outside the checkout with no installed SDK
  peer; confirm the current launcher fails.
- [x] Bootstrap peer resolution before importing the CLI implementation; verify
  PATH discovery, explicit override, local peers, symlink invocation, and useful
  errors for missing or invalid SDK installations.
- [x] Verify a credential-free invocation reaches normal CLI validation and
  that peer subpaths and unrelated dependency errors retain their semantics.
- [x] Verify registry startup with both Pi 0.80.6 and 0.85.1 on Node 22.19.0
  and 26.5.0; the real packed test must cover both SDK factory paths.
- [x] Update CLI documentation and changelog.
- [x] Run focused regressions, typecheck, build, full tests, lint/format, audit,
  and review the final diff.
- [x] Commit the verified repair.

## Verification record

- The packed reproduction failed with the reported `ERR_MODULE_NOT_FOUND`
  before bootstrap implementation. Additional regressions demonstrated the
  public API invocation, synthetic-argv import, missing SDK export diagnostic,
  and Pi 0.85.1 auth/registry startup failures before their fixes.
- Ten packed cases cover PATH discovery, explicit SDK selection, bin symlinks,
  programmatic import/invocation, missing/invalid SDKs, peer subpaths and
  TypeBox identity, unrelated dependency errors, and local peer discovery.
  All ten passed in each of the four Node/Pi combinations listed above.
- The CLI behavior and reconciliation tests target the moved implementation; native resolver
  behavior runs in subprocesses because Vitest's transformed `import.meta`
  does not expose Node's `resolve` method.
- Typecheck, build, lint, and format checks passed. Audit found no high or
  critical advisories; existing development dependencies have two moderate
  Vitest/mocker advisories and one low esbuild advisory. Dependencies and the
  lockfile are unchanged.
- Independent code review approved the final bootstrap and registry adapter.
  `StubHost` remains a test fixture for the pinned SDK; its legacy auth access
  no longer prevents modern production consumers from importing the barrel.
- Final full suite: 205 files and 2,152 tests passed. Typecheck and lint also
  passed after updating both CLI unit-test imports to the moved implementation.
- Verification is credential-free startup and CLI behavior. Provider-backed
  model execution and different concurrent SDK selections within one process
  are outside this repair's verification scope.
