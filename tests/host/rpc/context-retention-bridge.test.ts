import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RpcContextRetentionHost,
  requestRpcContext,
} from "../../../src/host/rpc/context-retention-bridge.js";

describe("RPC context retention file bridge", () => {
  it("round trips a request only after the host durability handler resolves", async () => {
    const directory = await mkdtemp(join(tmpdir(), "context-bridge-"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = await RpcContextRetentionHost.create(directory, {
      start: async () => blocked,
      outcome: async () => undefined,
      settled: async () => undefined,
    });
    const request = requestRpcContext(
      directory,
      "start",
      { requestId: "one", beforeTip: null, beforeTokens: 1 },
      { timeoutMs: 500 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await readdir(directory)).some((name) => name.endsWith(".request.json"))).toBe(true);
    release();
    await expect(request).resolves.toBeUndefined();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("returns handler rejection and times out without a host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "context-bridge-error-"));
    const host = await RpcContextRetentionHost.create(directory, {
      start: async () => {
        throw new Error("durability failed");
      },
      outcome: async () => undefined,
      settled: async () => undefined,
    });
    await expect(
      requestRpcContext(
        directory,
        "start",
        { requestId: "one", beforeTip: null, beforeTokens: 1 },
        { timeoutMs: 500 },
      ),
    ).rejects.toThrow("durability failed");
    await host.close();
    await expect(requestRpcContext(directory, "settled", {}, { timeoutMs: 20 })).rejects.toThrow(
      "timed out",
    );
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects malformed frames with an atomic error response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "context-bridge-malformed-"));
    const host = await RpcContextRetentionHost.create(directory, {
      start: async () => undefined,
      outcome: async () => undefined,
      settled: async () => undefined,
    });
    const requestPath = join(directory, "bad.request.json");
    await writeFile(requestPath, '{"kind":"start"}\n');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = JSON.parse(
          await readFile(join(directory, "bad.response.json"), "utf8"),
        ) as {
          ok?: boolean;
          error?: string;
        };
        expect(response.ok).toBe(false);
        expect(response.error).toContain("malformed");
        await host.close();
        await rm(directory, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error("timed out waiting for malformed-frame response");
  });
});
