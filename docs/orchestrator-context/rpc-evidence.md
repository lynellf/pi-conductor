# RPC compaction spike evidence

The focused spike in `tests/host/rpc/orchestrator-context-compaction-spike.test.ts`
starts the package-local Pi 0.80.6 CLI in RPC mode, loads the unique extension
fixture, and uses only the child process's public JSON-RPC protocol. The fixture
registers a local provider inside that child; it does not replace a user
provider or require a paid API.

## Proven

- The child starts with the host-selected session directory and target model
  passed through public CLI flags. `get_state` reports the created session file
  and `context-spike/context-spike-model`; a second child reopens that exact
  session path with the same public `--session` flag.
- The public `session_before_compact` extension hook runs in RPC mode.
- The hook can call the exported `compact` function with a stream adapter and
  return its `CompactionResult`; the persisted compaction succeeds.
- The stream adapter observes nonzero compaction usage (`19` input, `7`
  output, `26` total tokens). The evidence file also records a nonzero
  `tokensBefore` and messages selected for summarization, so imported history
  is not charged as the new compaction request.
- `get_session_stats` reports the imported assistant usage and cost before and
  after compaction. Cost, assistant-message count, and token totals remain
  unchanged; the context-usage estimate may change because compaction changes
  the active context.
- When the hook throws, the extension runner emits an actionable
  `extension_error`, the native compaction fallback completes successfully,
  and the child remains usable. This fallback is intentionally unmetered by
  the fixture, matching the unresolved accounting gap below.
- A caught failed assistant response records nonzero usage from the failed
  stream's `result()` and returns
  `{ cancel: true }`; the RPC response is unsuccessful and the native provider
  call count does not increase. A second run with missing usage records the
  explicit `unknown-usage` diagnosis after the stream throws before producing
  an assistant message, instead of treating it as zero.

## Remaining gap

This spike proves the public hook and exported-compaction path in an actual RPC
child, but it does not integrate context-retention lifecycle records, restart
provenance records, model fallback, or host-owned cost accounting. The restart
proof covers exact session-file reopening and imported history visibility, not
the future conductor resume protocol. The throwing-hook
case confirms native fallback behavior and error visibility; production code
must return `{ cancel: true }` when metered compaction fails or its usage is
unknown. Native fallback is only demonstrated here for a hook that throws
before the host-owned cancellation decision.

The API evidence is based on the pinned package-local documentation:

- `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md` (RPC commands and
  session selection)
- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
  (`session_before_compact` and extension error handling)
- `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` (public session
  and compaction APIs)
