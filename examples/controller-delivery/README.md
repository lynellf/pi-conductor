# Controller delivery example

This no-model example covers the issue #116 delivery boundaries with synthetic
native executions and production stores, publication coordination, dispatcher,
Git implementations, artifact validation, and remote transport. Each native
child writes `reports/review.txt` containing exactly `review: approved` and a
bounded patch. Those sealed bytes are readable by the fixed reviewer adapter;
the controller cannot read them. `review.mjs` executes over the stored bytes
and emits the closed patch-evidence document accepted by production parsing.

Child A starts and stays unresolved while child B reaches a durable terminal,
publishes its report and patch, and is reviewed from immutable references. A is
released and published afterward. Their patches modify separate lines in the
same file from the same accepted base, exercising compatible overlapping patch
integration. The fixed validator rereads the selected-source artifact and
checks its exact head and bytes. Its closed result is stored with a valid
artifact binding before promotion and delivery. The authenticated endpoint
holds its response while the production dispatcher durably admits and finishes
a successor child. The delivery then completes and is reconciled by its
idempotency key. Prepared Git and remote intents are retained in the test
journal. No external service or paid model is used.

[controller.yaml](controller.yaml) is a repository-side request-graph template:
its chooser executable paths are placeholders that the operator replaces with
their approved repository-local programs. The complete runnable policy is the
[delivery smoke test](../../tests/host/controller-delivery-example.test.ts).
The template's graph is: the
reviewer produces review evidence, `choose-integrate` emits an integration
request, the validator checks the selected source, and the final two adapters
emit promotion and delivery requests. It is not a deployable operator approval:
the host must separately pin those executables, schemas, repository identity,
effect implementations, exact protected refs, endpoint, and credential source.
The example does not support arbitrary commands, arbitrary remote URLs, direct
child publication to the controller, or replaying an uncertain effect.
The chooser adapters route sealed references and effect requests; they do not
read private child reports, patches, or selected source bytes.

The smoke records monotonic `output_ms`, `integration_ms`, and `delivery_ms`
measurements around those operations, requires positive ordered durations under
the test deadline, and prints their actual numeric values. Run
`pnpm vitest run tests/host/controller-delivery-example.test.ts --reporter=verbose`
to capture the measurement JSON.

To migrate an operator configuration, add one `child_outputs` entry for each
native producer, grant the fixed reviewer adapter (not the controller) access
to its reports and patch, and pin that adapter plus `git_integrate`,
`git_promote`, and `deliver_ref` effect grants in controller approval. Each
report is limited to 128 KiB, each patch to 512 KiB, and a publication to 16
outputs / 1 MiB. Configure the reviewer output schema as
`delivery-review-v1`, configure the validator output schema as
`delivery-validation-v1`, restrict integration and target refs, name an
explicit protected credential source, and preserve the prepared-effect journal
for restart reconciliation. A completed child is never approval: patch evidence
must bind each patch digest, and validator evidence must bind the exact
integrated head before promotion or delivery.
