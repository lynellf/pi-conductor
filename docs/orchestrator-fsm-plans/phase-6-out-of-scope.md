# Phase 6 — Genuinely out of v1 scope

> Sub-plan of `docs/orchestrator-fsm-plan.md`. These items are explicitly excluded from
> v1 and listed only to make the boundary unambiguous. Source spec: §9, §11.7, §14.

- Concurrency / parallel workers (§9.1 — explicitly single-active in v1)
- Graceful run-cap wind-down (warn 90% / hard-stop 100%, §11.7 future option)
- Inter-agent message bus (§14)
- A TUI extension viewing an SDK run (the pure core supports it; not built in v1). The
  SDK host emits stats events a future TUI could render.
- Live in-TUI widget / mid-run `/tree` inspection of role sessions (accepted loss
  under the SDK host; role sessions are host-managed, not branches of one TUI session)
