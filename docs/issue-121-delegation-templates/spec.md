# Issue #121: manifest-defined delegation assignments

Status: acknowledged for implementation

Authority: issue #121, [`plan.md`](./plan.md), and the pinned-manifest and
host-authority invariants in [`docs/archive/orchestrator-fsm-spec.md`](../archive/orchestrator-fsm-spec.md).

## 1. Goal and boundaries

Assignment mode gives a role a small, manifest-defined vocabulary for delegated
work. A model chooses one named assignment and supplies only a bounded brief:

```json
{
  "assignment": "p1-review-remediation",
  "brief": "Fix the documented required-path validation defects."
}
```

The host resolves that request against the immutable manifest snapshot and
submits exactly one existing internal delegation task. The manifest, not the
model, owns the child profile, output contract, projection, child tools,
verification recipe, mode, limits, and cost authority.

This change does not add FSM state, child execution semantics, a message bus,
automatic integration, or new authority for controller-native delegation.
Controller-native general task admission remains an internal privileged host
interface and is not registered as an assignment-mode model tool.

## 2. Versioned interface selection

`RoleConfig.delegation.interface` selects the model-visible delegation
protocol:

- `assignments_v1`: exposes `delegate_task` and `delegation_control`.
- `legacy_v1`: exposes the existing `delegate` tool and its batch/control union.

Fresh YAML that omits `interface` is normalized to `legacy_v1`, preserving the
current behavior. Programmatic manifests and historical pinned snapshots may
also omit the field; host resolution treats omission as `legacy_v1`. There is no
silent reinterpretation of an old manifest as assignment mode.

Assignment mode requires the parent role's `tools` list to contain both
`delegate_task` and `delegation_control`, and forbids `delegate`. Legacy mode
forbids assignment templates and assignment tool names; it requires `delegate`
when the delegation tool is intended to be exposed. The normal existing warning
for a delegation policy without its legacy `delegate` declaration remains
applicable to legacy mode.

The `mode` field remains trusted role policy. It is not accepted in either new
model-facing schema. `blocking` waits for the one admitted child and returns a
terminal result; `nonblocking` returns immediately and uses
`delegation_control` for settlement.

## 3. Manifest contract

Assignment templates live inside the parent role's `delegation` block because
they bind the parent's authority:

```yaml
version: 2
roles:
  - name: coordinator
    is_orchestrator: true
    tools: [read, handoff, end, delegate_task, delegation_control]
    delegation:
      interface: assignments_v1
      mode: nonblocking
      allowed_subagents: [reviewer, test-writer]
      max_children_per_session: 4
      max_parallel: 2
      assignments:
        - name: p1-review-remediation
          subagent: reviewer
          expected_output: A focused patch and evidence for the required-path defects.
          projection_paths:
            - src/manifest/validate.ts
            - tests/manifest/delegation-assignments.test.ts
          tools: [read, grep, edit, write, verify, read_execution_output]
          verification_recipe: manifest-focused
        - name: p1-test-coverage
          subagent: test-writer
          expected_output: Focused regression tests for the assignment contract.

subagents:
  - name: reviewer
    models: [anthropic:claude-sonnet-4-5]
    max_session_cost_usd: 2
    system_prompt: .pi/subagents/reviewer.md
    tools:
      required: false
      allowed: [read, grep, edit, write, verify, read_execution_output]
      default: [read, grep, edit, write, verify, read_execution_output]
    verification_recipes: [manifest-focused]
  - name: test-writer
    models: [anthropic:claude-sonnet-4-5]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/test-writer.md
```

The closed assignment shape is:

```ts
type DelegationAssignment = {
  name: string; // ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
  subagent: string; // declared and allowed profile
  expected_output: string; // 1–8192 characters, non-whitespace
  projection_paths?: string[]; // 1–64 safe exact repository-relative paths
  tools?: ChildToolName[]; // exact narrowing of the profile's tool policy
  verification_recipe?: string; // one declared and profile-authorized recipe
};
```

