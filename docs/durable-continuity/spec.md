# Durable continuity ledger specification

Status: **Acknowledged by overseer on 2026-09-18 (this revision). Gate 0 satisfied; implementation and dispatch may proceed.**

Date: 2026-09-18

Authority: this document refines the orchestration contracts in
`docs/archive/orchestrator-fsm-spec.md`. If the two documents conflict, the
archived FSM specification remains authoritative until both are explicitly
updated.

## 1. Purpose

A fresh role session or delegated child must be able to continue useful work
without depending on an earlier model's hidden conversation history. Today,
accepted FSM handoffs and delegated completion records are durable, but their
semantic contents are free-form and there is no bounded, deterministic view of
findings accumulated across multiple role visits and children.

This feature adds an opt-in, typed `ContinuityPacket`, persists packets through
existing accepted-handoff and delegated-result records, and materializes a
bounded run-scoped continuity view for fresh sessions and operators.

The governing principle is:

> Agents supply meaning. The host enforces shape, size, provenance, references,
> and lifecycle. Repository knowledge promotion remains a separate human- or
> curator-owned decision.

## 2. Goals

1. Preserve operational findings, evaluations, unresolved questions, and next
   actions across fresh role sessions and process restarts.
2. Give every packet explicit run, role, visit, child, and record provenance
   derived by the host rather than trusted from model output.
3. Accept only bounded, JSON-safe, schema-valid packets at host seams.
4. Resolve evidence references deterministically where the host has authority;
   never present an unresolved reference as verified.
5. Materialize a deterministic, bounded view from append-only records without
   changing reducer policy or inspecting prose in the reducer.
6. Retain backward compatibility when continuity policy is omitted.
7. Export evidence-backed candidates for optional OKF curation without writing
   `.okf/` from the runtime.

## 3. Non-goals

- Persisting hidden reasoning, chain of thought, complete transcripts, or model
  scratchpads.
- Allowing the reducer to interpret continuity prose.
- Semantic deduplication or truth adjudication by deterministic host code.
- Replacing context artifacts, accepted handoffs, child output artifacts, or
  run memory.
- Automatically editing `.okf/`.
- Adding continuity to the `end` emission in version 1. Terminal orchestrator
  state is expected to consume the ledger produced by prior handoffs and child
  results.
- Making external URLs or repository prose intrinsically trustworthy.

## 4. Terms

- **Packet**: model-authored structured continuity content accepted at a seam.
- **Envelope**: host-authored provenance plus a validated packet and evidence
  resolutions.
- **Ledger**: chronological append-only envelopes derived from durable records.
- **Materialized view**: bounded deterministic projection of the ledger supplied
  to a fresh role or rendered for an operator.
- **Evidence reference**: typed pointer to a run-local execution/artifact,
  repository location, or external source.
- **Active item**: an item not explicitly superseded by a later item.

## 5. Manifest policy

The top-level manifest may contain:

```yaml
continuity:
  schema_version: 1
  require_handoff: true
  require_delegated_result: true
  seed_max_utf8_bytes: 32768
```

All keys are required when `continuity` is present. Unknown keys fail parsing.

- `schema_version` is exactly `1`.
- `require_handoff` requires a valid packet on every accepted `handoff`.
- `require_delegated_result` requires a valid packet on every successful
  delegated `report_result` completion.
- `seed_max_utf8_bytes` is an integer from 8,192 through 65,536 inclusive. It
  bounds the serialized materialized view injected into a fresh session.

When `continuity` is absent, legacy manifests and records behave exactly as
before. Valid packets may still be accepted and persisted when optional.

If `require_delegated_result` is true, static validation rejects any
`minimal`-profile subagent reachable through an FSM role's `allowed_subagents`.
The host must not silently exempt such a child because `minimal` completion has
no typed result payload. Unreachable minimal profiles do not make a manifest
invalid.

