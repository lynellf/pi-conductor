import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/fixtures/bubblewrap/command-runner-host-death.fixture.ts"],
    pool: "forks",
    fileParallelism: false,
  },
});
