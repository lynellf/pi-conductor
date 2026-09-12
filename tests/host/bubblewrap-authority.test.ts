import { describe, expect, it } from "vitest";
import {
  isSandboxWritablePath,
  resolveSandboxWritableAuthority,
  type SandboxWritableRoot,
} from "../../src/host/execution/sandbox/writable-authority.js";

describe("sandbox writable authority", () => {
  it("does not interpret malformed persisted kinds as directory authority", () => {
    const malformed: unknown = [{ path: "src", kind: "invalid" }];
    expect(isSandboxWritablePath(malformed as readonly SandboxWritableRoot[], "src/a.ts")).toBe(
      false,
    );
  });

  it.each([
    ["../invalid", "src"],
    ["src", "src"],
  ])("rejects inconsistent projection roots %j", (...projectionRoots) => {
    expect(() =>
      resolveSandboxWritableAuthority({
        writablePaths: ["src"],
        selectedPaths: ["src/a.ts"],
        trackedPaths: ["src/a.ts"],
        projectionRoots,
      }),
    ).toThrowError(expect.objectContaining({ code: "sandbox-projection-inconsistent" }));
  });

  it("pins file and directory authority without granting writes to other projected inputs", () => {
    const authority = resolveSandboxWritableAuthority({
      writablePaths: ["tests", "src/a.ts"],
      selectedPaths: ["src/a.ts", "src/b.ts", "tests/a.test.ts", "package.json"],
      trackedPaths: ["src/a.ts", "src/b.ts", "tests/a.test.ts", "package.json"],
      projectionRoots: ["src", "tests", "package.json"],
    });
    expect(authority).toEqual([
      { path: "src/a.ts", kind: "file" },
      { path: "tests", kind: "directory" },
    ]);
    expect(isSandboxWritablePath(authority, "tests/new.test.ts")).toBe(true);
    expect(isSandboxWritablePath(authority, "src/a.ts")).toBe(true);
    expect(isSandboxWritablePath(authority, "src/a.ts/child")).toBe(false);
    expect(isSandboxWritablePath(authority, "src/b.ts")).toBe(false);
    expect(isSandboxWritablePath(authority, "package.json")).toBe(false);
    expect(isSandboxWritablePath(authority, "tests/.git/config")).toBe(false);
    expect(isSandboxWritablePath(authority, "tests/../src/b.ts")).toBe(false);
  });

  it.each([
    ["omitted materialized sibling", ["src/a.ts", "src/b.ts"]],
    ["omitted sparse subtree", ["src/a.ts", "src/hidden/b.ts"]],
    ["omitted unusual tracked name", ["src/a.ts", "src/has spaces.ts"]],
  ])("rejects directory expansion over an %s", (_name, trackedPaths) => {
    expect(() =>
      resolveSandboxWritableAuthority({
        writablePaths: ["src"],
        selectedPaths: ["src/a.ts"],
        trackedPaths,
        projectionRoots: ["src"],
      }),
    ).toThrowError(expect.objectContaining({ code: "sandbox-writable-excluded-descendant" }));
  });

  it("rejects creating siblings outside the profile root even with no excluded tracked file", () => {
    expect(() =>
      resolveSandboxWritableAuthority({
        writablePaths: ["src"],
        selectedPaths: ["src/feature/a.ts"],
        trackedPaths: ["src/feature/a.ts"],
        projectionRoots: ["src/feature"],
      }),
    ).toThrowError(expect.objectContaining({ code: "sandbox-writable-outside-projection" }));
  });

  it.each([
    ["nonselected file", ["src/b.ts"], "sandbox-writable-outside-projection"],
    ["nonexistent directory", ["empty"], "sandbox-writable-outside-projection"],
    ["overlapping roots", ["src", "src/a.ts"], "sandbox-writable-overlap"],
    ["reserved control", ["src/.git"], "sandbox-writable-invalid-path"],
    ["traversal", ["src/../other"], "sandbox-writable-invalid-path"],
  ])("rejects %s", (_name, writablePaths, code) => {
    expect(() =>
      resolveSandboxWritableAuthority({
        writablePaths,
        selectedPaths: ["src/a.ts"],
        trackedPaths: ["src/a.ts"],
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects a selected path absent from the complete tracked capture", () => {
    expect(() =>
      resolveSandboxWritableAuthority({
        writablePaths: ["src"],
        selectedPaths: ["src/a.ts"],
        trackedPaths: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "sandbox-projection-inconsistent" }));
  });
});
