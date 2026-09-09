# Pi 0.80.6 compaction SDK evidence

The pinned `@earendil-works/pi-coding-agent` package is `0.80.6` in this
worktree. Its local public SDK documents and declarations establish these
boundaries:

- `DefaultResourceLoader` accepts `extensionFactories`; an inline extension can
  register `pi.on("session_before_compact", handler)`.
- `AgentSession.compact(customInstructions?)` runs manual native compaction and
  returns a `CompactionResult`.
- The exported `compact(preparation, model, apiKey, ..., streamFn)` function
  accepts a provider `StreamFunction`. The native implementation awaits the
  returned stream's `result()`, so a wrapper can meter the resulting assistant
  `Usage` without replacing the provider.
- `SessionManager.buildContextEntries()` and `buildSessionContext()` are the
  public history reconstruction APIs. `SessionManager.inMemory()` is sufficient
  for deterministic tests; `SessionManager.open()` is the durable resume path.

The focused spike test exercises the public loader hook and
`AgentSession.compact()` with the repository's real stub provider. It observes a
manual `session_before_compact` event, meters the actual summary stream's
`Usage`, and verifies that five preexisting assistant messages carrying
`30,000` tokens each do not get charged again. A second case proves provider
failure is surfaced and does not append a compaction entry. A dedicated hook
case invokes the exported `compact()` itself with a local metered stream while
the native provider is configured to fail, proving the seam does not globally
replace the user's provider. Failed assistant responses retain nonzero usage
(`22` tokens); unknown usage must remain an explicit diagnostic rather than
being coerced to zero. The durable case reopens the persisted session tip and
creates a new session with a model override; the override appends SDK state but
the original tip remains on the restored branch.

This spike does not claim RPC subprocess parity; that requires a separate
child-process fixture. The SDK does not expose native compaction usage through `CompactionResult` or
the `session_compact` event. The minimal host seam therefore needs to wrap the
provider `StreamFunction` (or the shared SDK/RPC provider boundary), record the
returned assistant usage and failures, and leave session history reconstruction
to `SessionManager`. Imported history should be treated as already charged;
only newly observed provider responses enter the meter.
