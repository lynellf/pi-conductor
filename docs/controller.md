# Sandboxed repository controllers

Controller mode replaces the orchestrator model session with a repository-owned,
operator-approved executable. The executable decides when to delegate native
subagents, run declared adapters, read results, wait, finish, or escalate. The
host still owns durable records, child admission, sandboxing, artifact
publication, concurrency, cost enforcement, cleanup, and final FSM transitions.

Controller mode is opt-in and Linux-only because every planner and adapter
invocation uses the approved Bubblewrap backend. There is no unsandboxed
fallback and no automatic fallback to an orchestrator model.

See [`examples/controller`](../examples/controller) for a complete manifest and
fixed-argv planner/adapter pair. The example planner prepares an artifact,
delegates one native worker, validates both the artifact and the worker's
durable terminal record, reads the validation result, and finishes.

## Configure the manifest

Add one top-level `controller` mapping to a version 1 manifest:

```yaml
version: 1
controller:
  protocol_version: 1
  controller_id: packet-controller
  runtime_id: controller-example-v1
  executable: /usr/bin/node
  argv: [/opt/pi-conductor-example/planner.mjs]
  adapters:
    - id: prepare
      runtime_id: controller-example-v1
      executable: /usr/bin/node
      argv: [/opt/pi-conductor-example/adapter.mjs]
      input_schema_id: adapter-input-v1
      output_schema_id: packet-v1
      capability: private_staging
  delegation:
    allowed_subagents: [worker]
    max_children_per_session: 1
    max_parallel: 1
  limits:
    planner_deadline_seconds: 30
    max_outstanding_adapters: 1
    max_decisions: 10000
    max_actions: 10000
    max_outstanding_actions: 64

roles:
  - name: orchestrator
    is_orchestrator: true

subagents:
  - name: worker
    models: [openai:gpt-4o]
    max_session_cost_usd: 2
    system_prompt: .pi/subagents/worker.md
    completion_protocol: minimal
```

The controller executable and `argv` are literal values. The host never invokes
a shell and the controller cannot choose another program at runtime. Each
adapter is also a fixed program and has one capability:

- `read_only` receives approved immutable inputs and publishes its bounded
  stdout as a host artifact.
- `private_staging` may write only its private action output directory. It must
  create `/workspace/output/result.json` and emit a JSON acknowledgment whose
  only member is `{"output":"result.json"}`. The host validates the declared
  output schema before publication.

`input_schema_id` and `output_schema_id` name schemas in the operator registry,
not files selected by the repository. Omitted limits use the values shown above.
The schema permits a planner deadline from 1 through 120 seconds, one through
four outstanding adapters, and at most 64 outstanding actions.

Controller manifests are coordinator-only. Declare one orchestrator role as the
FSM coordinator, but do not give it `models`, `max_session_cost_usd`, `tools`,
`context_retention: run`, or `delegation`. Do not declare FSM worker roles or
`end_request_roles`. Native work belongs under `subagents`, and
`controller.delegation.allowed_subagents` limits which profiles the planner may
submit. `max_run_cost_usd`, subagent model/session caps, workspace rules, tool
execution policies, and the normal end reducer remain effective.

## Create operator approvals

Controller execution requires two independent host approvals:

1. The existing Bubblewrap approval authorizes the reviewed sandbox binary,
   bootstrap probe, namespace behavior, and prepared-runtime mechanism.
2. A controller approval registry authorizes complete runtime inventories,
   controller programs, adapters, capabilities, and JSON schemas.

The repository manifest requests entries from the controller registry. It
cannot create or expand operator authority. A registry has this closed shape:

```json
{
  "schema_version": 1,
  "approval_id": "controller-example-approval-v1",
  "runtimes": [
    {
      "runtime_id": "controller-example-v1",
      "source_root": "/srv/pi-conductor/controller-example-runtime",
      "inventory_sha256": "<64 lowercase hex characters>",
      "bootstrap_approval": {
        "approvalId": "controller-example-bootstrap-v1",
        "files": [
          { "path": "bin/bash", "sha256": "<64 lowercase hex characters>" },
          { "path": "usr/bin/node", "sha256": "<64 lowercase hex characters>" },
          {
            "path": "opt/pi-conductor-example/planner.mjs",
            "sha256": "<64 lowercase hex characters>"
          },
          {
            "path": "opt/pi-conductor-example/adapter.mjs",
            "sha256": "<64 lowercase hex characters>"
          }
        ]
      }
    }
  ],
  "controllers": [
    {
      "controller_id": "packet-controller",
      "runtime_id": "controller-example-v1",
      "executable": "/usr/bin/node",
      "argv": ["/opt/pi-conductor-example/planner.mjs"]
    }
  ],
  "adapters": [
    {
      "id": "prepare",
      "runtime_id": "controller-example-v1",
      "executable": "/usr/bin/node",
      "argv": ["/opt/pi-conductor-example/adapter.mjs"],
      "input_schema_id": "adapter-input-v1",
      "output_schema_id": "packet-v1",
      "capability": "private_staging"
    },
    {
      "id": "validate",
      "runtime_id": "controller-example-v1",
      "executable": "/usr/bin/node",
      "argv": ["/opt/pi-conductor-example/adapter.mjs"],
      "input_schema_id": "adapter-input-v1",
      "output_schema_id": "packet-v1",
      "capability": "private_staging"
    }
  ],
  "schemas": [
    {
      "schema_id": "adapter-input-v1",
      "schema_digest": "<canonical schema SHA-256>",
      "schema": { "type": "object" }
    },
    {
      "schema_id": "packet-v1",
      "schema_digest": "<canonical schema SHA-256>",
      "schema": { "type": "object" }
    }
  ]
}
```

