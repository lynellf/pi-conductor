# Phase 1 — Add `docs/record-emitter-spec.md` (Issue #5)

**Resolves:** #5 (documentation, enhancement).
**Risk:** Low. Doc-only extraction; no behavior change.
**Spec authority:** Consolidates the contract currently documented in
`src/host/record-emitter.ts`'s JSDoc (with §4.1–§4.5 references) and exercised
by `tests/host/record-emitter.test.ts` (cases 1–9). This phase does not change
the contract — it gives the existing contract a stable reviewable surface
matching the repo convention (per `AGENTS.md`: "spec-driven-development
… no spec yet").

## What I found

- The full `subscribeToRecords` contract is in three places:
  1. **`src/host/record-emitter.ts` JSDoc** — has the module-level design
     (process-global registry, thread-safety, zero I/O) and the API contract
     sections referenced as `record-emitter-spec §4.1`–`§4.5`. The inline
     JSDoc is the only place the contract is written down.
  2. **`tests/host/record-emitter.test.ts`** — the 9 test cases that pin
     the contract: listener fires on every record, FIFO order, sync-throw
     isolation, async-rejection isolation, re-entrant subscribe, re-entrant
     unsubscribe, idempotent unsubscribe, empty-set no-op, run_id filter.
  3. **`README.md`** — references `src/host/record-emitter.ts` as the
     authority, then paraphrases the contract (FIFO, fire-and-forget async,
     sync-throw/async-rejection isolation, re-entrant subscribe/unsubscribe,
     idempotent unsubscribe, durable backstop).
- The JSDoc references "record-emitter-spec §4.1" etc. — the spec sections
  were always planned, the spec file just never landed. This phase lands it.
- The durable-backstop pattern is in the README only; the JSDoc covers the
  emitter surface but not the recovery contract. The spec doc is the right
  place for it.
- The README's `docs/orchestrator-fsm-spec.md` link is broken (text says
  top-level, target is the archive). **Out of scope** for this phase per
  `plan.md` — that's a separate doc chore.

## Tasks

