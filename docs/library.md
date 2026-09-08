# Advanced: library use

← [Back to README](../README.md#documentation)

## Contents

- [Advanced: library use](#advanced-library-use)

The pure FSM core + SDK host driver are importable as a library. The public API:

```ts
import {
  startRun,
  resumeRun,
  listRuns,
  createProductionHost,
  type Host,
  type HostFactoryContext,
  getDefaultBundle,
} from "pi-conductor";

const handle = await startRun(".pi/conductor.yaml", {
  goal: "Ship a changelog for the auth refactor.",
  hostFactory: (ctx: HostFactoryContext) =>
    createProductionHost({
      extension: { modelRegistry: /* pi's ModelRegistry */, cwd: process.cwd() },
      run: { log: ctx.log, loadedManifest: ctx.loadedManifest, runId: ctx.runId },
    }),
});

const { finalCheckpoint, exitReason } = await handle.completion();
```

While the run is live, library consumers can use the same control state as the
extension:

```ts
await handle.steer("Check the migration rollback path before continuing.");
await handle.followUp("Include the final verification commands in the response.");

const latest = handle.latestResponse();
console.log(latest?.role, latest?.text);
```

`steer` targets an addressable active role or queues at a role boundary.
`followUp` always queues for the next conductor prompt, so it follows a handoff.
`latestResponse()` returns assistant text and readable displayed reasoning while
excluding tool summaries. Clipboard access remains a UI concern.

`Host` is the seam between the pure loop and the pi SDK. It owns session
creation, event subscription + usage accumulation, the run-keyed log, and
per-session state. You can also implement a custom `Host` against the interface
in `src/host/host.ts` (six methods: `spawnRole`, `captureUsage`,
`persistRecord`, `seedRunMemory`, `abortSession`, `sealSession`, plus
`nextVisitIndex`, `sessionTerminalReason`, `getNextModel`, `runCostSoFar`).

The CLI is a thin example of this: `src/bin/conduct.ts` calls `startRun` with a
`hostFactory` that builds a `ProductionHost` from a fresh `ModelRegistry`. Read
it for a self-contained integration example.

Related page: [hooking into the record stream](record-stream.md#hooking-into-the-record-stream) describes the emitter available to library consumers.