Replace every placeholder with the digest produced for the actual runtime or
canonical schema. The runtime inventory is complete rather than an allowlist of
entry points; it must include `bin/bash`, every executable, script, library, and
data file needed by the fixed programs. Prepare and review it with the same
immutable runtime process described in
[sandboxed delegation](delegation.md#bubblewrap-command-sandbox-issue-106).
pi-conductor validates an inventory supplied by the operator; it does not bless
or generate one from a repository request.

From a built pi-conductor checkout, an operator can measure the runtime with the
same no-follow traversal and canonical digest implementation used by admission:

```bash
RUNTIME_ROOT=/srv/pi-conductor/controller-example-runtime \
node --input-type=module <<'NODE'
import { inventoryRuntimeTree } from "./dist/host/execution/sandbox/runtime-files.js";
import { preparedRuntimeInventoryDigest } from "./dist/persistence/sandbox-runtime.js";

const inventory = await inventoryRuntimeTree(process.env.RUNTIME_ROOT);
const files = inventory
  .filter((entry) => entry.type === "file")
  .map(({ path, sha256 }) => ({ path, sha256 }));
console.log(JSON.stringify({
  inventory_sha256: preparedRuntimeInventoryDigest(inventory),
  files,
}, null, 2));
NODE
```

Run `pnpm build` first when measuring from a source checkout. Review the complete
sorted output and copy `inventory_sha256` and `files` into the registry; do not
pipe unreviewed measurements directly into an approval file. This checkout-local
measurement script uses internal modules and is an operator procedure, not a
published embedding API.

Store the controller registry outside repository-writable paths. Its path must
be absolute and canonical. The file must be owned by the current user, be a
regular file with one hard link, and have mode `0600`:

```bash
chmod 600 /absolute/operator/controller-approval.json
```

The loader rejects a changed or replaced file while reading it. Removing an
entry or changing the registry later revokes new planner, adapter, and native
preparation operations. Work already admitted remains owned by the activation
and follows its normal terminal/cleanup path.

## Start and resume

For the standalone CLI, pass both approvals:

```bash
conduct \
  --sandbox-approval /absolute/operator/sandbox-approval.json \
  --controller-approval /absolute/operator/controller-approval.json \
  .pi/conductor.yaml \
  "Run the repository controller"
```

For the Pi extension, configure the corresponding Pi flags and use the normal
commands:

```text
pi --conduct-sandbox-approval /absolute/operator/sandbox-approval.json \
   --conduct-controller-approval /absolute/operator/controller-approval.json

/conduct Run the repository controller
/conduct:resume RUN_ID
```

The standalone CLI starts runs; resume is currently provided by the Pi
extension. Resume reopens the pinned run definition and requires the same
approved runtime and live registry authority. It assigns a new activation ID
and owner epoch only after recovery proves that the previous activation can be
continued. It does not create a Pi conversation for the controller coordinator.

## Planner protocol and scheduling

On every invocation, the planner receives one bounded JSON request on stdin and
must emit exactly one JSON response on stdout. Both use protocol version 1 and
carry the run, controller, definition, activation, owner epoch, state revision,
and event cursor identities. The request also includes durable events, pending
operations, current controller state, and native capacity. A response repeats
the observed identities and chooses one decision:

- `plan` commits one through 64 typed `delegate`, `adapter`, `read`, or `cancel`
  actions.
- `wait` consumes the current event page and sleeps until the host has new
  durable input.
- `finish` supplies the ordinary `end` payload. The existing reducer and end
  gates decide whether the run may finish.
- `escalate` supplies a reason and nonempty evidence references. The activation
  fails and owned work is closed; no model coordinator is substituted.

Requests and responses have a 1 MiB JSON ceiling, maximum depth 32, at most 128
events per page, and controller state up to 64 KiB. Planner stderr is retained
as bounded diagnostic evidence. Malformed, oversized, stale, or identity-mismatched
responses execute no new action.

The planner owns repository-specific ordering and semantic gates. The host
commits a decision before dispatching its actions, applies concurrency and
lifetime child limits, verifies references, reloads live operator authority,
and records accepted and terminal receipts. An action may consume only artifacts
that already exist; express dependencies across planner invocations by waiting
for the durable action-terminal event. Child output and model prose remain data,
never control instructions.

The supported embedding surface exports the controller configuration and
protocol schemas, bounded JSON codecs, metrics snapshot types, protected
registry loader/validator, and operator action repair function from the package
root. Production applications should construct the ordinary host and provide a
live loader:

```ts
import {
  createProductionHost,
  loadControllerHostApproval,
} from "pi-conductor";

const controllerApprovalPath = "/absolute/operator/controller-approval.json";

const host = createProductionHost({
  extension: {
    modelRegistry,
    cwd,
    sandboxHostApproval,
    loadControllerHostApproval: () =>
      loadControllerHostApproval(controllerApprovalPath),
  },
  run: { log, loadedManifest, runId, sessionDir },
});
```

Call the loader for every request as shown. Passing a previously loaded object
would snapshot authority and prevent the host from observing operator
revocation. The dispatcher, activation fence, runtime store, and recovery pump
are host internals rather than embedding APIs.

## Observe controller runs

`RunHandle.runStats().controller` exposes the controller activation identity,
owner epoch, capacity, idle intervals, and phase latency samples as a
`ControllerMetricsSnapshot`. The phase boundaries are:

- child terminal record to the next planner `tool_execution_started` record;
- planner `tool_execution_started` to its `tool_execution_finished` record
  (`controller-duration` excludes host setup outside that execution);
- validated planner result, durably identified by its committed decision, to
  native delegation acceptance;
- native delegation acceptance to `subagent_started`;
- adapter or preparation `tool_execution_started` to its matching terminal;
  and
- the runtime-capture hook pair bound to that exact preparation execution.

Idle intervals start and stop when durable child lifecycle records change free
parallel capacity. Live durations use a monotonic process clock. On resume, the
snapshot retains bounded history from earlier activations and replaces replayed
samples only when their durable endpoint identities match a live sample.
Historical and cross-process intervals cannot reconstruct elapsed time, so they
use `durationMs: null` and `restartBoundary: true` rather than subtracting
unrelated clocks. Latency and idle sample histories each retain at most the
latest 128 samples.

Capacity keeps lifetime admission and current execution separate:
`accepted` counts children admitted during the controller lifetime,
`remainingAllowance` is the remaining lifetime child allowance, `running` is
the current number of executing children, and `free` is current parallel
capacity. `eligible` is `true`, `false`, or `"unknown"` when the host cannot
derive whether useful work was available.

Controller snapshots always report `coordinatorModelTurns: 0`. Extension status
therefore shows the controller ID and native `running/maxParallel` capacity
instead of a default coordinator model. Native subagent model usage and costs
remain in the ordinary run statistics.

## Recover uncertain effects

A crash or lost cleanup observation can leave an executable operation or
controller action uncertain. Resume refuses to replay it because private effects
may remain. Inspect the exact execution first:

```bash
conduct reconcile-tools \
  --log-dir /absolute/run-log \
  RUN_ID \
  --execution EXECUTION_ID
```

After independently verifying that the original namespaces, processes, writers,
and private effects are settled, record that inspection:

```bash
conduct reconcile-tools \
  --log-dir /absolute/run-log \
  RUN_ID \
  --execution EXECUTION_ID \
  --confirm-cleanup \
  --note "inspected retained staging and stopped all original writers" \
  --partial-effects inspected_unpublished
```

Then repair the owning controller action only after every related execution is
resolved and native children have authoritative terminal records:

```bash
conduct reconcile-tools \
  --log-dir /absolute/run-log \
  RUN_ID \
  --action ACTION_ID \
  --confirm-cleanup \
  --note "verified no publishable result; planner must choose fresh work" \
  --partial-effects none_observed
```

`--partial-effects` accepts `none_observed`, `inspected_unpublished`, or
`immutable_publication_verified`. These attestations never assert that an
interrupted action succeeded and never replay work. After reconciliation, use
`/conduct:resume RUN_ID` with both live approval flags still configured.

## Migrate an existing manifest

Existing model-driven manifests continue to use SDK orchestrator sessions and
need no change. To opt a repository into controller mode:

1. Move coordinator scheduling and gates into a deterministic fixed-argv
   planner. Keep native agent definitions under `subagents`.
2. Replace the orchestrator's model, tools, session-cost, retained-context, and
   delegation fields with the top-level `controller` mapping.
3. Register complete immutable runtimes, fixed programs, adapter capabilities,
   and schemas in the protected operator registry.
4. Preserve the run cost cap, subagent caps, workspace projections, command
   policies, and child completion protocols you still require.
5. Start a new controller run. Existing SDK logs retain their original session
   origin and resume behavior; a manifest change does not convert an existing
   run into controller mode.

Controller mode keeps the same host-owned append-only run log, native admission,
artifact ownership, cost records, terminal reducer, abort path, and uncertain
effect repair policy. The repository executable supplies scheduling decisions;
it does not become the authority for those mechanisms.
