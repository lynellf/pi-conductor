# Orchestrator context retention implementation plan

Approved contract: [spec.md](spec.md), acknowledged on 2026-09-08.
Implementation baseline: `origin/main` at `7592fa4`. Luna owns implementation;
the coordinating agent owns integration and independent review. Work only in
`/tmp/pi-conductor-context-retention`; the original working tree is preserved.

## Ordered increments

### 1. Policy and SDK feasibility (independent work)

- [x] Parse and validate `context_retention: none | run`, defaulting new manifests
  to explicit `none`; historical absence means `none`.
- [x] Reject worker retention, invalid values, trajectory combinations and Prewalk
  orchestrator retention; permit Prewalk workers.
- [ ] Demonstrate public Pi 0.80.6 compaction metering using deterministic providers,
  including failure usage and exclusion of imported historical usage, in SDK/RPC.
- [ ] Record exact session-tip restoration and model-rebinding SDK evidence.

Files: manifest types/parser/validation and focused helper/tests; separate SDK
spike tests and evidence document. Verification: focused Vitest, strict typecheck,
Biome, build. No lifecycle integration until the metering proof passes.

### 2. Durable context contract

Depends on increment 1 and review of exact SDK history semantics.

- [ ] Define append-only context policy/epoch, selection/delivery, boundary and
  compaction records with pure validation and explicit run/role identities.
- [ ] Define restoration queries that distinguish a durable empty epoch from
  missing, corrupt, mismatched or ambiguously committed history.
- [ ] Test record round trips, run isolation, reset epochs, duplicate delivery and
  crash ordering. Register records in the existing persistence union/parser.

Keep schemas/queries independent of Pi; host-only helpers own filesystem checks.
Verification: focused persistence tests, typecheck, build, Biome; independent
review before adapter integration.

### 3. Exact SDK context restoration and metering

Depends on increment 2. Implement as separate small commits:

- [ ] Restore the exact committed branch through supported SessionManager APIs;
  validate file/conversation/tip integrity and complete tool exchanges first.
- [ ] Bind the current role prompt, tools, model and thinking level, preserving
  historical context without importing historical charges or worker transcripts.
- [ ] Pin effective compaction settings, account every compaction request, and
  surface disabled/failed/insufficient compaction before an oversized prompt.

Each helper receives explicit inputs. Tests use real temporary session files and
stub providers. Verification per commit: focused tests, typecheck, build, Biome.

### 4. Shared host lifecycle and resume

Depends on increment 3. Split adapter wiring, lifecycle boundaries and API resume
into separately verified commits.

- [ ] Start empty epochs durably; select retained context for each orchestrator
  invocation and record seed delivery once with a fresh logical invocation ID.
- [ ] Commit a reusable boundary only after tools, delegated children and process
  cleanup settle. Preserve append/reduce/terminal ordering and error precedence.
- [ ] Prove orchestrator/worker/orchestrator continuity, fresh independent runs,
  current authority, and absence of repeated tool side effects.
- [ ] Prove restart, model fallback and child allowance persistence. Diagnose
  unresolved or ambiguous execution before prompting.
- [ ] Add idle-run reset to the existing extension resume and library API; enforce
  the run lease and preserve FSM, costs, visits and accepted work.

Verification: focused host/resume/fallback/delegation/abort/end-guard tests,
strict typecheck, build, Biome; independent lifecycle review.

### 5. Isolated RPC parity

Depends on the shared lifecycle contract. Separate trusted configuration and
session startup from child metering/settlement implementation.

- [ ] Carry only trusted context references/settings into the RPC process; restore
  the exact host-selected history and retain current model/tool authority.
- [ ] Report invocation-only usage plus compaction usage, including failures;
  persist context only after child tools and processes are settled.
- [ ] Prove actual process restart and context continuity, corrupted selections,
  fallback, and cleanup/accounting parity with the shared path.

Verification: real package-local RPC child tests with stub providers, focused
transport tests, typecheck, build, Biome; independent transport review.

### 6. Operator surfaces and completion

- [ ] Expose references and compaction/reset status without ordinary transcript
  dumps; document configuration, reset and transport restrictions with examples.
- [ ] Update changelog and the spec checklist using only completed evidence.
- [ ] Independent final review; resolve findings without unrelated cleanup.
- [ ] Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
  `pnpm format:check`, and `pnpm audit --prod`; mandatory pre-push hooks remain on.
- [ ] Create and merge the reviewed PR, close #87, and assess the resulting main.

## Risks and implementation constraints

The critical boundaries are settled tool history, append ordering around a crash,
exact selected session tips, and usage incurred during compaction failures.
Never recover by selecting the newest session file or replaying historical tools.
A missing expected boundary must be an actionable diagnosis, not an empty default.
Model fallback and reset must preserve durable delegation admission accounting.

Use public pinned SDK APIs, no SDK upgrade or dependencies, TypeBox only, strict
TypeScript, named exports and public JSDoc. Keep new modules around 400 lines;
documented coherent exceptions stay below 500. Existing large adapters may need
small responsibility-based extraction when this feature would exceed the ceiling.
No paid provider run, cross-run memory, or unrelated #88 refactors are included.
