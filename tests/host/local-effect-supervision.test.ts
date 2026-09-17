import { describe, expect, it } from "vitest";

import { runSupervisedProcess } from "../../src/host/execution/supervised-process.js";

describe("local effect process supervision controls", () => {
  it("preserves ambient environment inheritance by default", async () => {
    process.env.PI_CONDUCTOR_SUPERVISOR_DEFAULT_CANARY = "inherited";
    try {
      const result = await runSupervisedProcess({
        executionId: "supervisor-default-environment",
        file: process.execPath,
        args: [
          "-e",
          "process.stdout.write(process.env.PI_CONDUCTOR_SUPERVISOR_DEFAULT_CANARY ?? 'missing')",
        ],
        cwd: process.cwd(),
        timeoutMs: 2_000,
        onStart: () => undefined,
      });
      expect(result.stdout).toBe("inherited");
    } finally {
      delete process.env.PI_CONDUCTOR_SUPERVISOR_DEFAULT_CANARY;
    }
  });

  it("can start an executable without ambient environment variables", async () => {
    process.env.PI_CONDUCTOR_LOCAL_EFFECT_AMBIENT_CANARY = "must-not-leak";
    try {
      const result = await runSupervisedProcess({
        executionId: "local-effect-empty-environment",
        file: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify(process.env.PI_CONDUCTOR_LOCAL_EFFECT_AMBIENT_CANARY ?? null))",
        ],
        cwd: process.cwd(),
        env: {},
        inheritEnv: false,
        timeoutMs: 2_000,
        onStart: () => undefined,
      });

      expect(result.stdout).toBe("null");
    } finally {
      delete process.env.PI_CONDUCTOR_LOCAL_EFFECT_AMBIENT_CANARY;
    }
  });

  it("does not release stdin until process ownership is durably admitted", async () => {
    let releaseSpawn!: () => void;
    const spawnPersisted = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let outputObserved = false;
    const invocation = runSupervisedProcess({
      executionId: "local-effect-deferred-input",
      file: process.execPath,
      args: ["-e", "process.stdin.once('data', () => process.stdout.write('effect-started'))"],
      cwd: process.cwd(),
      stdin: "{}",
      deferStdinUntilSpawn: true,
      timeoutMs: 2_000,
      onStart: () => undefined,
      onSpawn: () => spawnPersisted,
      onOutput: (stream, chunk) => {
        if (stream === "stdout" && chunk.includes("effect-started")) outputObserved = true;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(outputObserved).toBe(false);

    releaseSpawn();
    await expect(invocation).resolves.toMatchObject({ stdout: "effect-started" });
  });
});