Manifest parsing and pinning follow existing rules: policy is validated once,
pinned into the run definition/snapshot used by the host, and never read from
ambient configuration during a run.

## 6. Packet contract

The seam owns one TypeBox schema and derives TypeScript types with `Static<>`.
No parallel handwritten runtime validator is permitted.

Conceptual version 1 shape:

```ts
interface ContinuityPacketV1 {
  schema_version: 1;
  summary: string;
  findings: ContinuityFinding[];
  evaluations: ContinuityEvaluation[];
  open_questions: ContinuityQuestion[];
  next_steps: ContinuityNextStep[];
  okf_candidate_ids: string[];
}
```

### 6.1 Fixed bounds

- serialized packet: at most 32 KiB UTF-8 after JSON-safe normalization;
- `summary`: 1–2,048 characters;
- each collection: at most 32 entries;
- each item statement/question/action: 1–2,048 characters;
- each item has 0–8 evidence references;
- each `supersedes` collection: at most 8 item IDs;
- `okf_candidate_ids`: at most 16 unique IDs;
- all IDs: 1–96 characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`.

Array ordering is meaningful and preserved. Unknown properties fail closed.
Duplicate IDs within a packet fail closed. Empty arrays are valid so roles are
not incentivized to invent findings.

### 6.2 Findings

```ts
interface ContinuityFinding {
  id: string;
  kind: "fact" | "decision" | "negative_result" | "risk";
  confidence: "observed" | "verified" | "inferred";
  statement: string;
  evidence: EvidenceRef[];
  supersedes: string[];
}
```

`verified` is a host-constrained claim: every evidence reference on the item
must resolve to `verified`, and at least one evidence reference is required.
The host rejects rather than downgrades an invalid `verified` claim.
`observed` and `inferred` may contain declared or unresolved evidence, which is
rendered with that status.

A new globally unique item may name earlier item IDs in `supersedes`. The
materializer marks the older items superseded but retains them in chronological
history. References must target earlier items in the same run. Missing,
forward, self, and cyclic references fail closed.

### 6.3 Evaluations

```ts
interface ContinuityEvaluation {
  id: string;
  label: string;
  execution_id: string;
  supersedes: string[];
}
```

An evaluation does not carry a model-authored pass/fail result. The host resolves
`execution_id` to the run-local durable execution record and derives status,
exit information, cleanup disposition, and command digest. Missing or
cross-run IDs fail closed. This prevents claimed evaluation outcomes from
outrunning execution evidence.

### 6.4 Open questions and next steps

```ts
interface ContinuityQuestion {
  id: string;
  question: string;
  blocking: boolean;
  evidence: EvidenceRef[];
  supersedes: string[];
}

interface ContinuityNextStep {
  id: string;
  action: string;
  owner: "parent" | "recipient" | "reviewer" | "operator";
  evidence: EvidenceRef[];
  supersedes: string[];
}
```

These are operational statements, not new scheduler authority. An `owner` does
not authorize a child, change the FSM role, or grant tools.

### 6.5 OKF candidate references

`okf_candidate_ids` may name findings in the same packet. Candidates must be
`verified` and may not be superseded in that packet. Invalid references fail
closed. A candidate marker means only “consider for curation”; it does not
cause a repository write and it does not assert that the item meets OKF
quality criteria.

## 7. Evidence references

Version 1 accepts this discriminated union:

```ts
type EvidenceRef =
  | { kind: "tool_execution"; execution_id: string }
  | { kind: "context_artifact"; artifact_id: string; sha256: string }
  | {
      kind: "repository";
      path: string;
      commit: string;
      sha256?: string;
      line_start?: number;
      line_end?: number;
    }
  | { kind: "external"; url: string; title: string };
