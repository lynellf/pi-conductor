# Manifest-controlled delegation mode

Status: acknowledged by the repository owner on 2026-09-08; ready for implementation.
Baseline: main `54c482f`, following asynchronous delegation PR #83.
This revises the per-call mode contract in the acknowledged September #77 spec.

## Objective

Let the operator determine whether a role's delegation submissions block the
parent or return child handles immediately. The calling model must not be able
to override that policy. The user asked for configuration to ensure expected
behavior; the proposed interpretation is enforcement, rather than a configurable
model-overridable default.

## Proposed behavior

Add `mode: blocking | nonblocking` to each parent role's `delegation` policy:

```yaml
roles:
  - name: implementer
    max_visits: 3
    tools: [read, write, edit, handoff, end, delegate]
    delegation:
      mode: nonblocking
      allowed_subagents: [coder]
      max_children_per_session: 10
      max_parallel: 2
```

1. Mode is a per-role policy, independent of concurrency and total admission.
   The host selects the behavior from the pinned policy on every submission.
2. For newly started runs, omitted configuration resolves to `blocking`,
   preserving the existing omitted-mode behavior. All examples demonstrating
   asynchronous coordination explicitly configure `nonblocking`.
3. Models normally submit only `tasks`; they no longer choose the mode. The
   tool description states the effective behavior. A compatibility `mode`
   argument may only repeat the configured value; a contradictory value returns
   a clear error before new admission, worktree creation or spawning. The
   model-visible TypeBox schema constrains any retained compatibility field to
   the single configured literal, so it offers no alternative mode.
4. Blocking returns ordered results after settlement. Nonblocking returns stable
   child handles after durable acceptance. Controls `status`, `result`, `wait`,
   and `cancel` retain their existing behavior in either mode. An explicit wait
   is still available under nonblocking policy.
5. Pin the resolved mode in new run manifest snapshots. Changes to a manifest
   file do not change the policy during a run or across model fallback/resume.
6. The same enforcement and tool contract apply to shared SDK parents and
   isolated RPC parents. Transport wait/deadline selection uses trusted resolved
   policy rather than a model-supplied mode. Blocking submissions and explicit
   waits remain exempt from the implicit RPC response deadline.
7. Existing accepted submissions and terminal records retain their identities,
   raw argument fingerprints, handles, usage and results. Do not rewrite their
   logs, normalize historical fingerprints, or resubmit accepted tasks. Repeated
   delivery must never bypass existing idempotency or admit duplicate work.
8. Historical run snapshots without the field retain their legacy per-call mode
   semantics when resumed. This is an explicit historical compatibility rule,
   not an escape hatch for newly started runs. It must be derived from durable
   snapshot provenance, not supplied by a role or silently inferred from its
   arguments. Historical runs without a stored manifest snapshot must surface
   an actionable compatibility warning if their old mode policy cannot be proven.
   They must not silently switch the behavior of an already accepted submission.

## Compatibility and decisions for acknowledgment

- Enforce configuration; do not add an `allow_override` flag.
- Default newly started runs to blocking when the field is absent.
- Existing manifests that used call-level nonblocking mode must add
  `delegation.mode: nonblocking` before starting a new run with that behavior.
- Preserve existing run semantics through explicit historical resume handling;
  operator configuration controls all new runs.
- Keep matching legacy call arguments temporarily for compatibility; reject
  conflicting arguments with a correction naming the configured mode.

## System boundaries and style

The pure FSM, child file-tool/projection authority, scheduler capacity, admission
accounting, parent settlement ordering and single persistence/spawn owner stay
unchanged. This is a manifest/tool contract change, not a scheduler rewrite.

Use strict TypeScript, named exports, TypeBox, and pnpm/Biome. Keep new helpers
cohesive and below the repository module-size ceiling. Resolve policy once at
the trusted manifest boundary and pass it explicitly. For example:

```ts
export type DelegationMode = "blocking" | "nonblocking";
```

Always validate mode values, preserve pinned state and durable identities, and
verify shared/RPC behavior. A material departure from the behavior above needs
an updated specification and acknowledgment. Never introduce model overrides,
private SDK access, dependencies, or broader child permissions for this change.

## Implementation slices and verification

Implementation uses Luna; integration and independent review verify the result.
After this specification is acknowledged, execute these dependency-ordered slices.
Each slice requires focused tests and typecheck before the next one starts.

- [x] Policy contract: manifest types/parser/validation and a focused mode helper.
  Test both enum values, omitted default, invalid values and programmatic input.
- [x] Pinned run policy: snapshot creation and historical resume distinction.
  Test fresh defaults pinned explicitly, edited source ignored on resume,
  fallback stability, legacy snapshot behavior, and missing-snapshot diagnosis.
- [x] Shared tool: derive its schema/description and execution mode from policy.
  Test tasks-only blocking/nonblocking, matching compatibility values, conflicting
  values creating no admission, and unchanged raw identity fingerprints.
- [x] RPC configuration: carry trusted effective mode into the isolated process;
  reject malformed configuration and do not trust role-provided policy fields.
- [x] RPC tool/bridge: enforce the same schema and response behavior; test wait
  deadline selection, actual tool-call identity, response loss/redelivery, and
  policy mismatch without child creation.
- [ ] End-to-end regression: A/B/C coordination succeeds with mode configured
  only in the manifest and omitted from all submission arguments. Blocking
  returns ordered results; fallback/resume retain policy and spent allowance.
- [x] Update delegation/role configuration documentation, examples and changelog;
  independently review source and run all gates before merging.

Likely implementation areas: `src/manifest/`, `src/seam/schema.ts`,
`src/host/delegation/delegate-tool-factory.ts`, new focused host policy helpers,
run manifest snapshot loading/pinning, and `src/host/rpc/`. Keep tests in the
corresponding `tests/manifest`, `tests/host` and `tests/seam` directories.

Commands:

```sh
pnpm typecheck
pnpm build
pnpm exec vitest run tests/manifest/delegation-mode.test.ts
pnpm exec vitest run tests/host/delegation-mode.test.ts
pnpm exec vitest run tests/host/rpc/delegation-mode.test.ts
pnpm test
pnpm lint
pnpm format:check
pnpm audit --prod
```

The three focused mode test paths are planned new files. Existing delegation,
RPC, manifest snapshot/resume and persistence tests must remain green. No paid
provider run or package installation change is included in this specification.