- [ ] **T1.1** Create `docs/record-emitter-spec.md` with the following
      sections (drawn from existing JSDoc + tests + README, no new
      contract surface):

      - **§1 — Purpose** — one paragraph: in-process fan-out of every
        `PersistedRecord` the host persists to a run log. Read-side
        extension point for consumer extensions. Spec authority
        (the source file is implementation, this is contract).
      - **§2 — Module-level design** — process-global registry, single
        `Set<Listener>`, Node.js single-threaded safety, zero I/O,
        zero pi imports (the source file lives in `src/host/` but
        doesn't need to import pi).
      - **§3 — Public API** — `subscribeToRecords(listener): () => void`
        and `type Listener = (record: PersistedRecord) => void | Promise<void>`.
        Notes: subscribe is fire-and-forget; unsubscribe handle is
        idempotent; consumer is responsible for own auth, retry, batching.
      - **§4 — Contract** — the §4.1–§4.7 sections currently scattered:
        - **§4.1 Scoping** — emitter covers `host.persistRecord` only;
          direct `log.append` calls (e.g. `src/host/api.ts` for initial
          snapshot / crash reconciliation / `session_failed("crashed")` /
          crash snapshot) bypass the emitter. The durable JSONL log is
          the system of record; the emitter is best-effort fan-out.
        - **§4.2 FIFO delivery** — listeners fire in subscription order.
          `Set` preserves insertion order per ES2015; `notifyListeners`
          iterates the snapshot in order.
        - **§4.3 Fire-and-forget async** — async listeners are NOT awaited.
          The host calls `listener(record)` and moves on. Async
          rejections are caught via `.catch()` for suppression.
        - **§4.4 Sync-throw / async-rejection isolation** — sync `try/catch`
          wraps the call; async `.catch()` suppresses rejections. Neither
          affects the engine or other listeners.
        - **§4.5 Re-entrant subscribe / unsubscribe** — `notifyListeners`
          snapshots the set before iterating. New subscriptions made
          inside a listener fire on the NEXT record; unsubscribes take
          effect on the NEXT record. The current record's dispatch is
          unaffected.
        - **§4.6 Idempotent unsubscribe** — the returned handle closes
          over a `called` flag; the first call removes the listener,
          subsequent calls are no-ops. Calling the handle after the
          listener already self-unsubscribed via re-entrant
          unsubscribe is a no-op.
        - **§4.7 Empty-set fast path** — `notifyListeners` short-circuits
          when the set is empty (`listeners.size === 0` returns
          immediately). No-op for hosts that never have subscribers.
      - **§5 — Durable backstop** — the system-of-record is the
        `RecordLog` (per-run JSONL). The emitter is best-effort; missed
        records (e.g., the consumer process crashed) are recoverable by
        walking the log directory. Consumer extensions own watermark
        state; the spec makes no commitment on cross-process
        de-duplication.
      - **§6 — Out of scope** — what this contract is NOT:
        upload code, network primitives, server config, auth, retry,
        batching, rate-limiting, cross-process coordination, new
        record types, orchestrator-loop changes.
      - **§7 — Authoritative test cases** — link to
        `tests/host/record-emitter.test.ts`; enumerate the 9 cases
        (already named in the test file's top-of-file comment) and
        map each to a §4.x contract clause.

- [ ] **T1.2** Edit `src/host/record-emitter.ts` JSDoc:
      - Trim the module-level JSDoc to one paragraph of intent + a
        pointer to `docs/record-emitter-spec.md` as the authority.
        Keep the inline JSDoc on `Listener`, `subscribeToRecords`, and
        `notifyListeners` (those are the API surface; the spec doc
        mirrors them, the source file documents them next to the
        code).
      - Replace the inline `record-emitter-spec §4.1`-style
        references in the JSDoc with the actual section name from
        the new spec doc (e.g. `record-emitter-spec §4.1 — Scoping`).
        The references are already there; this task just confirms
        they resolve to the new doc.

- [ ] **T1.3** Edit `tests/host/record-emitter.test.ts`:
      - Update the top-of-file comment to point to
        `docs/record-emitter-spec.md` as the contract authority (it
        already says "spec §9, `docs/record-emitter-spec.md`" — confirm
        the link resolves and the §-section reference is correct
        given the new spec doc's structure).
      - No test bodies change. The 9 test cases are the authoritative
        contract; the spec doc maps to them in §7.

- [ ] **T1.4** Edit `CHANGELOG.md`:
      - Add a new `## [Unreleased]` entry above the current latest
        header (per the AGENTS.md / Phase 2 plan convention; matches
        the `### Bug fixes` heading used in `[0.5.1]`).
      - Suggested wording: "Document the `subscribeToRecords` contract
        surface in `docs/record-emitter-spec.md` (issue #5). No
        behavior change."

## Verification

- `docs/record-emitter-spec.md` exists at the path the README references
  (`src/host/record-emitter.ts` §1 says "the spec" — that link resolves
  to the new doc).
- All in-repo `record-emitter-spec` references resolve (grep check).
- `pnpm test` — no test body changed; the 9 cases in
  `tests/host/record-emitter.test.ts` still pass against the unchanged
  source.
- `pnpm typecheck` — clean (JSDoc edits only).
- `pnpm lint` — clean.
- Manual: render the spec in a Markdown viewer; confirm the §4.1–§4.7
  contract clauses map 1:1 to the JSDoc + tests, and the §1 purpose
  paragraph matches the README's framing.

## Out of scope

- Fixing the README's broken
  `[`docs/orchestrator-fsm-spec.md`](docs/archive/orchestrator-fsm-spec.md)`
  link. That's a separate doc chore.
- Restructuring the JSDoc into a separate types file. The source file is
  ~130 LOC including JSDoc; well under the AGENTS.md ~400-LOC ceiling.
  Splitting now would be premature.
- Adding a new test case. The 9 cases already pin the contract; a
  missing case would be a separate enhancement.

## Risk

Low. The contract surface is already tested (9 cases) and documented
(inline JSDoc). This phase consolidates the documentation without
changing behavior. The worst case is a typo in the new spec doc,
caught by `pnpm test` and the manual review.
