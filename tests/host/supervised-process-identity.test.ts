import { describe, expect, it, vi } from "vitest";

describe("readProcessIdentity permission races", () => {
  it("treats permission denied on a dying zombie as absent", async () => {
    const readFileMock = vi
      .fn()
      .mockResolvedValueOnce("1 (worker) R 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100")
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
      .mockResolvedValueOnce("1 (worker) Z 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    // The suite shares module caches; load this subject with its own mock and
    // restore the module registry so later real-process tests retain real I/O.
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actual, readFile: readFileMock }));
    try {
      const { readProcessIdentity } = await import(
        "../../src/host/execution/supervised-process-identity.js"
      );
      await expect(readProcessIdentity(123, "execution")).resolves.toBeNull();
      expect(readFileMock.mock.calls).toEqual([
        ["/proc/123/stat", "utf8"],
        ["/proc/123/environ", "utf8"],
        ["/proc/123/stat", "utf8"],
      ]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});
