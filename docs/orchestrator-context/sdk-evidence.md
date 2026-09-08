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
`Usage`, and verifies that five preexisting assistant messages with `125`
historical tokens do not get charged again. A second case proves provider
failure is surfaced and does not append a compaction entry.

The SDK does not expose native compaction usage through `CompactionResult` or
the `session_compact` event. The minimal host seam therefore needs to wrap the
provider `StreamFunction` (or the shared SDK/RPC provider boundary), record the
returned assistant usage and failures, and leave session history reconstruction
to `SessionManager`. Imported history should be treated as already charged;
only newly observed provider responses enter the meter.
