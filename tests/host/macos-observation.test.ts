import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

// Dynamic import keeps the Darwin-only native boundary out of Linux test startup.
describe.runIf(process.platform === "darwin")("Darwin native observer", () => {
  it("reports restricted environment as unknown, not absent", async () => {
    const { observeMacProcesses } = await import("../../src/host/execution/macos/observer.js");
    const token = randomUUID();
    const child = spawn("/bin/sleep", ["10"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PI_CONDUCTOR_EXECUTION_ID: token },
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const result = await observeMacProcesses("observe", token, child.pid);
      expect(result.processes[0]?.marker).toBe("unknown");
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  });

  it("reads a Node child's marker without exposing token or environment", async () => {
    const { observeMacProcesses } = await import("../../src/host/execution/macos/observer.js");
    const token = randomUUID();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PI_CONDUCTOR_EXECUTION_ID: token },
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const result = await observeMacProcesses("observe", token, child.pid);
      expect(result.processes[0]).toMatchObject({
        marker: "present",
        startKind: "mach",
        uid: process.geteuid?.(),
        realUid: process.getuid?.(),
      });
      expect(JSON.stringify(result)).not.toContain(token);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  });
});
