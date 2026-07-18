# Spec: Authorized end requests and reliable handoff contracts

**Status:** Acknowledged by overseer on 2026-07-17 — implementation authorized.

## 1. Objective

Make run completion an explicit, enforceable workflow decision while making the
model-facing `handoff` tool difficult to call incorrectly.

Two changes ship together:

1. An optional manifest allowlist names worker roles that may request run
   completion. A configured reviewer or OKF curator can request completion while
   handing control back to the orchestrator; an implementer cannot.
2. The `handoff` tool exposes its real required fields, legal status values,
   routing constraints, and end-request semantics directly in the TypeBox schema,
   tool description, correction result, and no-emission recovery prompt.

The orchestrator remains the only role that transitions the FSM to `done`. A
worker's end request is evidence authorizing that transition, not a direct worker
transition to `done`.

## 2. Terminology and authority

- **End-request role:** a declared worker named in `end_request_roles`.
- **End request:** an accepted worker-to-orchestrator `handoff` with
  `request_end: true` and `status: complete`.
- **Pending end request:** pinned checkpoint state recording the authorized role
  whose accepted handoff most recently requested completion.
- **Normal end:** a role-issued `end` event. Only the orchestrator may emit it,
  and configured manifests require a pending end request.
- **Forced end:** the existing driver-owned run-cost-cap close. It remains a
  non-negotiable exception to normal end authorization and still passes through
  the reducer.

The reducer branches only on promoted mechanical fields (`target_role` and
`request_end`), never on opaque payload prose. Semantic adequacy remains the
orchestrator's responsibility.

## 3. Manifest contract

Add optional top-level `end_request_roles`:

```yaml
version: 3
end_request_roles: [reviewer, okf-curator]

roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [read, handoff, end]

  - name: implementer
    max_visits: 3
    tools: [read, edit, write, bash, handoff, end]

  - name: reviewer
    max_visits: 2
    tools: [read, grep, handoff, end]

  - name: okf-curator
    max_visits: 2
    tools: [read, edit, write, handoff, end]
```

Validation rules:

1. Omitted `end_request_roles` preserves the legacy contract: the orchestrator
   may call `end` without a pending request, and worker end requests are illegal.
2. When present, the list is non-empty, duplicate-free, and contains only
   declared worker roles. The orchestrator cannot be listed because it finalizes
   rather than requests completion.
3. A configured list switches normal ending into gated mode: the orchestrator's
   role-issued `end` is legal only while a pending end request exists.
4. Changing the list is a manifest semantic change and requires the existing
   manifest-version bump discipline.
5. `MachineDefinition` receives a frozen `end_request_roles: readonly Role[] |
   null`; `null` means legacy mode and a non-null list means gated mode.

Malformed field shape is a `ManifestParseError`. Unknown roles, duplicates,
orchestrator membership, and an empty configured list are hard manifest
validation errors. No warning or fallback silently repairs them.

## 4. Handoff tool contract

The model-facing TypeBox schema is the contract and must describe the fields as
the model must actually send them:

```ts
{
  target_role: string;
  status: "ready" | "blocked" | "complete";
  objective: string;          // non-empty
  summary: string;            // non-empty
  requested_action: string;   // non-empty
  request_end?: boolean;      // defaults to false
  reason?: string;
  suggests_next?: string;
  // additional role-defined fields remain permitted
}
```

Rules:

1. `target_role`, `status`, `objective`, `summary`, and `requested_action` are
   structurally required in the schema. The three status values are literal
   schema values, not a hidden post-schema enum.
2. The schema descriptions explain each field. `request_end` explicitly says it
   is valid only for configured end-request roles handing back to the
   orchestrator with `status: complete`.
3. The role-specific tool description names the current role, its legal routing
   shape, all required fields, the status enum, and whether that role may set
   `request_end: true`.
