import type { AgentSession } from "@earendil-works/pi-coding-agent";
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
});
