# Fixed local Forge provider

`provider.mjs` is a deliberately small example of a trusted local effect provider. An operator measures the Node executable and this file, then fixes both the program and its Forge API origin in a `local_program` grant. A request only chooses a registered operation, reviewed Git subject, evidence, and schema-checked payload.

The provider uses a normal Forge-style HTTP API: it creates or reads a pull request, observes its checks, and requests a merge after it reads the exact reviewed head and a passing check. It is not a bridge to the legacy delivery effect. The test fixture starts a loopback fake Forge with request counters and gates so the provider exercises this API without a live service.

The provider accepts the broker's closed stdin protocol. It never reads an endpoint, executable, environment, credential source, or authority from the request. The broker resolves private credentials and evidence just before spawning it, and uses `inspect` after any ambiguous write attempt. The `publish_crash_after_remote` operation exists only to demonstrate that recovery inspects the Forge state instead of replaying a write.

Run the controlled acceptance fixture with:

```sh
pnpm exec vitest run tests/host/controller-local-effects-example.test.ts
```

Its registration measures the canonical Node executable and the copied `provider.mjs` SHA-256, then sets `runtime.digest` with `localProgramRuntimeDigest(runtime)` and `implementation_digest` with `localProgramImplementationDigest(provider, hostDriverDigest)`. Each registered operation uses a closed input schema `{ pr_key, request_tag }` and a result schema `{ stage, pull_request_id, head, merged }`; production registrations should replace the loopback origin and test credential with the operator's exact Forge origin and credential-source ID.

`request_tag` distinguishes a newly planned observation action from a retry. The controller keeps a tag stable when it reconciles a prior action and creates a new tag only after it waits and schedules another observation. The broker deduplicates an identical already-applied logical request. The provider's stable `pr_key` still makes separate tagged publish actions reuse the same Forge pull request.
