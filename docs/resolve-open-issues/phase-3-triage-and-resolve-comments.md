# Phase 3 — Triage actions and resolution comments (issues #3 and #4)

**Spec authority:** Orchestrator handoff brief — "Plan triage actions
(labels, assignment) for both issues" and "Plan posting resolution
comments on the GitHub issues via `gh` CLI."
**Resolves:** #3 (closure comment) and #4 (closure comment).

## What I found

The handoff brief notes that the reporter applied no labels, assignees,
or milestones to either open issue, and the repo has a small, curated
label set (verified via `gh label list`):

```
bug, documentation, duplicate, enhancement, good first issue,
help wanted, invalid, question, wontfix
```

No issue templates are configured that would have auto-applied labels.
Both issues are filed by the repo owner (@lynellf), so the response
tone is "we investigated and addressed this" — professional, not
defensive, no apologies needed for things the reporter is implicitly
asking us to fix in their own repo.

## Triage actions

### Issue #4 — Broken page links within the readme

- **Labels:** `documentation` (existing label, exact fit; the
  reporter explicitly says "the readme also has link references to
  stale docs"). No `bug` — broken documentation links are
  documentation work, not code defects.
- **Assignee:** repo owner (self-assign is implicit; no `gh issue
  edit --add-assignee` needed if the closing PR is opened by the
  same person).
- **Milestone:** none — no milestones are configured in this repo
  (verified: `gh milestone list` returns empty).
- **Linked PR:** phase 1's PR (when opened) — link via
  `gh pr create` body that includes "Closes #4" so GitHub
  auto-closes the issue on merge.

### Issue #3 — Custom model support?

- **Labels:** `bug` (the multi-colon id rejection is a real
  conductor bug per phase 2's analysis) and `enhancement` (the
  reporter's broader ask — "investigate and follow-up" — implies
  improvement beyond a one-line fix). Both labels apply; the
  reporter's *symptom* is partially a bug and partially an
  unstated-feature ask (provider registration in pi's
  `ModelRegistry`).
- **Assignee:** repo owner (same as #4).
- **Milestone:** none.
- **Linked PR:** phase 2's PR — link via "Closes #3" in the PR
  body.

### Follow-up issues to file (not part of #3 / #4)

The triage surfaces two items that are *out of scope* for the two
open issues but worth tracking as separate work. File each as a
new issue before closing #3, so the repo's queue reflects the
follow-up:

- [x] **FU-1** "Add `docs/record-emitter-spec.md` covering the
      `subscribeToRecords` contract" — surfaces from phase 1's
      decision to repoint README references at
      `src/host/record-emitter.ts`. Labels: `documentation`,
      `enhancement`. Body: a one-paragraph spec sketch
      referencing the implementation; defer the full spec to
      the assignee.
- [x] **FU-2** "Pre-flight check: warn when `role.models[]`
      names an unregistered provider at manifest-load time" —
      surfaces from phase 2's "out of scope" note. Would change
      the §13 contract; a separate decision. Labels: `enhancement`.
      Body: brief motivation (the reporter's #3 also surfaces a
      `ModelNotFoundError` they may or may not have hit; a
      load-time warning would have caught it earlier).

## Resolution comments (post via `gh issue comment`)

### #4 comment

```
Closing — fixed by `<PR_URL>`. The README's `pi-coding-agent`
links were stale after pi moved to a monorepo; updated to point
at `earendil-works/pi` and `packages/coding-agent/docs/`. The
internal `docs/orchestrator-fsm-spec.md` link was repointed to
`docs/archive/orchestrator-fsm-spec.md` (the file's current
home — leaving it in the archive). The `docs/record-emitter-spec.md`
link was repointed to `src/host/record-emitter.ts` (the source
of truth today); a dedicated spec is filed as `<FU-1_URL>`.
```

(Replace `<PR_URL>` and `<FU-1_URL>` with the actual URLs after the
PRs and follow-up issues are filed.)

### #3 comment

```
Closing — investigation found two distinct things in this report:

1. **Conductor bug (fixed by `<PR_URL>`).** The manifest
   `ollama:robit/ornith:9b` was passing §13 validation but
   rejected at runtime with `MalformedModelEntryError`. The
   resolver's "exactly one colon" policy conflicts with the
   validator's regex and blocks Ollama-style `provider:model:tag`
   entries. Phase 2 changes the resolver to use the *first* colon
   as the separator, which is what the spec §8.1's "provider:id
   form" wording actually requires. After the fix, the
   `ollama:robit/ornith:9b` entry resolves to
   `(provider="ollama", id="robit/ornith:9b")` and is passed to
   pi's `ModelRegistry.find` like any other entry.

2. **Configuration requirement (not a bug).** The
   `(provider, id)` pair has to be registered in pi's
   `ModelRegistry` for `find` to return a model. The
   `ollama` provider from the example config needs to be
   registered with pi (typically via a pi extension or the
   settings JSON), separate from this extension. Without
   registration, the second stage will fail with
   `ModelNotFoundError` even after the resolver fix.
   The openai / openrouter / opencode-go providers in the
   example face the same constraint.

A follow-up issue `<FU-2_URL>` tracks a load-time check that
would surface the registration gap before a session starts.
```

(Replace `<PR_URL>` and `<FU-2_URL>` with the actual URLs after
they're filed.)

## Tasks

- [x] **T3.1** After phase 1's PR is merged: `gh issue close 4
      --comment "<body of #4 comment above, with PR URL
      filled in>"` (or, equivalently, post the comment first
      via `gh issue comment 4 --body "..."` and then `gh issue
      close 4`). Prefer the comment-then-close ordering so the
      comment is captured before the issue transitions to
      `closed` (GitHub's web UI hides the comment editor on
      closed issues, and CLI scripts occasionally race).
- [x] **T3.2** File FU-1: `gh issue create --label
      documentation,enhancement --title "Add docs/record-emitter-spec.md
      covering the subscribeToRecords contract" --body "..."`.
- [x] **T3.3** File FU-2: `gh issue create --label enhancement
      --title "Pre-flight check: warn on unregistered
      providers in role.models[]" --body "..."`.
- [x] **T3.4** After phase 2's PR is merged: `gh issue comment
      3 --body "<body of #3 comment, with PR_URL and FU-2_URL
      filled in>"`, then `gh issue close 3`.
- [x] **T3.5** Verify both issues now show `closed` state with
      the resolution comment visible: `gh issue view 3 --json
      state,closedAt,body` and same for #4.

## Label-application timing

- [x] **T3.6** Apply labels to #3 and #4 at the start of the
      triage work, *before* the fix lands — so the labels
      appear in the repo's open-issue views during the fix
      cycle. `gh issue edit 3 --add-label bug,enhancement`;
      `gh issue edit 4 --add-label documentation`.
- [x] **T3.7** Confirm via `gh issue view 3 --json labels` and
      `gh issue view 4 --json labels` that the labels were
      applied (the `gh label list` command's `bug` and
      `documentation` entries already exist; no label
      creation is needed).

## Verification

- `gh issue list --state closed --search "Broken page links"`
  returns issue #4 with the resolution comment in `body` (or
  use `gh issue view 4 --comments` to see the comment
  thread).
- `gh issue list --state closed --search "Custom model"` returns
  issue #3 with the resolution comment.
- `gh issue list --state open --label documentation` returns
  zero (or, if FU-1 was labeled `documentation`, exactly one).
- `gh issue list --state open --label enhancement` includes
  FU-1 and FU-2 (and the issues don't have stale labels).
- The CHANGELOG entries from phase 2 are present in
  `CHANGELOG.md` (the comment in #3 should reference the
  changelog version where the fix shipped).

## Out of scope

- Auto-applying labels via an issue template (deferred to a
  repo-config change; not what the reporter asked for).
- Milestones (none configured; adding one is its own decision).
- Cross-linking the issues to a project board (no project
  board exists; defer).