```

Validation rules:

1. All text and path limits are explicit in the TypeBox schema.
2. Repository paths are normalized relative paths. Absolute paths, traversal,
   NUL bytes, backslashes, empty components, and `.git` paths are rejected.
3. `commit` must be a full 40-hex object ID. If a blob digest is supplied it is
   lowercase 64-hex SHA-256.
4. Line ranges are positive, ordered, and both endpoints must be supplied
   together.
5. External references use absolute `https:` URLs only. They remain `declared`
   in version 1; the host does not turn network access into a verified fact.
6. Tool executions must belong to the same run and be durably reconciled. Their
   resolution is host-derived.
7. Context artifacts must be visible to the emitting role/child and match the
   recorded digest.
8. Repository evidence is `verified` only when the host can resolve the commit,
   path, optional range, and optional digest in the canonical repository.
   Otherwise it is `missing` or `declared`, never silently trusted.

Each accepted envelope contains host-produced evidence resolutions with
`verified`, `declared`, or `missing` status and a stable diagnostic code. The
model cannot supply or override resolution status.

## 8. FSM handoff integration

`continuity` becomes a reserved optional property of the `handoff` tool schema.
The existing non-empty `reason` requirement is unchanged.

On a handoff attempt, the host:

1. validates the complete tool arguments at the seam;
2. enforces the pinned continuity policy;
3. normalizes and measures the packet;
4. resolves evidence under the current run/role/visit authority;
5. validates item IDs and supersession against the current ledger;
6. captures the packet in the accepted handoff envelope;
7. calls the reducer exactly once and persists through the existing accepted
   transition path.

A rejected packet does not call the reducer and does not append an accepted
transition. The tool returns a bounded repair diagnostic so the role can retry.
The reducer continues to treat machine payload as `unknown` and never branches
on continuity content.

The existing `AcceptedHandoffEnvelope` remains `schema_version: 1` and keeps
its complete JSON-safe payload. That payload contains the model-authored
`continuity` packet. The envelope gains only optional host-authored
`continuity_evidence` and `continuity_packet_utf8_bytes` siblings; it does not
duplicate the packet. `utf8_bytes` continues to measure the complete payload,
including continuity, under the existing 64 KiB handoff cap. Legacy version 1
envelopes without the optional siblings remain readable.

`recipientHandoffPayload` treats `continuity` as a reserved field, like
`context_ref` and `artifacts`, and strips it from the generic recipient payload.
Fresh sessions receive the host materialized view described in section 11, so
raw packet prose is not duplicated in the prompt.

## 9. Delegated child integration

`continuity` becomes an optional property of successful `report_result`.
Failure and cancellation observations do not require a model packet; their
existing host-authored terminal records remain continuity evidence in their own
right.

For successful children, the parent-side observation pipeline:

1. validates the result and packet;
2. enforces `require_delegated_result`;
3. binds provenance from the durable task and observation—run ID, parent role,
   parent visit, child ID, subagent, task ID, attempt, and terminal record ID;
4. resolves evidence only within that child's granted artifact/execution
   authority;
5. persists one optional `continuity` sibling on the existing successful
   `subagent_completed` record. That sibling contains the normalized packet,
   `packet_utf8_bytes`, and host evidence resolutions; the surrounding child
   record remains the source of run/parent/child/task/attempt provenance.

The child must not author provenance fields. A malformed or missing required
packet converts the observation to the existing bounded protocol-failure path;
it is not accepted as a successful result.

The parent remains solely responsible for accepting findings, integrating code,
running repository gates, and committing. Child continuity is evidence, not an
automatic merge decision.

## 10. Durable envelope and provenance

No standalone continuity record or mutable side store is introduced. Durable
storage is deliberately asymmetric but additive:

- handoff packets remain inside `accepted_handoff.payload.continuity`, with
  host-authored resolution metadata beside the payload on that envelope;
- delegated packets live in `subagent_completed.continuity`, with host-authored
  resolution metadata in that sibling;
- the surrounding `transition_accepted` or `subagent_completed` record supplies
  authoritative lifecycle provenance.

The pure reader normalizes those two record shapes into a materialized envelope
with fields equivalent to:

```ts
interface ContinuityEnvelopeV1 {
  schema_version: 1;
  source: "handoff" | "delegated_result";
  record_id: string;
  run_id: string;
  role: string;
  visit: number;
  child?: {
    child_id: string;
    subagent: string;
    task_id: string;
    attempt: number;
  };
  accepted_at: string;
  packet_utf8_bytes: number;
  packet: ContinuityPacketV1;
  evidence_resolutions: EvidenceResolution[];
}
```

`record_id`, `run_id`, role/visit identity, child identity, and timestamp come
from host-owned state or records. Existing record append order is the canonical
order; model timestamps are neither requested nor trusted.

The feature adds no mutable side store. Packets are appended as part of existing
records, survive restart, and are rebuilt from the run log. Invalid historical
records produce a typed materialization error with record identity rather than
being skipped.

## 11. Deterministic materialization

A pure materializer folds validated envelopes in canonical record order.
It does not summarize prose with a model.

The full operator view contains:

- packet provenance and summaries;
- active and superseded findings;
- host-derived evaluation outcomes;
- unresolved and superseded questions;
- active and superseded next steps;
- evidence resolutions;
- eligible OKF candidates;
- source counts and byte counts.

The fresh-session seed contains, in order:

1. newest active blocking questions;
2. newest active next steps owned by the recipient or parent;
3. newest active risks and decisions;
4. newest remaining active findings;
5. relevant host-derived evaluations;
6. packet summaries newest first.

Items are included atomically. Deterministic truncation stops before the next
item would exceed `seed_max_utf8_bytes`; the seed records omitted item and
packet counts. Stable JSON serialization is used for byte measurement. If the
fixed metadata alone exceeds the cap, materialization fails explicitly.

A fresh FSM role receives the seed through structured run memory. A delegated
child receives continuity only when the parent explicitly includes the
materialized seed through the existing context-artifact/delegation boundary;
there is no ambient child access to the run log.

Repeated materialization over the same log and policy must be byte-identical.

## 12. CLI and scripts

Add a read-only CLI surface:

```text
conduct continuity-report --log-dir <dir> <run-id> --format json
conduct continuity-report --log-dir <dir> <run-id> --format markdown
conduct continuity-report --log-dir <dir> <run-id> --format okf-candidates
```

The command uses the production log reader and the same validators/materializer
as the host. It never mutates the run or repository.

- `json` emits the complete materialized operator view.
- `markdown` emits a deterministic human-readable ledger with provenance and
  evidence status.
- `okf-candidates` emits only non-superseded, verified candidates plus exact
  source evidence and provenance. It may emit an empty list.

Malformed records, missing required evidence, unsafe paths, and unknown schema
versions produce non-zero exit status and bounded diagnostics. The CLI must not
use a second interpretation of the schema.

## 13. OKF curation boundary

Runtime code never writes `.okf/`. Candidate export is an input to a separate,
single-owner curation step after implementation and verification.

The curator must:

1. read the existing `.okf/` index and relevant concepts;
2. verify candidate evidence independently;
3. promote only durable, non-obvious repository knowledge;
4. deduplicate or update existing concepts rather than append task-log entries;
5. make no change when no candidate clears the threshold.

Concurrent delegated children must never edit `.okf/`. The implementation run
may update documentation describing this boundary, but repository knowledge
promotion is not part of feature acceptance.

## 14. Security, privacy, and failure behavior

- Packet text is untrusted input. It is escaped in Markdown output and never
  executed as a command.
- URLs are data; rendering does not fetch them.
- No secrets, credentials, full environment dumps, hidden reasoning, or full
  transcripts belong in packets. Role prompts state this explicitly.
- Byte limits use UTF-8 byte counts, not JavaScript character counts.
- Every rejection has a stable diagnostic code and bounded message.
- Evidence access is audience-checked; a child cannot cite an artifact it was
  not granted.
- Cross-run references fail closed.
- Partial or timed-out executions are rendered with their durable reconciliation
  state and are never called passed merely because output exists.
- The materializer is pure over records and policy; filesystem/network evidence
  resolution happens before envelope acceptance or in an explicit verifier.

## 15. Compatibility and migration

1. Existing manifests without `continuity` parse and run unchanged.
2. Existing handoff records without packets materialize as zero continuity
   envelopes.
3. Existing `minimal` child profiles remain valid unless reachable from a role
   while `require_delegated_result` is true.
4. Existing `report_result` payloads remain valid when continuity is optional.
5. Unknown future packet/envelope versions fail with a typed unsupported-version
   diagnostic.
6. No record rewrite or backfill is required.
7. Public exports are additive and documented with one-line JSDoc.

## 16. Required tests

At minimum, implementation must cover:

- manifest omission and valid policy parsing;
- all policy bounds and unknown keys;
- reachable versus unreachable minimal-profile compatibility;
- packet shape, unknown properties, JSON safety, duplicate IDs, and UTF-8 byte
  boundaries;
- handoff required/optional acceptance and rejection without reducer calls;
- successful persistence and restart reconstruction;
- delegated result required/optional behavior and failure mapping;
- host-derived provenance that ignores spoofed model fields;
- each evidence variant, cross-run/audience denial, and unresolved status;
- verified-claim and OKF-candidate constraints;
- missing/forward/self/cyclic supersession;
- deterministic order, active/superseded state, and byte-identical output;
- deterministic seed truncation and omission counts;
- legacy handoff and child records;
- CLI JSON, Markdown escaping, candidate output, and malformed-log failure;
- grep guard proving no pi imports enter pure layers.

Tests should be table-driven where cases are enumerated. New behavior follows
red-green-refactor and preserves existing tests.

## 17. Implementation boundaries

- Pure schema/types/materialization belong in `src/seam`, `src/manifest`,
  `src/core`, or `src/persistence` and must not import pi.
- SDK observations, artifact/execution lookup, prompt injection, and session
  behavior belong in `src/host`.
- CLI parsing/rendering belongs in `src/bin` and reuses pure contracts.
- The reducer remains payload-agnostic and pure.
- Existing accepted-handoff and child-completion append paths remain the single
  owners of durable acceptance.
- No source file should cross the repository's ~400 LOC ceiling without the
  documented exception allowed by `AGENTS.md`.

## 18. Verification gate

The implementation is complete only after:

```text
pnpm typecheck
pnpm build
pnpm lint
pnpm format:check
git diff --check
pnpm test                 # or documented deterministic shards covering all tests
pnpm audit --audit-level high
```

If the full suite exceeds the supervisor deadline, deterministic shards must
cover the complete suite, stream output, and be reported as shards rather than
misrepresented as one command. Ambiguous tool-execution timeouts must be
reconciled before reporting success.

## 19. Acceptance criteria

The feature is accepted when an opt-in run can stop after a handoff or child
completion, restart in a fresh process, and reconstruct a byte-identical bounded
continuity seed with verified host provenance; malformed, oversized,
unauthorized, or unsupported data fails closed; legacy runs remain readable;
and operators can render the ledger and verified OKF candidates without
mutating repository knowledge.

## 20. Overseer acknowledgement

Implementation and any pi-conductor run are blocked until the overseer records
acknowledgement of this specification. Acknowledgement may approve it as
written or request revisions. Creating implementation plans, manifests, and
role prompts is permitted before acknowledgement; executing those plans is not.

**Acknowledgement record:**

- 2026-09-18 — Overseer acknowledged this specification as written. This commit
  on branch `feature/bubblewrap-execution-spec` is the acknowledged revision.
  The implementation lead confirmed the acknowledged revision before changing
  implementation code. The dispatch SHA is pinned in the commit directly above.