Parser rules are closed and fail-closed: unknown assignment keys, malformed
scalars, empty text, unsafe paths, duplicate paths, duplicate tools, and
out-of-bound arrays are rejected before static validation. The parser deeply
freezes assignments and their nested arrays.

Static validation additionally requires:

1. assignment names are unique per parent role;
2. each assignment profile is declared and appears in the parent's
   `allowed_subagents`;
3. assignment tool selections are a narrowing of the profile authority;
4. recipe names are declared, authorized by the profile, and compatible with
   the effective tool policy (`verify` is present);
5. exact assignment projections are safe, unique, and compatible with the
   profile's projection/snapshot policy; a snapshot profile cannot accept an
   assignment projection override;
6. assignment mode has at least one assignment and the two explicit new tool
   declarations, without the legacy tool; and
7. legacy mode has no assignment list or assignment tool declarations.

Filesystem membership, Git cleanliness, sandbox availability, live budgets, and
current parent lifecycle remain runtime admission checks. Static checks do not
pretend to resolve those host facts.

## 4. Model-facing tools

### 4.1 `delegate_task`

The only accepted arguments are:

```ts
type DelegateTaskArgs = {
  assignment: string; // assignment name grammar above
  brief: string; // non-whitespace, at most 8192 characters
};
```

The TypeBox schema is a closed object with no union and no nested task array.
The following are rejected before host execution: `id`, `mode`, `subagent`,
`expected_output`, `projection_paths`, `context_artifacts`, `tools`,
`verification_recipe`, `tasks`, and every other unknown key.

The host maps one call to one internal task:

```ts
{
  tasks: [{
    id: assignment.name,
    subagent: assignment.subagent,
    objective: brief,
    expected_output: assignment.expected_output,
    ...(assignment.projection_paths === undefined ? {} :
      { projection_paths: assignment.projection_paths }),
    ...(assignment.tools === undefined ? {} : { tools: assignment.tools }),
    ...(assignment.verification_recipe === undefined ? {} :
      { verification_recipe: assignment.verification_recipe }),
  }]
}
```

Only `brief` comes from the model. Assignment/profile authority is copied from
the pinned snapshot. The resolver returns one task and has no batch input path.
Reusing an assignment in a later SDK tool call is allowed; each accepted call
still receives a distinct host-generated `child_id`.

For `nonblocking`, the tool returns:

```json
{"child_id":"<stable-child-id>"}
```

For `blocking`, it returns:

```json
{"child_id":"<stable-child-id>","result":{<existing terminal result>}}
```

The result uses the existing snake_case child-result contract. Both responses
include the child ID; settlement/status/cancel operations use that ID rather
than the assignment name.

### 4.2 `delegation_control`

The control schema is an independent closed object:

```ts
type DelegationControlArgs = {
  operation: "status" | "result" | "wait" | "cancel";
  child_ids: string[]; // non-empty
};
```

Controls consume no admission allowance and retain the existing semantics:
`status`, `result`, and `cancel` return the existing status-object array;
`wait` returns `{ results: [...] }`. Unknown child handles reject. Controls do
not create submission identities or alter admission fingerprints.

## 5. Authority resolution and durable identity

The assignment resolver is deterministic for a pinned role policy and valid
arguments. It is called before Git capture, worktree creation, sandbox capture,
or child-session creation. Unknown assignments and direct malformed values are
typed failures with no side effects.

The resolved one-task request enters the existing preparation, admission, and
scheduler path. The existing atomic `delegation_submission_accepted` record
remains the acceptance authority. Its accepted arguments are the canonical
resolved internal one-task request; the assignment name is the internal task
ID, the brief participates in the existing request fingerprint, and the pinned
manifest snapshot retains the template. The SDK tool-call ID remains the
submission identity, including through isolated RPC transport UUIDs.

