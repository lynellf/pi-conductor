import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createRoleSessionAdapter } from "../../src/host/role-session.js";
import { SessionSeam } from "../../src/host/seam.js";

describe("createRoleSessionAdapter", () => {
  it("forwards native steering and exposes synchronous seal state", async () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    const clearQueue = vi.fn().mockReturnValue({ steering: ["queued"], followUp: [] });
    const prompt = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();
    const subscribe = vi.fn().mockReturnValue(() => undefined);
    const session = {
      steer,
      clearQueue,
      prompt,
      dispose,
      subscribe,
      systemPrompt: "role prompt",
      getActiveToolNames: () => ["handoff", "end"],
    } as unknown as AgentSession;
    const seam = new SessionSeam();
    const onDispose = vi.fn();
    const roleSession = createRoleSessionAdapter({
      role: "worker",
      session,
      seam,
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      model: "stub:model",
      effort: "medium",
      retries: 1,
      retryDelayMs: 5,
      onDispose,
    });
    const sealed = vi.fn();
    roleSession.subscribeSealed?.(sealed);

    await roleSession.steer?.("redirect");
    expect(roleSession.clearQueue?.()).toEqual({ steering: ["queued"], followUp: [] });
    expect(roleSession.isSealed?.()).toBe(false);
    seam.seal();
    expect(roleSession.isSealed?.()).toBe(true);
    expect(sealed).toHaveBeenCalledOnce();
    await roleSession.prompt("seed");
    await roleSession.dispose();

    expect(steer).toHaveBeenCalledWith("redirect");
    expect(prompt).toHaveBeenCalledWith("seed");
    expect(dispose).toHaveBeenCalledOnce();
    expect(onDispose).toHaveBeenCalledOnce();
  });

  it("inspects compaction only on the active public session branch", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-role-session-branch-"));
    try {
      const sessionDir = join(workdir, "sessions");
      await mkdir(sessionDir);
      const manager = SessionManager.create(workdir, sessionDir);
      const root = manager.appendCustomEntry("test", { branch: "root" });
      const activeLeaf = manager.appendCustomEntry("test", { branch: "active" });
      manager.branch(root);
      manager.appendCompaction("abandoned branch summary", root, 0);
      manager.branch(activeLeaf);

      expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
      expect(manager.buildContextEntries().some((entry) => entry.type === "compaction")).toBe(
        false,
      );

      const session = {
        sessionId: "native-session",
        sessionManager: manager,
        getContextUsage: () => ({ tokens: 12 }),
        getAllTools: () => [],
        messages: [],
      } as unknown as AgentSession;
      const adapter = createRoleSessionAdapter({
        role: "worker",
        session,
        seam: new SessionSeam(),
        sessionId: "role-session",
        sessionFile: join(sessionDir, "session.jsonl"),
        model: "stub:model",
        effort: "off",
        retries: 0,
        retryDelayMs: 0,
        onDispose: () => undefined,
      });

      expect(adapter.getTrajectoryContext?.().hasCompaction).toBe(false);

      manager.appendCompaction("active branch summary", root, 0);
      expect(adapter.getTrajectoryContext?.().hasCompaction).toBe(true);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
