# Durable continuity operations

Continuity is opt-in. Add the complete `continuity` block to a manifest:

```yaml
continuity:
  schema_version: 1
  require_handoff: true
  require_delegated_result: true
  seed_max_utf8_bytes: 32768
```

A required handoff or successful `report_result` must carry a v1 packet. The host
validates its TypeBox shape, UTF-8 budget, provenance, and evidence status before
accepting it. Do not include hidden reasoning, secrets, or transcripts.

Inspect a durable, read-only ledger with:

```text
conduct continuity-report --log-dir <run-log-dir> <run-id> --format json
conduct continuity-report --log-dir <run-log-dir> <run-id> --format markdown
conduct continuity-report --log-dir <run-log-dir> <run-id> --format okf-candidates
```

`okf-candidates` only renders verified, active findings. It never writes `.okf/`.
Malformed or unsupported historical records make the report fail closed; repair
or migrate the reader before relying on the affected ledger.