4. Pi enforces structurally missing or wrongly typed required fields from the
   provider-visible TypeBox schema before the tool executor runs, keeping the
   role in-session. Whitespace-only strings and mechanically invalid end
   requests reach the conductor correction path; that result enumerates
   missing/invalid fields, legal status values, the legal target shape, and a
   compact valid example without capturing or sealing the session.
5. The no-emission recovery prompt restates the same complete contract. It does
   not direct workers to place status only in `reason`.
6. Host-synthesized handoffs continue to bypass the model-emitted actionable
   envelope, but they always set promoted `request_end` mechanics to `false`.
7. A model-emitted `request_end: true` that violates role, target, or status
   rules is rejected in-session without capture, sealing, reduction, or
   checkpoint mutation. The correction tells the role exactly which rule failed.

## 5. FSM and checkpoint semantics

Add the promoted mechanical field to a handoff event:

```ts
type MachineEvent =
  | {
      type: "handoff";
      target_role: Role;
      request_end: boolean;
      payload: unknown;
    }
  | {
      type: "end";
      authority: "role" | "run_cost_cap";
      payload: unknown;
    };
```

Add pending authorization to the checkpoint:

```ts
interface EndRequest {
  readonly role: Role;
  readonly session_file: string;
}

interface Checkpoint {
  // existing fields
  readonly end_request: EndRequest | null;
}
```

Transition rules:

| From | Event | Guard | To | End-request effect |
| --- | --- | --- | --- | --- |
| worker W | `handoff -> orchestrator`, `request_end: false` | existing worker routing rule | orchestrator | unchanged/null |
| worker W | `handoff -> orchestrator`, `request_end: true` | W is configured | orchestrator | set to W |
| worker W | `handoff`, `request_end: true` | W is not configured | rejected | unchanged |
| orchestrator | `end`, role authority, legacy mode | existing rule | done | clear |
| orchestrator | `end`, role authority, gated mode | pending request exists | done | clear |
| orchestrator | `end`, role authority, gated mode | no pending request | rejected | unchanged |
| orchestrator | `handoff -> worker` | existing visit-cap rule | worker | clear pending request |
| orchestrator | `end`, run-cost-cap authority | always | done | clear |

Clearing a pending request when the orchestrator dispatches more work makes the
authorization single-use and prevents a stale approval from closing a run after
subsequent changes. A later completion requires a fresh reviewer/curator request.

Worker `end` remains illegal. End-request roles use the handoff field; they do not
receive direct authority to transition the run to `done`. The host continues to
force-inject the `end` tool into every role session; this feature changes manifest
authorization and reducer behavior, not tool availability.

## 6. Persistence, recovery, and observability

1. Checkpoint snapshots persist `end_request`, so resume preserves a valid
   request and cannot invent one from transition history or prose.
2. Accepted/rejected transition records add `request_end: boolean` for handoff
   observability. Accepted normal `end` records identify the request role when
   one was consumed; forced ends identify `run_cost_cap` authority.
3. Run memory exposes pending authorization to the orchestrator:

   ```text
   end_request: { role: "reviewer" } | null
   can_end: true | false
   ```

4. Rejection guidance distinguishes ordinary illegal routing from
   `end_request_unauthorized` and `end_request_required` so a role receives a
   corrective instruction rather than a generic failure.
5. Existing `session_failed`, model fallback, user abort, and resume mechanics
   are unchanged.

## 7. Compatibility and migration

- Existing manifests remain valid and behave exactly as before when
  `end_request_roles` is absent.
- Existing persisted checkpoints without `end_request` normalize it to `null`
  when read. New snapshots always include the field.
- Existing callers constructing `MachineEvent` in source/tests must add the
  promoted fields. These are internal TypeScript contracts, not manifest
  migration requirements.
- The handoff schema becomes stricter for model calls. This is intentional: the
  previously optional/hidden envelope was the reliability defect. Arbitrary
  additional fields remain supported.
- No dependency, provider, session-tree, or core/host layering changes.

## 8. Project structure and implementation boundaries

Expected source surfaces:

```text
src/manifest/       parse, validate, and pin end_request_roles
src/seam/           authoritative TypeBox handoff schema and promoted fields
src/core/           pure transition/checkpoint/end-authorization mechanics
src/host/           role-specific tool descriptions, recovery prompts, run memory
tests/manifest/     parsing and static-validation tables
tests/seam/         schema and actionable-envelope behavior
tests/core/         authorization transitions and checkpoint effects
tests/host/         same-session correction, recovery text, E2E/resume behavior
README.md           manifest and handoff contract examples
```

Always:

- Keep core modules host-agnostic and reducer behavior pure.
- Use the same TypeBox schema for provider exposure and seam validation.
- Preserve the single owner for reduction, persistence, and spawning.
- Add table-driven tests before implementation changes.

Never:

- Infer completion from natural-language `reason`, `summary`, or
  `requested_action`.
- Let a worker transition directly to `done`.
- Let a configured approval survive an orchestrator dispatch to more work.
- Bypass `reduce` for normal or forced completion.

## 9. Implementation plan

- [x] Task 1 — Manifest and pinned definition
  - Acceptance: parse/freeze the optional list; reject empty, duplicate,
    undeclared, or orchestrator entries; derive legacy/gated machine config.
  - Verify: `pnpm exec vitest run tests/manifest/parse.test.ts tests/manifest/validate.test.ts`.

- [x] Task 2 — Pure FSM authorization
  - Acceptance: pending requests are set, consumed, cleared on redispatch, and
    preserved through lifecycle events; forced cost-cap end remains legal.
  - Verify: focused core reducer, lifecycle, composition, and visit-cap tests.

- [x] Task 3 — Accurate handoff surface
  - Acceptance: required schema fields and enum are provider-visible; dynamic
    description/corrections/recovery prompts state the complete legal contract;
    invalid end requests remain in-session and unsealed.
  - Verify: focused seam/tool/loop tests.

- [x] Task 4 — Host integration, persistence, and resume
  - Acceptance: host promotes `request_end`, seeds pending authorization, logs
    it, and resumes without losing or inventing authorization.
  - Verify: focused host E2E, production-host, run-memory, and resume tests.

- [ ] Task 5 — Documentation and full gates
  - Acceptance: README examples explain legacy and gated modes; all completed
    task and parent checkboxes are ticked with evidence.
  - Verify: `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
    `pnpm format:check`, and `pnpm audit --prod`.
  - Evidence: typecheck, build, 846 tests, lint, and format check pass.
    `pnpm audit --prod` remains unverified because this environment requires
    explicit approval before sending dependency metadata to the npm registry.

## 10. Code style

Use additive, explicit fields and discriminated unions. Mechanical authority is
visible at call sites:

```ts
const event: MachineEvent = {
  type: "handoff",
  target_role: def.orchestrator,
  request_end: args.request_end ?? false,
  payload: args,
};
```

No ambient manifest reads, implicit defaults inside the reducer, `any`, or
parallel schema definitions.

## 11. Success criteria

1. A legacy manifest still permits orchestrator-only normal completion.
2. A gated manifest prevents orchestrator completion until a configured worker
   explicitly requests it in a valid completed handoff.
3. Implementer requests are rejected without ending or failing the run.
4. Reviewer/OKF-curator requests survive their terminal lifecycle and authorize
   exactly the next orchestrator decision; redispatch invalidates them.
5. Run-cost-cap forced close still reaches `done` through the reducer.
6. Agent roles can discover every required handoff field, legal status value,
   routing rule, and end-request permission from the tool surface alone.
7. Invalid handoff attempts receive actionable same-session correction.
8. Full repository verification passes, with audit findings reported rather
   than silently ignored.

## 12. Overseer decisions

1. The top-level name is `end_request_roles`.
2. A pending request is single-use and clears if the orchestrator dispatches any
   further worker.
3. Omitted configuration preserves legacy orchestrator-only ending.
4. `end` remains force-injected into every role session; no manifest tool-list or
   host allowlist behavior changes in this feature.
