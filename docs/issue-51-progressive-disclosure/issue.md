# Issue #51: Support progressive workspace projection / context disclosure

**Source:** https://github.com/lynellf/pi-conductor/issues/51 (pinned verbatim as the
requirements source for this run; 2026-08-25).

## Problem

PR #50 introduces per-role workspace projections: a role can be started with a
deliberately restricted repository view rather than the full integration
checkout. That creates a strong static information boundary, but the initial
projection must currently be correct up front.

For implementation roles in particular, that creates a tradeoff:

- expose a broad workspace and preserve access to unexpected dependencies, at
  the cost of a larger decision/search surface; or
- expose a narrow workspace and risk making the role artificially blind when
  the planner did not anticipate a required file.

The desired behavior is **progressive disclosure**: start the role with a
small, task-relevant projection, then allow it to explicitly request
additional repository paths when evidence in the current workspace shows they
are needed.

This is distinct from ordinary file-permission prompting. The goal is not user
authorization; it is to keep the model's observable/searchable workspace small
by default while preserving an escape hatch for missing context.

## Proposal

Add a conductor-owned mechanism for an isolated role to request expansion of
its current projection.

Conceptually:

```text
full repository
      ↓
initial task projection
      ↓
     role
      ↓
request_files(paths, reason)
      ↓
host/orchestrator validates request
      ↓
approved paths materialized into role workspace
      ↓
role continues
```

A minimal role-facing tool could look roughly like:

```ts
request_files({
  paths: [
    "src/schema/card.ts",
    "tests/schema/card.test.ts",
  ],
  reason: "conditions.ts imports CardSchema and its invariants are not present
in the current projection",
})
```

Exact tool naming/schema is not prescribed here.

## Requirements

- An isolated role may start with only a planner/orchestrator-selected subset
  of repository files/directories.
- The role can explicitly request one or more additional repository-relative
  paths while active.
- A request includes a short reason so the expansion is observable and
  auditable.
- Conductor validates requested paths against the pinned run snapshot and the
  role's disclosure policy before exposing them.
- Approved content is added without granting general access to the rest of the
  repository.
- Denied/unavailable requests return a typed result to the role rather than
  silently widening access.
- Existing static projections and shared-workspace behavior remain unchanged
  when progressive disclosure is not configured.
- Projection expansion must not weaken the existing write/isolation guarantees
  introduced by #48/#50.

## Observability

Persist enough information to evaluate the behavior of progressive disclosure,
at minimum:

- requesting role / visit;
- requested paths;
- reason;
- approved / rejected / unavailable result;
- paths actually disclosed.

This should make it possible to compare runs using:

1. shared repository access;
2. static projection;
3. progressive projection.

Useful downstream metrics include number of expansion requests,
requested-path precision, token usage, reviewer loops, and final task success.

## Acceptance criteria

- A role starting from a deliberately incomplete projection can request a
  missing dependency and continue after that dependency is disclosed.
- Requesting one path does not expose unrelated siblings or the repository
  tree by default.
- A rejected request leaves the existing projection unchanged and returns an
  actionable result to the role.
- Newly disclosed files remain subject to the role's existing read/write
  policy; disclosure does not imply write authority.
- Requests and outcomes are durably observable per run.
- Roles/manifests that do not opt into progressive disclosure behave exactly
  as they do after #50.

## Scope

Keep this as a thin capability on top of the per-role workspace/projection
substrate from #48/#50. It should not introduce a second workspace system,
automatic repository-wide retrieval, or a general permission/approval
framework unless those become necessary to satisfy the requirements.

The main purpose is to reduce an agent's default decision surface without
making the planner's initial file selection an irreversible constraint.
