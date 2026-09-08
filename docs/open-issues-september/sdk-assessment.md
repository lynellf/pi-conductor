# Issue #67 — public runtime API assessment

Checked 2026-09-08 against the latest published Pi release, **0.85.1**
([release](https://github.com/earendil-works/pi/releases/tag/v0.85.1)), using
`pnpm view @earendil-works/pi-coding-agent version repository --json` and the
upstream tagged source through `gh api`.

The blocker remains:

- [ExtensionContext](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/extensions/types.ts#L310)
  exposes `modelRegistry: ModelRegistry`; it does not expose a `ModelRuntime`.
- [ModelRegistry](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/model-registry.ts#L32)
  is a compatibility facade with a **private** `runtime`. Its complete public
  method list contains no runtime accessor.
- [SDK documentation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md)
  uses `ModelRuntime` and `createAgentSession({ modelRuntime })`. Constructing a
  new runtime does not prove preservation of the extension's configured runtime
  identity and dynamically registered providers.

Therefore the issue's first acceptance condition is not met. No compatible
trajectory spike or SDK upgrade was attempted, and no private-field bridge was
introduced. Keep #67 open. The exact 0.80.6 gate remains until a supported public
identity-transfer path and the complete trajectory compatibility spike pass.

This is a tagged-source/API assessment, not a live-provider test. The repository
URLs embedded in older docs point at `earendil-works/pi-coding-agent`; the package
registry identifies the actual current upstream as `earendil-works/pi`, with
package sources under `packages/coding-agent`.