A byte-for-byte redelivery under the same logical parent and actual SDK
`tool_call_id` returns the original child ID. Reusing that identity with a
different assignment or brief rejects before a second acceptance or child.
Legacy v1/v2/v3 acceptance records remain readable and replayable; no record
version is added by this feature.

Controller-native callers continue to submit the general internal task shape
through their existing approval/activation boundary. That path is privileged
host input and is not a compatibility shim for model calls.

## 6. Shared SDK and isolated RPC parity

For a pinned `assignments_v1` role, shared SDK and isolated RPC sessions
register exactly `delegate_task` and `delegation_control` (plus the role's
other declared tools). For `legacy_v1`, they register exactly `delegate` for
the delegation surface. Submission and control handlers share one scheduler and
manager scope. The isolated bridge uses separate closed frame schemas and tool
names; submission frames retain the actual SDK tool-call ID, while controls do
not create admission identity.

`StubHost`, `ProductionHost`, shared SDK sessions, and isolated RPC sessions
must expose the same names and TypeBox schemas for the same pinned manifest.
Resume reconstructs the interface from `manifest_snapshot.normalized_manifest`,
not current YAML. Abort, model fallback, budget exhaustion, and reconciliation
retain the existing one-terminal-outcome-per-child rules.

Run-memory guidance names the active interface but never treats
`next_candidates` as child admission availability.

## 7. Migration and non-goals

A legacy manifest remains explicit and unchanged in shape; omission is also
accepted for historical manifests:

```yaml
version: 1
roles:
  - name: coordinator
    is_orchestrator: true
    tools: [handoff, end, delegate]
    delegation:
      interface: legacy_v1
      mode: blocking
      allowed_subagents: [reviewer]
      max_children_per_session: 2
      max_parallel: 1
```

The corresponding public policy type is a separate legacy shape, not a union
that permits assignment fields:

```ts
const legacyPolicy: LegacyDelegationPolicy = {
  interface: "legacy_v1",
  mode: "blocking",
  allowed_subagents: ["reviewer"],
  max_children_per_session: 2,
  max_parallel: 1,
};
```

`legacy_v1` and the existing public TypeScript schemas/types remain available
with deprecation documentation. Omitted-interface manifests and historical
pinned snapshots remain on the legacy path. New assignment manifests cannot
expose or execute legacy model submission fields. Migration requires a manifest
version bump, moving authority fields into named assignments, and changing the
role tool list to the two explicit names. During the deprecation window an
operator can roll back a new manifest to `legacy_v1` and the existing `delegate`
contract; no removal release is promised here.

The six initial Pi adapter families covered by conformance fixtures are
Anthropic Messages, OpenAI-compatible Chat/Completions, OpenAI Responses,
Google Generative/Vertex, Bedrock Converse, and Mistral Conversations. Custom
provider adapters are outside the initial matrix but remain subject to the
closed schemas.

This feature deliberately does not change the FSM reducer, checkpoints,
MachineDefinition, child execution, worktrees, sandboxing, projections,
verification execution, cost accounting, cleanup, automatic integration, or the
existing child-result protocol.

## 8. Open decisions recorded for implementation

The implementation follows the plan's conservative choices:

- both blocking and nonblocking modes remain available;
- assignment name is the repeatable internal task ID and `child_id` is the
  unique durable handle;
- explicit `delegate_task` and `delegation_control` names are used rather than
  an abstract capability expansion;
- legacy removal is not scheduled by this change; and
- the six listed Pi API families define the initial provider conformance matrix.

## 9. Traceability

| Plan task | Contract section |
| --- | --- |
| 2–3 | §2–3 |
| 4 | §4 |
| 5–6 | §5 |
| 7–9 | §6 |
| 10–12 | §7 |

The implementation must preserve the host-authority invariants in the archived
FSM specification, especially pinned manifests, schema-at-the-seam validation,
atomic acceptance before queueing, and the absence of Pi imports from pure
layers.
