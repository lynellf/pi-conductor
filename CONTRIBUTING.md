# Contributing

← [Back to README](README.md#documentation)

## Contents

- [Prerequisites](#prerequisites)
- [Verification commands](#verification-commands)
- [Invariants you must not break](#invariants-you-must-not-break)
- [Phases gate each other](#phases-gate-each-other)
- [Supply chain (pnpm)](#supply-chain-pnpm)

### Prerequisites

- Node.js ≥ 22.19.0, pnpm (matches the pi ecosystem). No npm/yarn.
- Install: `pnpm install` (also installs Lefthook git hooks via an allowlisted
  postinstall).

### Verification commands

```bash
pnpm typecheck        # tsc --noEmit (strict + noUncheckedIndexedAccess), incl. tests
pnpm build            # emits dist/ with .d.ts
pnpm test             # vitest run (incl. the grep-guard test)
pnpm lint             # biome check .  (lint + format check)
pnpm format:check     # biome format .
pnpm audit --prod     # supply-chain audit
```

`pre-push` (Lefthook) runs `pnpm lint`, `pnpm typecheck`, `pnpm test`
sequentially; any failure blocks the push. CI runs the same three directly.


### Invariants you must not break

The repository-wide invariants are maintained in [`AGENTS.md`](AGENTS.md). Read its non-negotiable invariants and code conventions before contributing.

### Phases gate each other

Work is sequenced in phases; don't start the next phase until the current one is
green and its plan checkboxes are ticked. Per-phase human review is not a gate —
the overseer reviews specs up front and gives feedback at the end of the loop
(see _Operating model_ in `AGENTS.md`). Touch only what your task asks for;
surface assumptions before implementing; if a task is non-trivial and no spec
exists, write one. See `AGENTS.md` for the full working agreement.

### Supply chain (pnpm)

Supply-chain settings and dependency-build rules are maintained in [`AGENTS.md`](AGENTS.md#supply-chain-pnpm). Follow that section when changing dependencies or pnpm configuration.
