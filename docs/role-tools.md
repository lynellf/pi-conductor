# Tools available to roles

← [Back to README](../README.md#what-this-is)

## Contents

- [Tools available to roles](#tools-available-to-roles)

Each role session gets tools from **two sources**, and the manifest's `tools:`
field is an **explicit allowlist**, not an extension of pi's defaults:

**1. Conductor-defined machine-event tools — always on, force-injected.**

`handoff` and `end` are defined by pi-conductor (TypeBox schemas in `src/seam/`,
factories in `src/host/tools.ts`) and registered as `customTools` on every role
session. They are added to the allowlist **regardless of what `tools:`
declares** (§8.1); omitting them from `tools:` emits a §13 warning but does not
disable them.

- **`handoff`** — terminate this role's session and route to another declared
  role. Workers may only hand off to the orchestrator; the orchestrator may hand
  off to any declared worker (subject to visit caps, §7.3). Every
  model-emitted handoff must include a non-empty actionable envelope:
  `status` (`ready`, `blocked`, or `complete`), `objective`, `summary`, and
  `requested_action`, alongside `target_role: Role`. `reason` and
  `suggests_next: Role` remain optional (the latter is workers-only and
  non-binding). `request_end?: boolean` defaults to `false`; it is valid only
  for a role named in `end_request_roles` handing back to the orchestrator with
  `status: complete`. An incomplete or unauthorized envelope returns an
  actionable error without advancing, persisting an accepted transition, or
  sealing the role session, so the role can correct it immediately.
- **`end`** — terminate this role's session and declare the run complete. Legal
  only from the orchestrator (§7.2). With `end_request_roles` configured, a
  normal `end` additionally requires a pending authorized request. A worker
  calling `end` produces a `transition_rejected` record with `legal_targets`
  surfaced. When configured, the host also requires a successful
  [end guard](end-guard.md) before accepting completion. Args: optional
  `reason: string`.

A role with pending delegated children receives a correction to wait or cancel
them before its handoff/end can be accepted. See [delegation controls](delegation.md#nonblocking-tasks-and-controls).

Both tools only **validate and record intent** into a per-session capture buffer
and return a terminating message after a valid capture; they do **not** call
`reduce` and do **not** persist — the loop owns those exclusively (§12.1). An
incomplete handoff is the exception: it records a host-observable validation
failure and returns a non-terminating correction prompt. After a role's first
valid `handoff`/`end` capture, the session is **sealed**: every other tool
short-circuits, so work-after-handoff cannot mutate the workspace.

**2. Shared SDK pass-through and isolated machine tools.**

For shared roles only, Pi-registry names selected by `tools:` are passed to
`createAgentSession({ tools: [...] })`; pi-conductor separately registers its
conductor-owned tools.

Isolated `worktree` and `copy` roles instead run a package-local `pi --mode rpc`
process with pi's built-in tools disabled. A host-loaded static machine-tools
extension provides `handoff` and `end`, plus only declared, path-confined file
tools; it also provides the host-mediated `delegate` bridge when authorized.
Other declared names do not receive the shared SDK pass-through registry.

For shared SDK roles, pi's built-in tool set (the authoritative reference is
**pi's own documentation** — see the links below; pi-conductor does not
redefine it) is, as of pi 0.79.x:

- **On by default (4):** `read`, `write`, `edit`, `bash`.
- **Additional built-in read-only tools, opt-in via `tools:` (3):** `grep`,
  `find`, `ls`.

Extension-registered or custom tool names the shared host pi session makes
available may also be named in `tools:`.

> **Note the interaction with the shared-SDK `tools:`-allowlist footgun
> below:** because pi-conductor treats `tools:` as an explicit allowlist (not
> an extension of pi's defaults), a shared role that wants standard file/shell
> access must **name** `read`/`write`/`edit`/`bash` explicitly — they are not
> inherited just because pi enables them by default in a plain `pi` session.
> `grep`/`find`/`ls` likewise must be named to be available.

**Reference — pi's tool documentation (the authority on the built-in set;
pi-conductor is a shared-SDK pass-through consumer):**

- [pi Quickstart — tools](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md)
  (the "By default, pi gives the model four tools" statement + the opt-in
  read-only tools).
- [pi SDK reference — tools](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
  (the `createReadTool` / `createWriteTool` / `createEditTool` /
  `createBashTool` / `createGrepTool` / `createFindTool` / `createLsTool`
  factories, the `tools` / `excludeTools` / `noTools` options, and custom-tool
  registration via `customTools` / `pi.registerTool`).

The same files ship inside the installed `@earendil-works/pi` package at
`packages/coding-agent/docs/quickstart.md` and `packages/coding-agent/docs/sdk.md`.

**Footgun — shared-SDK `tools:` is an explicit allowlist, not a
default-extension.** It selects the shared role's non-machine Pi tool names;
it does not add pi's four-tool default (`read`/`write`/`edit`/`bash`). A shared
role that omits `tools:` has no file or shell access, and no §13 warning fires
(the §13 check only triggers when `tools:` is present but missing
`handoff`/`end`). `handoff` and `end` remain conductor machine tools. Declare
every tool a role actually needs.

Related pages: [role configuration](role-config.md#roleconfig-fields),
[worktree subagent delegation](delegation.md#worktree-subagent-delegation),
and [the record stream](record-stream.md#hooking-into-the-record-stream).
