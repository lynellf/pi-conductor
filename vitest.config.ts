import { defineConfig } from "vitest/config";

// Worker pool: single-fork, no file parallelism.
//
// The suite is small (24 files) and the only heavy dependency is
// `@earendil-works/pi-coding-agent` (~13 MB + native loader), imported
// only by `src/host` and pulled in by the `tests/host/*` files. The
// default `forks` pool with file parallelism on spawns up to
// `availableParallelism()-1` child node processes, each loading the
// full pi SDK into a fresh address space — that was the dominant
// memory-pressure driver (several GB across workers) observed during
// Phase 5. Single-fork loads the module graph once and reuses it
// across files, cutting peak memory by ~Nx while staying as fast or
// faster for a suite this size. `isolate: false` is safe here: no
// per-file global mutation that would leak across tests.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    reporters: ["default"],
    fileParallelism: false,
    isolate: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
