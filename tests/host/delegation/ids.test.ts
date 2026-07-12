/**
 * Tests for delegation/ids.ts — child ID and worktree identity generation.
 */

import { describe, expect, test } from "vitest";
import {
  generateBranchName,
  generateChildId,
  generateWorktreePath,
  isValidChildId,
} from "../../../src/host/delegation/ids.js";

describe("generateChildId", () => {
  test("returns a string starting with 'child-'", () => {
    const id = generateChildId(() => Buffer.from("0011223344556677", "hex"));
    expect(id.startsWith("child-")).toBe(true);
  });

  test("hex portion is 16 lowercase hex digits", () => {
    const id = generateChildId(() => Buffer.from("deadbeefcafebabe", "hex"));
    expect(id).toBe("child-deadbeefcafebabe");
  });

  test("matches isValidChildId", () => {
    const id = generateChildId(() => Buffer.from("1234567890abcdef", "hex"));
    expect(isValidChildId(id)).toBe(true);
  });

  test("generates unique IDs for different random inputs", () => {
    const id1 = generateChildId(() => Buffer.from("0000000000000001", "hex"));
    const id2 = generateChildId(() => Buffer.from("0000000000000002", "hex"));
    expect(id1).not.toBe(id2);
  });
});

describe("generateWorktreePath", () => {
  test("returns path beneath stateDir/worktrees/<childId>", () => {
    const path = generateWorktreePath("/tmp/pi-state", "child-0000000000000001");
    expect(path).toBe("/tmp/pi-state/worktrees/child-0000000000000001");
  });

  test("stateDir is used verbatim (no sanitization)", () => {
    const path = generateWorktreePath("/my/custom/path", "child-0000000000000002");
    expect(path).toBe("/my/custom/path/worktrees/child-0000000000000002");
  });
});

describe("generateBranchName", () => {
  test("returns conductor/<childId>", () => {
    const branch = generateBranchName("child-0000000000000001");
    expect(branch).toBe("conductor/child-0000000000000001");
  });

  test("always carries the conductor/ prefix", () => {
    const branch = generateBranchName("child-ffffffffffffffff");
    expect(branch.startsWith("conductor/")).toBe(true);
  });
});

describe("isValidChildId", () => {
  test("accepts a valid child-16hex format", () => {
    expect(isValidChildId("child-0000000000000001")).toBe(true);
    expect(isValidChildId("child-deadbeefcafebabe")).toBe(true);
  });

  test("rejects invalid formats", () => {
    expect(isValidChildId("child-")).toBe(false);
    expect(isValidChildId("child-000000000000000g")).toBe(false); // invalid hex
    expect(isValidChildId("child-000000000000000")).toBe(false); // too short
    expect(isValidChildId("child-00000000000000001")).toBe(false); // too long
    expect(isValidChildId("delegate-0000000000000001")).toBe(false); // wrong prefix
    expect(isValidChildId("")).toBe(false);
    expect(isValidChildId("something")).toBe(false);
  });
});
