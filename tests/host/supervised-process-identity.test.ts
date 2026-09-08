import { describe, expect, it, vi } from "vitest";

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({ readFile: readFileMock, readdir: vi.fn() }));

import { readProcessIdentity } from "../../src/host/execution/supervised-process-identity.js";

describe("readProcessIdentity permission races", () => {
  it("treats permission denied on a dying zombie as absent", async () => {
    readFileMock
      .mockResolvedValueOnce("1 (worker) R 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100")
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
      .mockResolvedValueOnce("1 (worker) Z 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100");

    await expect(readProcessIdentity(123, "execution")).resolves.toBeNull();
  });
});
