# Hooking into the record stream

← [Back to README](../README.md#documentation)

## Contents

- [Hooking into the record stream](#hooking-into-the-record-stream)
- [The public API](#the-public-api)
- [A consumer extension](#a-consumer-extension)
- [The optional `pi.events` bridge](#the-optional-pievents-bridge)
- [What this is not](#what-this-is-not)

pi-conductor persists every machine event, lifecycle event, and checkpoint
snapshot to a per-run JSONL log on disk — the durable system of record. It
also exposes a typed, **in-process emitter** that fans out the same records
to *separately installed* extensions in the same `pi` process. The emitter
is a read-side extension point: `pi-conductor` ships zero upload code, zero
network code, zero server config — just a public function a consumer can
call to register a listener and receive every record the host persists.

The intended consumer is a *separately installed* pi extension living in
`~/.pi/agent/extensions/` (per the pi extensions spec, "Extensions" — auto-
discovery). It is not part of `pi-conductor` and is not published alongside
it. The consumer owns auth, retry, batching, backpressure, and the durable
replay of anything the listener missed. The spec's only contract is
`subscribeToRecords` and the durable log.

### The public API

A single module-level function exported from `pi-conductor`'s public barrel:

```ts
import {
  subscribeToRecords,
  type PersistedRecord,
} from "pi-conductor";

const unsubscribe = subscribeToRecords((record: PersistedRecord) => {
  // Do whatever you want with the record. The host fires listeners
  // fire-and-forget — async listeners are NOT awaited. Errors thrown
  // from a listener (sync or async) are isolated and do not affect
  // the engine or other listeners.
});
```

`PersistedRecord` is the union from `src/persistence/log.ts`:
`transition_accepted`, `transition_rejected`, `session_started` /
`session_ended` / `session_failed`, `model_fallback`, `checkpoint_snapshot`,
and delegation's `delegation_submission_accepted`, `subagent_started`,
`subagent_completed`, and `subagent_failed` records, among other typed host
records. The emitter is a transparent fan-out of what the host persists.

For asynchronous delegation, acceptance is one atomic batch of stable handles
and pinned input fingerprints. It consumes admission but carries no usage.
Only `subagent_completed` / `subagent_failed` contribute terminal child usage;
status queries, notifications and result retrieval do not create another usage
record. Accepted queued cancellation/interruption has `session_file: null` and
`usage: null`. See [delegation recovery](delegation.md#settlement-and-recovery).

The contract — FIFO subscription order, fire-and-forget async delivery,
sync-throw and async-rejection isolation, re-entrant subscribe /
unsubscribe (effects take place on the next record), idempotent unsubscribe,
and the durable backstop pattern — is in
[`src/host/record-emitter.ts`](../src/host/record-emitter.ts) (the authority).

### A consumer extension

A minimal separately-installed extension at
`~/.pi/agent/extensions/conductor-uploader.ts`:

```ts
import {
  subscribeToRecords,
  type PersistedRecord,
} from "pi-conductor";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const serverUrl = process.env.CONDUCTOR_UPLOAD_URL;
  if (serverUrl === undefined) {
    pi.events.once("session_start", (_e, ctx) => {
      ctx.ui.notify(
        "conductor-uploader: CONDUCTOR_UPLOAD_URL not set; extension disabled",
        "warning",
      );
    });
    return;
  }

  // Live delivery: every record the host persists goes to the server.
  subscribeToRecords(async (record: PersistedRecord) => {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  });

  // Backstop: on session_start, walk the log dir to ship records the
  // listener might have missed (consumer's watermark strategy lives in
  // this extension's own state file; the durable log is read via the
  // FileRecordLog implementation in pi-conductor's persistence module).
  pi.events.on("session_start", async () => {
    /* replayMissedRecords(serverUrl) — consumer-private */
  });
}
```

This sketch is informative only. The full consumer concern — auth, retry,
batching, watermark, and error policy — is the consumer's responsibility.
The spec's only commitment is that `subscribeToRecords` and the durable log
are sufficient to recover any record the emitter might have missed.

### The optional `pi.events` bridge

The `pi-conductor` extension additionally re-emits every record to pi's
documented event bus:

```ts
pi.events.on("conductor:record", (record) => { /* ... */ });
```

This is a thin wrapper over `subscribeToRecords` in `extensions/conduct.ts`
for consumers that prefer the `pi.events` API. Consumers that import
`subscribeToRecords` directly do not need the bridge. See the spec §8.5
note in [`src/host/record-emitter.ts`](../src/host/record-emitter.ts) for
the rationale.

### What this is not

- **No upload code in `pi-conductor`.** No HTTP, no fetch, no network
  primitives. The grep-guard test
  (`tests/grep-guard.test.ts`) scans `src/host/` for the
  `@earendil-works/pi-coding-agent` import allowlist; the emitter does
  not change that surface.
- **No server config, no auth, no URL.** The consumer owns all of that.
- **No batching, no debouncing, no rate-limiting in the host.** The host
  fires every record to every listener. The consumer is free to batch on
  its side.
- **No promise of guaranteed delivery.** The emitter is best-effort; the
  durable JSONL log is the system of record for missed-record recovery.
- **No cross-process or cross-host coordination.** Each `pi` process has
  its own registry. The consumer is responsible for cross-process
  de-duplication (typically by record index or hash, using the per-run
  JSONL file as the source).
- **No emitter-specific record types.** The emitter is a transparent fan-out
  of the existing `PersistedRecord` union, including delegation records when
  delegation is enabled.
- **No change to the orchestration loop.** The host's `persistRecord` is
  the chokepoint; the loop does not need to know the emitter exists.

Related authority: [`docs/record-emitter-spec.md`](record-emitter-spec.md).
