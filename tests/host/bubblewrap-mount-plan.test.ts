import { describe, expect, it } from "vitest";
import { buildSandboxMountPlan } from "../../src/host/execution/sandbox/mount-plan.js";

const input = () => ({
  runtime: {
    schemaVersion: 1 as const,
    canonicalSourcePath: "/source/runtime",
    sourceIdentity: {
      device: 1,
      inode: 2,
      mode: 0o40755,
      uid: 0,
      gid: 0,
      size: 0,
      mtimeMs: 1,
      ctimeMs: 1,
    },
    snapshotPath: "/state/runtime",
    snapshotIdentity: {
      device: 1,
      inode: 3,
      mode: 0o40755,
      uid: 0,
      gid: 0,
      size: 0,
      mtimeMs: 1,
      ctimeMs: 1,
    },
    inventoryDigest: "a".repeat(64),
    approvedInventoryDigest: "b".repeat(64),
    bootstrapApprovalId: "approved",
    inventory: [
      { path: "bin", type: "directory" as const },
      { path: "lib", type: "directory" as const },
      { path: "lib64", type: "directory" as const },
      { path: "bin/bash", type: "file" as const, executableMode: 0o100, sha256: "c".repeat(64) },
    ],
  },
  immutableWorkspaceRoot: "/state/base",
  privateWritableRoot: "/state/writable",
  bootstrapPath: "/state/bootstrap.sh",
  writableRoots: [
    { path: "src", kind: "directory" as const },
    { path: "package.json", kind: "file" as const },
  ],
  environment: { PATH: "/bin", LANG: "C" },
});
describe("Bubblewrap production mount plan", () => {
  it("constructs trusted destinations before sources and seals root before command", () => {
    const args = buildSandboxMountPlan(input());
    expect(args.slice(-2)).toEqual(["--remount-ro", "/"]);
    expect(args.indexOf("/workspace")).toBeLessThan(args.indexOf("/state/base"));
    expect(args).toEqual(
      expect.arrayContaining([
        "--ro-bind",
        "/state/base",
        "/workspace",
        "--bind",
        "/state/writable/src",
        "/workspace/src",
        "--ro-bind",
        "/state/bootstrap.sh",
        "/bootstrap/bootstrap.sh",
        "--setenv",
        "HOME",
        "/home/sandbox",
      ]),
    );
  });
  it("uses only derived runtime and writable sources", () => {
    const args = buildSandboxMountPlan(input());
    expect(args).not.toContain("/state/runtime/../../etc");
    expect(args).toContain("/state/runtime/bin");
  });
  it.each([
    [
      "runtime",
      {
        runtime: { ...input().runtime, inventory: [{ path: "home", type: "directory" as const }] },
      },
    ],
    [
      "overlap",
      {
        writableRoots: [
          { path: "src", kind: "directory" as const },
          { path: "src/a", kind: "file" as const },
        ],
      },
    ],
    ["path", { environment: { PATH: "/usr/bin" } }],
  ])("rejects invalid %s authority", (_n, change) =>
    expect(() => buildSandboxMountPlan({ ...input(), ...change })).toThrow());

  it.each([
    "home",
    "workspace",
    "proc",
    "bin/../home",
  ])("rejects unsupported runtime directory %s", (path) => {
    const fixture = input();
    fixture.runtime.inventory.push({ path, type: "directory" });
    expect(() => buildSandboxMountPlan(fixture)).toThrow();
  });

  it.each([
    ".git",
    "src/.pi-conductor/data",
    "src/../private",
    "src/*",
  ])("rejects reserved or ambiguous writable root %s", (path) => {
    expect(() =>
      buildSandboxMountPlan({ ...input(), writableRoots: [{ path, kind: "directory" }] }),
    ).toThrow();
  });

  it.each([
    "/bin/../../workspace",
    "/bin//child",
    "/bin:",
    "/bin/",
    "/bin/.",
  ])("rejects ambiguous PATH %s", (PATH) => {
    expect(() => buildSandboxMountPlan({ ...input(), environment: { PATH } })).toThrow();
  });

  it("bounds environment by UTF-8 bytes and accepts literal project spaces", () => {
    expect(() =>
      buildSandboxMountPlan({ ...input(), environment: { LANG: "é".repeat(513) } }),
    ).toThrow();
    expect(
      buildSandboxMountPlan({
        ...input(),
        writableRoots: [{ path: "src/my module", kind: "directory" }],
      }),
    ).toContain("/workspace/src/my module");
  });

  it.each([
    "/",
    "/state/runtime",
    "/state/base/nested",
  ])("rejects unsafe private source root %s", (privateWritableRoot) => {
    expect(() => buildSandboxMountPlan({ ...input(), privateWritableRoot })).toThrow();
  });
});
