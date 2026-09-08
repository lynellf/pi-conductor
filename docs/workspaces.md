# Per-role isolated workspaces (Issue #48)

← [Back to README](../README.md#documentation)

## Contents

- [Per-role isolated workspaces (Issue #48)](#per-role-isolated-workspaces-issue-48)
- [Configuration reference](#configuration-reference)
- [Guarantees and unavailable backend](#guarantees-and-unavailable-backend)
- [Artifact lifecycle](#artifact-lifecycle)
- [Progressive file disclosure (Issue #51)](#progressive-file-disclosure-issue-51)
- [Retention](#retention)

Conductor supports three workspace modes: `shared` (the default), `worktree`,
and `copy`. A role with an isolated workspace has file tools rooted in its
provisioned role workspace; it can reach other paths only through declared
mounts.

### Configuration reference

```yaml
roles:
  - name: implementer
    max_visits: 3
    tools: [read, grep, edit, write, handoff, end]
    workspace:
      backend: worktree            # worktree | copy; omit the block for shared
      mounts:
        - path: .campaign          # relative to the role's snapshot checkout
          writable: false
        - path: /data/out          # absolute host path
          writable: true
    artifacts:
      auto_patch: true             # default true for worktree; false for copy
      max_file_bytes: 1048576      # default 1 MiB per declared file
      max_files: 32                # default declared files per handoff
```

`shared` roles use the integration checkout. `worktree` creates a per-role
Git worktree, while `copy` creates an isolated filesystem copy.

### Guarantees and unavailable backend

| Mode | Guarantee |
| --- | --- |
| `shared` | `none` (full integration-checkout access) |
| `worktree` / `copy` | `confined` (role workspace plus declared mounts) |

`confined` is a process and tool-surface boundary, not OS, credential, or
network isolation. No available backend provides an OS-isolation guarantee.

`container` is unavailable. A manifest that selects `backend: container` is
rejected with a typed `WorkspaceError` before host construction or run
persistence; it does not fall back to another backend.

### Artifact lifecycle

On an accepted handoff from an isolated role, the host collects declared,
workspace-relative files from the emitting provisioned workspace. It enforces
projection containment and the `max_file_bytes` and `max_files` caps, then
persists `artifact_collected` or `artifact_rejected` records. Artifacts remain
host-owned in the run artifact store.

The host routes only collected declared artifacts. It materializes them beneath
`artifacts/<emitting-role>-v<visit>/` in an isolated receiver; a shared receiver
gets host-store paths in a host-generated seed inventory instead. That inventory
is generated only by the host and reports unavailable declared artifacts from
rejection records; its available entries are only host-collected artifacts.

Worktree roles retain host-generated auto-patches only when
`artifacts.auto_patch` is enabled (the worktree default), but auto-patches are
never routed to a receiver. The host never automatically applies an artifact or
patch to the integration checkout.

### Progressive file disclosure (Issue #51)

An isolated `worktree` role can begin with a deliberately incomplete sparse
projection and ask Conductor for named, policy-approved files as it discovers a
missing dependency. This is opt-in: a role without `progressive_disclosure`
behaves exactly as the ordinary `worktree` configuration above.

```yaml
roles:
  - name: implementer
    tools: [read, grep, edit, write, request_files, handoff, end]
    workspace:
      backend: worktree
      source: snapshot
      progressive_disclosure:
        # Present at role startup.
        initial_paths:
          - src/schema/card.ts
          - tests/schema/card.test.ts
        # Exact files or roots under which later exact-file requests are allowed.
        allowed_paths:
          - src/schema
          - tests/schema
```

Both path lists are required, repository-relative literal paths. Absolute
paths, traversal, backslashes, duplicate entries, and Git-pattern syntax are
rejected when the manifest loads. Progressive disclosure requires
`backend: worktree`; `shared` and `copy` roles cannot enable it. The role gets
`request_files` only when it declares both the policy and the tool.

While active, the role calls the host-provided TypeBox tool:

```ts
request_files({
  paths: ["src/schema/card.ts", "tests/schema/card.test.ts"],
  reason: "conditions.ts imports CardSchema, which is absent from this projection.",
});
```

Each request names one or more exact regular files. Conductor checks every path
against the policy and the run's pinned Git snapshot before changing the
workspace. An `allowed_paths` root permits exact file requests below that root,
but does not disclose sibling files or a directory tree. A request returns a
typed result: `approved` (with `disclosed_paths`), `denied` (invalid or
unauthorized path), or `unavailable` (absent from the pin or a workspace
failure). Denied and unavailable requests leave the existing projection
unchanged.

Disclosure does not expand write authority. Existing confined file-tool and
mount write rules still apply: a read-only role receives disclosed files
read-only, and disclosure never grants access to unrequested files. Every request is
appended to the run log as a `progressive_disclosure` record with the role,
visit, requested paths, reason, outcome, and paths actually disclosed.

### Retention

Workspaces, snapshot checkouts, and artifacts are retained for inspection:
there is no automatic cleanup, merge, or deletion. The operator may remove a
worktree manually when space is needed.

Related page: [worktree subagent delegation](delegation.md#worktree-subagent-delegation) explains how delegated children use parent role workspaces.
