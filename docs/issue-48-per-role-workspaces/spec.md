# Spec: Per-role isolated workspaces and artifact handoffs (Issue #48)

**Status:** Draft — requires overseer acknowledgement before implementation (AGENTS.md
operating model).
**Source:** GitHub issue
[#48](https://github.com/lynellf/pi-conductor/issues/48) — "Support per-role isolated
workspaces and artifact handoffs".
**Relationship to existing authority:** This spec is *additive host-side machinery*.
It does not amend the archived FSM spec
(`docs/archive/orchestrator-fsm-spec.md` — the behavior authority; note that AGENTS.md
still points at the pre-archive path, fixed in Task T9), the delegation-lite spec
(`docs/issue-17-delegation-lite/spec.md`), ADR-001 (`docs/decisions/ADR-001-handoff-context.md`),
or the reducer/manifest/seam invariants in AGENTS.md. It *generalizes* two existing
precedents: issue #24 child file-tool confinement and issue #26 file-only children.

---

## 1. Problem and objective

Every conductor role session today spawns with `cwd` = the primary checkout
(`ProductionHost` passes `this.cwd` to `createAgentSession`; `SpawnRoleOptions.cwd`
exists but is ignored). A planner, implementer, or reviewer therefore all see the same
repository-visible workspace and the same host process environment: planner-owned
campaign state, sibling delegation worktrees, the run log, and (with a shell tool)
host home, credentials, and the Docker socket. Role prompts can *describe* authority
boundaries, but nothing *enforces* them.

Issue #48 asks conductor to make per-role isolation a **configurable, verifiable,
honestly-labeled** feature:

- start a role in an isolated container/workspace rooted at a pinned commit or task
  snapshot;
- configure read-only and writable mounts per role;
- provide handoffs as **explicit artifacts** rather than implicit access to a shared
  worktree;
- collect an implementer's patch/artifact for application in a trusted integration
  workspace;
- permit multiple read-only workers to operate concurrently from the same pinned
  snapshot;
- omit host home, credentials, sibling worktrees, and the Docker socket unless
  explicitly configured;
- keep the normal shared-workspace mode available as the default.

**Initial consumer** (per the issue): `lynellf/yugioh-dsl-compiler`'s multi-role corpus
campaign, where planner-owned ranking/exhaustion state must not be visible to the
implementer. That campaign's Docker/copy-based spike (external issue #394) validates the
concept; this spec makes the machinery a conductor feature with an honest guarantee
model.

**Success** (summary; full ACs in §16): a manifest can give any role an isolated
workspace with a declared mount policy; the host provisions, confines, collects, and
routes per that declaration; the resulting trust guarantee is computed, recorded, and
documented — never self-claimed.

## 2. Terminology

| Term | Meaning |
| --- | --- |
| **Integration workspace** | The primary checkout where the run was started (`host.cwd`). The only place trusted, final repository state lives. |
| **Pinned snapshot** | One resolved commit of the integration workspace, captured once at run start and immutable for the run. |
| **Role workspace** | The directory a role session runs in (`cwd`). For `shared` roles: the integration workspace (today's behavior). For isolated roles: a projected directory under the run state dir, or a container mount. |
| **Projection** | The set of roots a role may access: its workspace root plus declared `mounts`. |
| **Mount** | An additional root in a role's projection, with `writable: true | false`. Relative paths resolve inside the pinned snapshot; absolute paths are host paths. |
| **Artifact** | An explicit handoff deliverable: a model-declared file (validated + collected by the host) or a host-generated git patch of a writable workspace. |
| **Guarantee level** | Computed, never self-declared: `none` (shared), `confined` (projection + tool confinement, no OS boundary), `sandbox` (container OS boundary, no writable host mounts). |
| **Run state dir** | `<integration>/.pi-conductor/runs/<runId>/` — already holds `sessions/` and delegation `worktrees/`; gains `snapshots/`, `workspaces/`, `artifacts/`. |

## 3. Architecture and layering

All new machinery is **host-owned side effect**. The machine core is untouched:

- **Reducer / `MachineDefinition` / checkpoint** — unchanged. A role with a projected
  workspace transitions exactly as one without; the reducer never sees workspace or
  artifact data (invariants: host-agnostic core, reducer purity, payload `unknown`).
- **Manifest** (`src/manifest`) — additive optional `workspace` and `artifacts` blocks
  per role (host-only configuration, same status as `delegation`). Parsed for any
  manifest version; absent = `shared` semantics.
- **Seam** (`src/seam`) — one reserved, TypeBox-validated optional `artifacts` field on
  the `handoff` schema (single-schema invariant; `additionalProperties: true` kept).
- **Host** (`src/host/workspace/`, `src/host/artifacts/`, `src/host/rpc/` — new modules;
  `production-host.ts` spawn path extended) — owns: snapshot pinning, workspace
  provisioning, tool confinement, artifact collect/materialize, backend dispatch
  (in-process SDK vs container RPC), guarantee computation.
- **Persistence** (`src/persistence/log.ts`) — additive host-owned record variants
  (`snapshot_pinned`, `artifact_collected`, `artifact_rejected`) + an optional
  `workspace` descriptor on `session_started` (additive optional fields; existing
  consumers unaffected).
- **Extension/UX** — no new rendered surfaces in v1 (records carry the data; status
  line changes, if any, belong to the run-operator-controls spec).

Layer placement keeps every AGENTS.md invariant intact: the grep guard continues to
guard `src/core`, `src/manifest`, `src/seam`, `src/cost` (all new pure-layer code
imports no pi package; the container backend lives in `src/host`).

### Data flow (projected run)

```
run start ──► host pins snapshot (git rev-parse HEAD) ──► snapshots/<sha8>/ (read-only checkout)
                 │
role transition ─► host provisions role workspace (per manifest: shared | worktree | copy | container)
                 │    + materializes routed artifacts into workspace/artifacts/
                 │    + confined/limited tool policy per guarantee
                 ▼
        role session runs (cwd = role workspace)
                 │
role terminal ──► host collects declared artifacts + auto-patch (validated, capped)
                 │    ─► artifacts/<runId>/<role>-v<n>/  + records
                 ▼
        reduce → next role   (machine sees handoff shape only)
```

## 4. Manifest contract (additive)

```yaml
roles:
  - name: implementer
    max_visits: 3
    tools: [read, grep, edit, write, handoff, end]
    workspace:
      backend: worktree            # shared | worktree | copy | container
      source: snapshot             # snapshot | ref:<git-ref-or-commit>
      mounts:
        - path: .campaign          # relative → inside the pinned snapshot
          writable: false
        - path: /data/out          # absolute → host path (affects guarantee, §7)
          writable: true
      shell: none                  # none | container   (default none)
      image: docker.io/lynellf/conductor-sandbox:latest   # required iff backend: container
      network: bridge              # bridge | none (default bridge; none blocks provider egress)
    artifacts:
      auto_patch: true             # default true for writable worktree workspaces
      max_file_bytes: 1048576      # default 1 MiB per declared file artifact
      max_files: 32                # default per handoff
```

### Validation rules (extend the existing §13-style checks in `validateManifest`)

1. `workspace` and `artifacts` are optional; absent = `backend: shared`, all defaults.
   Existing manifests parse and behave byte-for-byte as today (REQ-008).
2. `backend: container` requires `image` (non-empty string). Hard error otherwise.
3. **Shell honesty (INV-003):** an isolated role (`backend` ≠ `shared`) that declares
   `bash` or `run` in `tools` while `backend` is `worktree`/`copy` is a **hard error**
   — a process tool defeats tool-layer confinement; the manifest must use
   `backend: container` (with `shell: container`) or drop the shell tool.
4. `shell: container` with `backend` ≠ `container` is a hard error (symmetric).
5. `source: ref:<ref>` requires the integration workspace to be a Git repository
   (checked at run start, typed error — see §6). `backend: copy` forces
   `artifacts.auto_patch: false` (a copy has no Git metadata to diff); the validator
   rejects the combination explicitly.
6. Mount paths must be non-empty; duplicate mount paths are rejected; a mount whose
   `writable` value is not boolean is a parse error.
7. **Guarantee downgrade (INV-004):** any role with a *writable absolute (host) mount*
   gets its computed guarantee capped at `confined` (never `sandbox`) and a manifest
   **warning** — a writable host bind mount is a real attack surface and must not be
   presented as isolation (AC-006).
8. `artifacts.*` values must be finite positive integers; `max_files` ≤ 64.
9. Adding `workspace`/`artifacts` blocks is an additive manifest change: users bump
   `version` per the existing manifest-versioning process (spec §10 rule 2); conductor
   does not gate the new fields on a minimum version (same precedent as `delegation`).

## 5. Workspace lifecycle (host-owned)

- **Snapshot pinning (run start, once).** Host resolves `source`:
  `snapshot` → `git rev-parse HEAD` of the integration workspace; `ref:<ref>` →
  `git rev-parse <ref>`. Non-Git integration + Git-requiring backend → typed
  run-start error (no silent fallback). The resolved commit is persisted in a
  `snapshot_pinned` record (`{ run_id, source, commit, ts }`) — resume re-uses the
  stored commit (never re-resolves a moved ref).
- **Shared snapshot checkout (read-only roles).** One
  `git worktree add --detach <runStateDir>/snapshots/<sha8> <commit>` per pinned
  commit, created lazily at the first read-only isolated role's spawn. All
  read-only isolated role visits **and** read-only delegation children share this one
  checkout (REQ-005, §11).
- **Writable role workspace.** Per role *visit*:
  `git worktree add -b conductor/<runId>/<role>-v<visitIndex> <runStateDir>/workspaces/<role>-v<visitIndex> <commit>`
  — the same naming/lifecycle pattern as delegation children
  (`src/host/delegation/worktree.ts` generalized to role visits).
- **Copy backend.** Non-Git roots or explicit choice: filesystem copy of the resolved
  revision's contents (Git repo: `git archive <commit> | tar -x`; non-Git: recursive
  copy of the integration tree). No Git metadata inside → `auto_patch` unavailable.
- **Container backend.** Workspace contents are the same worktree/copy directory; the
  container bind-mounts it (read-only unless the role's workspace is writable) plus
  conductor-managed dirs (§8). No second copy is made.
- **Retention (INV-005).** Workspaces, snapshot checkouts, and branches are retained
  for operator inspection exactly like delegation worktrees: **no automatic cleanup,
  no automatic merge, no deletion** (delegation-lite §8 "Never" list, extended).
- **Resume.** Workspace state is a deterministic function of
  `(runId, role, visitIndex, pinnedCommit, manifest)`: on resume the host re-creates
  whatever the in-flight visit needed (a `--detached` worktree path that disappeared
  is re-added; a branch that disappeared is re-created at the pinned commit; the
  visited session's own uncommitted work is lost, consistent with existing
  session-level resume semantics). No checkpoint field is added.
- **Runs without isolated roles** create no `snapshots/`, `workspaces/`, or
  `artifacts/` entries — zero footprint (REQ-008).

## 6. Tool policy and guarantee levels

The host enforces tools **in addition to** the manifest allowlist, per backend:

| Role shape (isolated) | File tools | Shell | Guarantee |
| --- | --- | --- | --- |
| read-only (only read/grep/find/ls declared) | confined to projection roots (issue #24 factory, generalized to multi-root + read-only) | none (validator rule 3) | `confined` (in-process) / `sandbox` (container) |
| writable (edit/write declared) | confined to its own workspace + mounts | none on worktree/copy; full `bash` inside container with `shell: container` | `confined` / `sandbox`* |
| `shared` (no `workspace` block) | exactly as today | as declared | `none` |

\* `sandbox` requires: no writable host mounts other than conductor-managed ones
(workspace/sessions/agentDir) and `network` ≠ `host`. Otherwise capped at `confined`
(rule 7) and the downgrade is recorded.

**Enforcement mechanism (in-process backends).** The issue-#24 child confinement
factory is generalized: built-in file tool definitions are replaced via
`customTools` with path-confined variants (reject absolute/`..` paths; `realpath`
containment check on the nearest existing ancestor — the existing verified approach).
`handoff`/`end`/`ask_user`/`handoff_context`/`delegate` are unaffected except that
`delegate` children of an isolated parent inherit the *parent's* projection as their
primary checkout base (see §11). A projected role's `SessionManager`/`agentDir`
remain host-run-state paths (invariant: host-owned session files, never in pi's
session tree).

**Honesty (INV-006).** `confined` means: no *sanctioned tool* of the role can read or
write outside the projection. In-process sessions share the host process (same UID,
environment); the guarantee is a **tool-surface** guarantee, and the README documents
it as such — mirroring the existing child-boundary language ("path confinement, not
an OS or credential sandbox"). `sandbox` means: OS namespace boundary; host home,
credentials, sibling worktrees, and the Docker socket are simply absent from the
container (§8). **No role or record may claim a guarantee stronger than its computed
level** (AC-006).

## 7. Artifact channel (explicit handoff deliverables)

### 7.1 Declaration

The `handoff` TypeBox schema gains one reserved optional field (single-schema
invariant; the same schema remains the seam contract):

```ts
artifacts?: Array<{
  path: string;        // 1–1024 chars, relative to the emitting role's workspace root
  description?: string; // ≤ 512 chars
}>                      // ≤ 64 entries
```

`artifacts` is reserved exactly like the host-owned `context_ref` (ADR-001): the model
declares it, the host verifies it, and `formatHandoffSeed` **filters it out of the
payload echo** so a recipient cannot mistake a stale model-echoed list for the
host-collected truth. Shape is validated at the seam; **availability is not** — see
7.3.

### 7.2 Collection (host, at role terminal, before the next spawn)

For each declaration the host:

1. resolves the path (`realpath`, nearest-existing-ancestor rule — issue #24) and
   **requires containment in the emitting role's workspace root or a writable mount**;
   escaping declarations are rejected (exfiltration vector — e.g. declaring
   `../../.ssh/id_rsa`);
2. enforces `max_file_bytes` / `max_files` (per the role's `artifacts` policy);
3. copies accepted files to
   `<runStateDir>/artifacts/<runId>/<role>-v<visitIndex>/` and appends one
   `artifact_collected` record per file
   (`{ run_id, role, visit_index, session_id, source_path, stored_path, kind: "declared" | "auto_patch", bytes, sha256, ts }`);
4. appends `artifact_rejected` (`{ run_id, role, session_id, path, reason: "outside_projection" | "size_cap" | "count_cap" | "missing", ts }`)
   for each rejected declaration.

**Auto-patch (writable `worktree` workspaces only, `auto_patch: true` default).** At
every terminal of a writable worktree workspace (`session_ended` **and**
`session_failed` — partial work is still worth inspecting), the host generates
`git diff` (+ `git add -N` for untracked, `--binary`) into
`artifacts/<runId>/<role>-v<n>/patch-<role>-v<n>.patch`. Model-independent,
exfiltration-free by construction (the host derives it from Git state). Patches from
failed terminals are stored and recorded but never routed into a seed — only an
accepted handoff routes artifacts.

### 7.3 Routing and materialization (host, on accepted transition)

1. The host materializes the emitting role's accepted artifacts into the **receiving
   role's** workspace under `artifacts/<emitting-role>-v<n>/` — read-only for
   read-only roles, writable otherwise.
2. `formatHandoffSeed` gains a host-generated **artifacts section** (parallel to the
   `context_ref` block): the stored artifact names + descriptions, and — for each
   rejected/failed collection — an explicit "not available" note so the recipient
   (and the orchestrator) can see the gap and route accordingly. A collection
   failure is a **semantic** deficiency for the orchestrator to resolve (spec §4
   two-channel rule), never a contract breach: the machine transition proceeds on a
   valid envelope.
3. **Shared-mode receivers** (no projection) get absolute run-state paths in the seed
   instead of materialized files (they can read the host filesystem; materializing
   into the integration workspace would be a host write the feature never makes).
4. **Orchestrator re-routing (REQ-004):** an orchestrator — including one with a
   projected (no-repo) workspace — routes prior artifacts by declaring them in its own
   handoff `artifacts` (paths within *its* workspace). The same collect→materialize
   pipeline applies, so the orchestrator needs no repository mount to move
   deliverables between workers (AC-004).
5. **Integration (REQ-003).** Patches are applied to the integration workspace **only**
   by a role with an explicit writable mount on it (e.g. an integrator role, or the
   orchestrator in shared mode) using its own tools, or by the operator
   (`git apply`). **The host never auto-applies** a patch or artifact to the
   integration workspace — same "explicit integration" rule as delegation-lite §8.

## 8. Backends

### 8.1 `shared` (default — unchanged)

No `workspace` block → exactly today's spawn (`cwd` = integration workspace, real
`agentDir`, declared tools). All existing behavior and tests are preserved unchanged
(REQ-008). `SpawnRoleOptions.cwd` continues to be ignored for shared roles.

### 8.2 `worktree` / `copy` (in-process, v1 core)

`ProductionHost.spawnRole` resolves the role's projected directory and passes it as
`cwd` to `createAgentSession` (the option already exists on `SpawnRoleOptions` — the
production host finally honors it), with the confined tool policy (§6) and the
role's model/effort/prompt/sessionDir/agentDir wiring unchanged. `StubHost` mirrors
the resolution with temp-dir workspaces so loop tests run without Git (same parity
pattern as existing delegation tests).

### 8.3 `container` (v1, spike-gated — Task T0/T8; user decision Q1)

Runs the SDK's bundled **`pi` CLI** (`node_modules/.bin/pi`, v0.79.1 verified:
`--mode rpc`, `--system-prompt`, `--session-dir`, `--no-extensions`/`--extension`,
`--tools`, `--model`, `--thinking`, `--api-key`) as a container process:

- `docker run --rm -w <workspace> -v <workspace>[:ro] -v <sessions> -v <agentDir>
  -v <machine-tools-ext> [--network bridge|none] -e <minimal env> <image> …` via
  `execFile` argv arrays; Docker **CLI** is probed at run start only when a role
  requires the backend — missing ⇒ typed error, no npm dependency added.
- **Environment scrub:** container env = `PATH`, `HOME=/home/agent` (private dir),
  `CONDUCTOR_*` run-config, and the role's provider key (`--api-key` or a copied
  `auth.json` in the mounted `agentDir`). Host home, other credentials, and the
  Docker socket are not mounted (AC: "omit host home, credentials, sibling worktrees,
  and Docker socket unless explicitly configured").
- **Machine tools:** a small shipped **machine-tools extension**
  (`src/host/rpc/machine-tools-extension.ts`, built to `dist/`) registers
  `handoff`/`end` for the container's pi. It is driven by a mounted per-run config
  file (role, declared targets — the extension is static code; no per-run closures).
  The host reconstructs the capture buffer by **observing the RPC event stream**
  (`tool_execution_*` events carry tool args) — the RPC analogue of the in-process
  `SessionSeam` capture buffer. `ask_user` is not provided to container roles (no TUI
  in the container; escalation stays `handoff` with `status: blocked`).
- **Usage/termination:** `message_end` events + `get_session_stats` map onto the
  existing `SessionState` accumulation; `get_state` supplies `sessionFile` (container
  path mapped back through the host `sessions/` mount); `abort`/`steer`/`follow_up`
  RPC commands map to the `RoleSession` seam. The `RoleSessionAdapter` gains an RPC
  implementation behind the same `RoleSession` interface, so the loop is unchanged.
- **Display:** `message_update`/`tool_execution_*` stream events feed the existing
  `DisplaySink` wiring.
- **Feasibility gate (T0):** a time-boxed spike must verify, against the installed
  SDK: (a) `--extension` loads a local file and its tool appears in the session;
  (b) a tool call's full args are observable in the JSONL stream; (c) usage +
  session file are retrievable; (d) abort/steer behave. **Spike fails ⇒ the container
  backend is deferred** (feature ships `shared`/`worktree`/`copy`; README marks
  `sandbox` unavailable; user decision Q1 governs whether that is acceptable).

## 9. Observability (additive records)

| Record | Contents | Emitted |
| --- | --- | --- |
| `snapshot_pinned` | `run_id, source, commit, ts` | once, at run start, if any isolated role exists |
| `workspace_provisioned` | `run_id, role, visit_index, backend, guarantee, workspace_path, snapshot_commit, ts` | at each isolated spawn |
| `artifact_collected` | `run_id, role, visit_index, session_id, source_path, stored_path, kind, bytes, sha256, ts` | per collected artifact/patch |
| `artifact_rejected` | `run_id, role, session_id, path, reason, ts` | per rejected declaration |
| `session_started` (+optional field) | `workspace?: { backend, guarantee, path_or_image }` | additive optional; existing consumers unaffected |

All are host-owned records appended via the existing `persistRecord`/record-emitter
fan-out; none enter the reducer, cost roll-ups, or `MachineDefinition`.

## 10. Concurrency (AC-005 interpretation)

The FSM remains **single-active** (archived spec §9.1/§14 — a non-negotiable
structural choice; FSM-parallel roles would be a hierarchical-machine re-architecture
and is explicitly **out of scope**). AC-005's "concurrent read-only workers" is
satisfied at the snapshot level: the one shared read-only snapshot checkout (§5) is
consumed by (a) multiple read-only role *visits* across the run and (b) read-only
delegation children running concurrently. Interference is impossible because no
read-only isolated session has any write path — tool-layer (in-process: confined
read-only tools, no shell) and OS-layer (container: read-only mount). A read-only
role whose manifest declares `edit`/`write` is simply not read-only: its workspace
is a per-visit writable worktree, like any writable role.

**Read-only delegation children** (used by the AC-005 test): the child tool
factory (`confine-tools.ts`) gains a read-only variant — read/grep/find/ls confined
to the shared snapshot checkout, no `edit`/`write`, still no shell. This is an
additive profile-level option; existing child profiles keep today's per-task
writable worktree behavior (see §11).

## 11. Compatibility

- **REQ-008 (zero behavior change):** a manifest without `workspace`/`artifacts`
  blocks produces byte-identical spawn options, seeds, records, and tool sets to
  today. The full existing test suite (including the default-fixture E2E, delegation
  E2E, and grep guard) must stay green with no test edits in Tasks T1–T6.
- Delegation children of an **isolated** parent: the child's "primary checkout" for
  clean-check + base-commit becomes the *parent's* workspace root, and the child
  worktree is created under the run state dir as today — the child sees at most what
  the parent saw (no privilege escalation via delegation; INV-007).
- The new **read-only child variant** (§10) is additive: a profile without it
  behaves exactly as today (per-task writable worktree, file-only tools).
- `handoff` schema change is additive-optional: payloads without `artifacts` validate
  identically.
- Resume: unchanged mechanics; workspace re-creation is deterministic (§5).
- `pnpm-workspace.yaml`/supply chain: **no new dependencies** (Docker is an external
  CLI, probed, optional).
- Non-Git projects: `copy` backend works; `worktree`/`container`-with-git-backend
  report a typed run-start error if any role requires them.

## 12. Security notes

- **Exfiltration via artifact declarations** is closed by realpath containment in the
  emitting role's projection + caps (§7.2); rejected attempts are recorded
  (`artifact_rejected`) — an implementer cannot name a file outside its workspace.
- **Artifact contents are untrusted input** to recipients: they are files, injected
  as workspace contents and listed in the seed by name/description only (never
  inlined) — a malicious artifact can prompt-influence the recipient but cannot
  escape the recipient's own projection.
- **Privilege monotonicity (INV-007):** a child session may never be granted a
  projection wider than its parent's.
- Container default `network: bridge` is documented as the cost of provider egress;
  `network: none` is available for local-provider setups. The Docker socket is never
  mounted (AC).
- `--api-key` is passed via argv/env to the container only, never logged in records;
  the `agentDir` mount is a conductor-private copy, not the user's `~/.pi/agent`.

## 13. Invariants (new, in addition to AGENTS.md's ten)

- **INV-001:** The reducer, `MachineDefinition`, and checkpoint are unchanged by
  this feature. Workspace/artifact data is host state only.
- **INV-002:** One pinned snapshot per run, captured at run start, immutable and
  recorded; all projections derive from it.
- **INV-003:** No isolated role on a non-container backend may have a process-
  execution tool (`bash`/`run`). Validator-enforced (hard error).
- **INV-004:** The guarantee level is computed from (backend, mounts, tools) and
  recorded per session; no configuration field self-declares it.
- **INV-005:** The host never auto-applies patches/artifacts to the integration
  workspace and never auto-deletes workspaces/branches (retention for inspection).
- **INV-006:** No record, seed, or UI text may claim a guarantee stronger than the
  role's computed level (README states the `confined` ≠ OS-sandbox caveat).
- **INV-007:** Delegation children of an isolated role inherit no wider projection
  than the parent role.
- **INV-008:** Shared-mode (no `workspace` block) behavior is byte-identical to
  today's (REQ-008).

## 14. Testing strategy

Table-driven, per repo convention. No live provider needed:

1. **Manifest (T1):** parse/validate tables for every rule in §4 (incl. all hard
   errors + the rule-7 downgrade warning), plus the absent-block = `shared` case.
   Existing manifest tests untouched.
2. **Seam (T2):** `artifacts` schema shape (valid/invalid tables: bad path chars,
   over-count, over-length, non-string), `context_ref`-style filtering from seed
   echo, backward-compat (no `artifacts` field).
3. **Workspace manager (T3):** temp real Git repos — pinning (clean/dirty primary,
   `ref:`, non-Git), `--detach` snapshot idempotency, per-visit branch naming,
   resume re-creation, no auto-cleanup.
4. **Confinement (T4):** real SDK child *and* role sessions (issue #24 pattern):
   canary files outside the projection; absolute, `..`, and symlink-escape paths
   rejected; in-projection ops succeed; read-only role has zero write-capable
   tools in `getActiveToolNames()`.
5. **Artifacts (T5):** collect/validate/cap/exfil tables; auto-patch round-trip
   (`git apply` in a fresh worktree reproduces the diff); materialization into
   receiver workspace + seed section; shared-receiver path listing; re-routing via
   an isolated orchestrator.
6. **E2E acceptance (T7, stub provider + real SDK sessions):** AC-001…AC-006 as
   scenarios (canary-based for AC-002/003; two concurrent read-only delegation
   children on one snapshot for AC-005; guarantee-label assertions for AC-006).
7. **Container (T8, gated):** unit tests of the RPC adapter with a recorded/mocked
   JSONL stream (no Docker in CI); one **manual** local Docker gate (documented in
   the task; CI never requires Docker).
8. Repository gate after every task: `pnpm typecheck && pnpm build && pnpm test &&
   pnpm lint && pnpm format:check && pnpm audit`.

## 15. Project structure and code style

```text
src/manifest/{types,parse,validate}.ts   # + workspace/artifact blocks (pure)
src/seam/schema.ts                        # + artifacts field on handoffArgsSchema
src/persistence/log.ts                    # + 3 record variants, 1 optional field
src/host/workspace/
  snapshot.ts        # pinning + shared read-only checkout
  manager.ts         # per-visit provisioning, retention, resume
  mounts.ts          # projection roots + guarantee computation
  confine-tools.ts   # generalized issue #24 multi-root confinement factory
src/host/artifacts/
  collect.ts         # validate + cap + copy + auto-patch
  route.ts           # materialize + seed section
src/host/rpc/        # (T8, gated) cli-adapter.ts, machine-tools-extension.ts, docker.ts
src/host/{production-host,stub-host,loop,seam}.ts  # wiring edits
tests/{manifest,seam,host}/…              # per-table suites above
```

Conventions unchanged: strict TS, named exports, JSDoc with spec pointers
(`// issue #48 §7.2`), ~400-LOC module ceiling (each module above is designed < 300),
Biome, pnpm, no `any`, no silent fallbacks (every validation failure is a typed
error or a recorded rejection), Biome-format.

## 16. Success criteria (mapped to the issue's ACs)

Requirement IDs referenced above map one-to-one to the issue's acceptance bullets
and proposal items: **REQ-001…REQ-006 = AC-001…AC-006**, **REQ-007** = container
backend (spike-gated), **REQ-008** = shared-mode back-compat (proposal bullet "a
normal shared-workspace mode should remain available").

- **AC-001** A conductor configuration can define a role's isolated workspace and
  mount policy. → §4 manifest block + validator rules; `workspace_provisioned`
  records show the policy in effect (T1/T4/T7).
- **AC-002** A read-only role cannot see or mutate files omitted from its
  projection. → Confined read-only tools, no shell (T4); canary E2E (T7); container
  variant (T8, gated).
- **AC-003** A writable worker can return a patch/artifact without direct access to
  the integration worktree. → Per-visit worktree + auto-patch + declared-artifact
  collection (T3/T5); canary read of the integration checkout rejected (T7).
- **AC-004** The orchestrator can route only declared handoff artifacts, without a
  repository mount. → Isolated-orchestrator re-routing E2E (T7).
- **AC-005** Concurrent read-only workers use the same immutable revision and cannot
  interfere. → Shared pinned snapshot + read-only enforcement, §10 (T7).
- **AC-006** Configuration makes the trust boundary explicit; bind-mounted writable
  host paths are not presented as isolation. → Computed guarantee + validator
  downgrade + records + README guarantee matrix (T6/T9).
- **AC-007 (new, from issue body)** Normal shared-workspace mode remains available
  and is the default with zero behavior change. → INV-008/REQ-008; full existing
  suite green (T1–T7).

## 17. Tasks

Ordered by dependency; each leaves the repository green (full gate, §14.8).
The implementer selects rolling slices from this list.

### Task T0 — Container feasibility spike (research, no code)

**Spike the `pi --mode rpc` substrate for the container backend** against the
installed SDK 0.79.1: load a local extension via `--extension`, observe a custom
tool call's args in the JSONL stream, retrieve usage (`get_session_stats`) and
`sessionFile` (`get_state`), exercise abort/steer, and run the CLI inside a scratch
Docker image with a mounted workspace. Write a go/no-go note in this file's change
log.
- **Acceptance:** each of the four parity items passes or fails with recorded evidence;
  worktree left unchanged.
- **Verify:** spike transcript committed as a docs note; `git status` clean.
- **Files:** docs note only (implementation: `no_changes`).
- **Scope:** research. **Depends:** none.

### Task T1 — Manifest `workspace` + `artifacts` contract

Add the additive role fields (§4) to `src/manifest/types.ts`, parsing in
`parse.ts`, and all §4 validation rules to `validate.ts`.
- **Acceptance:** every §4 rule table-tested (hard errors, downgrade warning,
  defaults); manifests without the blocks are byte-identical after parse.
- **Verify:** `pnpm test -- tests/manifest` + full gate; existing manifest tests
  unmodified.
- **Files:** `src/manifest/{types,parse,validate}.ts`, `tests/manifest/*.test.ts`.
- **Scope:** M. **Depends:** none.

### Task T2 — Seam `artifacts` schema + persistence records

Add the reserved `artifacts` field to `handoffArgsSchema` (single schema), seam
filtering in `formatHandoffSeed`, and the `snapshot_pinned` /
`workspace_provisioned` / `artifact_collected` / `artifact_rejected` record variants
+ optional `session_started.workspace` field.
- **Acceptance:** schema shape tables; seed echo never contains model-supplied
  `artifacts`; new records round-trip through the file log; reducer untouched.
- **Verify:** `pnpm test -- tests/seam tests/host tests/persistence` + full gate.
- **Files:** `src/seam/schema.ts`, `src/persistence/log.ts`, `src/core/types.ts`
  (optional field only), `src/host/loop.ts` (seed section hook), tests.
- **Scope:** M. **Depends:** T1.

### Checkpoint C1 — Foundation green (T1+T2)

Full gate green; no behavior change anywhere (INV-008).

### Task T3 — Workspace manager

`src/host/workspace/{snapshot,manager,mounts}.ts`: run-start pinning + record,
shared read-only `--detach` checkout, per-visit worktree/branch provisioning and
resume re-creation, retention (no cleanup). Generalize
`src/host/delegation/worktree.ts` primitives without changing delegation behavior.
- **Acceptance:** §5 lifecycle table-tested in temp real Git repos (pin clean/dirty/
  `ref:`/non-Git; idempotent snapshot; unique branch per visit; resume recreates;
  nothing deleted).
- **Verify:** `pnpm test -- tests/host/workspace` + full gate; delegation tests
  unmodified and green.
- **Files:** new `src/host/workspace/*`, delegation refactor, tests.
- **Scope:** M. **Depends:** T1.

### Task T4 — Spawn integration + tool confinement

`ProductionHost.spawnRole` honors the role's workspace (cwd, confined tool policy,
`shell` rule); generalized multi-root `confine-tools.ts` (from the issue #24
factory); `StubHost` parity with temp-dir workspaces; `SpawnRoleOptions.cwd`
finally respected for isolated roles (ignored for shared — INV-008).
- **Acceptance:** real SDK role session for a projected role has only confined
  file tools in `getActiveToolNames()` and rejects canary/traversal/symlink paths
  (issue #24 test pattern, extended to roles); shared-role spawn byte-identical.
- **Verify:** `pnpm test -- tests/host` + full gate.
- **Files:** `src/host/{production-host,stub-host,seam}.ts`,
  `src/host/workspace/confine-tools.ts`, `src/host/delegation/*` (shared factory),
  tests.
- **Scope:** L (splits into: confine-tools / production wiring / stub parity).
  **Depends:** T1, T3.

### Task T5 — Artifact pipeline

`src/host/artifacts/{collect,route}.ts`: terminal collection (containment, caps,
exfil rejection), auto-patch for writable worktrees, materialization into the
receiver workspace, seed artifacts section (incl. "not available" notes), shared-
receiver path listing, orchestrator re-routing.
- **Acceptance:** §7.2/§7.3 tables: declared file collect, exfil rejection
  recorded, caps enforced, auto-patch `git apply` round-trip, materialization +
  seed section, failed-terminal patches stored-but-not-routed.
- **Verify:** `pnpm test -- tests/host/artifacts` + full gate.
- **Files:** new `src/host/artifacts/*`, `src/host/{production-host,loop}.ts`,
  tests.
- **Scope:** M. **Depends:** T2, T3, T4.

### Task T6 — Guarantee computation + labeling

Compute per-session guarantee (backend × mounts × tools, §6 matrix) in
`mounts.ts`; emit it on `session_started.workspace` / `workspace_provisioned`;
wire the rule-7 downgrade warning.
- **Acceptance:** matrix table-tested (each of the §6 rows + downgrade cases);
  no record/seed/README text claims more than computed (INV-006).
- **Verify:** `pnpm test -- tests/host` + full gate.
- **Files:** `src/host/workspace/mounts.ts`, `src/host/production-host.ts`,
  `src/manifest/validate.ts`, tests.
- **Scope:** S. **Depends:** T4, T5.

### Task T7 — Acceptance E2E (stub provider + real SDK sessions)

Scenario tests for AC-001…AC-006 + AC-007 (canary files; isolated orchestrator
re-routing; two concurrent read-only delegation children on one shared snapshot;
guarantee-label assertions; shared-mode regression scenario).
- **Acceptance:** all six issue ACs + back-compat AC green as automated E2E.
- **Verify:** `pnpm test -- tests/host/e2e` + full gate.
- **Files:** `tests/host/e2e-workspaces.test.ts` (+ fixtures).
- **Scope:** M. **Depends:** T2–T6.

### Checkpoint C2 — v1 feature green (T1–T7)

All ACs green; README/draft wording ready for T9; **this state is the shippable
v1 if Q1 answers "no container"**.

### Task T8 — Container backend (gated on T0 go; user decision Q1)

`src/host/rpc/`: `pi --mode rpc` JSONL adapter behind `RoleSession`, machine-tools
extension + run-config mount, Docker spawn (argv, env scrub, mounts incl.
read-only snapshot, no Docker socket), display/usage/abort/steer mapping, `sandbox`
guarantee computation.
- **Acceptance:** §8.3 parity items pass against the real CLI (stream-mocked units
  in CI; one manual local Docker gate, documented); a container role cannot reach
  host home/`/var/run/docker.sock`; `sandbox` label only when §6\* conditions hold.
- **Verify:** `pnpm test -- tests/host/rpc` + full gate + manual Docker checklist.
- **Files:** new `src/host/rpc/*`, `src/host/{production-host,role-session}.ts`,
  tests.
- **Scope:** XL (splits into: rpc-adapter / machine-tools-ext / docker-spawn /
  parity+guarantee). **Depends:** T0 (go), T3, T4.

### Task T9 — Documentation

README: new "Per-role workspaces" section — config reference, **guarantee matrix**
(with the `confined` ≠ OS-sandbox caveat, matching the existing child-boundary
language), artifact pipeline, integration (`git apply`) walkthrough, retention/cleanup
guidance, sample 3-role campaign manifest (planner read-only / implementer writable
/ orchestrator hub). Fix AGENTS.md's stale `docs/orchestrator-fsm-spec.md` pointer
(archived). CHANGELOG entry.
- **Acceptance:** a reader can configure an isolated campaign from the README alone;
  guarantee claims match computed levels (INV-006).
- **Verify:** `pnpm lint` + docs read-through against §16.
- **Files:** `README.md`, `AGENTS.md`, `CHANGELOG.md`, sample manifest fixture.
- **Scope:** S. **Depends:** T7 (and T8 if in scope).

## 18. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| RPC event-shape parity gaps (args/usage/sessionFile/abort) | Container backend unusable or subtly wrong | T0 spike gates T8; on failure the feature ships `shared`/`worktree`/`copy` and `sandbox` is documented unavailable (Q1). |
| Confinement factory drift between children and roles | Two divergent path-escape surfaces | One generalized factory (`confine-tools.ts`) shared by delegation and roles; both test suites. |
| `customTools` override silently not applied by SDK version bump | Isolation silently absent | `getActiveToolNames()` + canary tests assert the *actual* session tools (existing issue #24 pattern) — drift fails tests. |
| Artifact exfiltration via declared paths | Credential/data leak | realpath containment in the emitter's projection + caps + recorded rejections (§12). |
| Workspaces/branches accumulate on disk | Disk growth | Retention is intentional (inspection value, INV-005); README documents `git worktree remove` / manual cleanup; run state dir is user-visible. |
| Dirty/odd primary checkout breaks pinning | Run can't start | Typed run-start errors with the exact failing role/backend (no silent fallback); `copy` backend covers non-Git. |
| Scope creep toward FSM-parallel roles | Re-architecture | §10 pins single-active; parallelism is a separate future feature. |

## 19. Assumptions and open user decisions

**ASSUMPTIONS I'M MAKING** (correct me before implementation):

1. "Workers" in the issue = conductor's FSM role sessions (single-active) plus
   delegation children; the issue's concurrency AC is satisfied at the snapshot
   level (§10), not by parallelizing the FSM.
2. In-process backends provide a *tool-surface* guarantee, honestly labeled
   `confined`; only the container backend earns `sandbox` (mirrors the repo's
   existing child-boundary honesty).
3. The consumer's implementer needs to *run tests*; under a non-container backend
   that means no shell (issue #26 precedent: verification moves to the parent/
   integrator). If the campaign needs an in-workspace shell on the worktree
   backend, that is unsatisfiable without `container` — hence Q1.
4. Pinned snapshot = the integration workspace's `HEAD` at run start; uncommitted
   primary changes are not part of any projection (operators commit first or use
   shared mode).
5. No new npm dependencies; Docker is an optional external CLI.

**Q1 (the one real product decision) — Is the `container` backend in v1 scope?**

- **Yes (recommended if any role needs a shell with a real isolation claim):**
  the issue's home/credentials/Docker-socket ACs are only fully met by the container
  backend; T0's spike gates the risk. Cost: the largest task (T8).
- **No:** v1 = `shared`/`worktree`/`copy` + artifacts + honest `confined` labeling
  (checkpoint C2 is the shippable feature); container becomes a fast-follow spec
  once the spike de-risks it. Read-only shell-less roles are fully isolated even
  without the container backend.

**Not asked (resolved from evidence):** snapshot pinning time (run start), artifact
cap defaults (1 MiB / 32 files / 64 max), patch application (role or operator only,
never the host), ask_user for container roles (excluded), UI changes (none in v1 —
records carry the data; no rendered-surface change, so no ui-reviewer gate is
required post-implementation).

## 20. Change notes / approval

- 2026-08-24 — Initial draft by senior-planner from issue #48; awaiting overseer
  acknowledgement (esp. Q1) before implementation. Implementation begins at Task T1
  (T0 in parallel) once acknowledged.
