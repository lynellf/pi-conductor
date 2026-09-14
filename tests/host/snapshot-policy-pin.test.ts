import { describe, expect, it } from "vitest";

import type { PinSandboxPolicyInput } from "../../src/host/execution/sandbox/policy-pin.js";
import {
  assertPinnedSandboxPolicy,
  pinSandboxPolicy,
} from "../../src/host/execution/sandbox/policy-pin.js";
import type { SubagentSnapshotPolicy } from "../../src/manifest/types.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const execution = {
  backend: "bubblewrap" as const,
  runtime_root: ".pi/runtime",
  writable_paths: ["src"],
};

const selectedPaths = Array.from({ length: 65 }, (_, index) => `src/file-${index}.ts`);

type SnapshotMetadata = NonNullable<ReturnType<typeof pinSandboxPolicy>["workspaceSnapshot"]>;

function snapshotInput(snapshot: SubagentSnapshotPolicy): PinSandboxPolicyInput {
  return {
    execution,
    selectedPaths,
    trackedPaths: selectedPaths,
    snapshot,
  };
}

function withRecomputedDigest(
  policy: ReturnType<typeof pinSandboxPolicy>,
  workspaceSnapshot: SnapshotMetadata,
): unknown {
  const { digest: _digest, ...authority } = structuredClone(policy);
  const changed = { ...authority, workspaceSnapshot };
  return { ...changed, digest: sha256Canonical(changed) };
}

describe("snapshot sandbox policy authority", () => {
  it("pins a snapshot selection above the narrow 64-file limit with canonical metadata", () => {
    const pinned = pinSandboxPolicy(snapshotInput({ paths: ["src"], max_files: 100 }));

    expect(pinned.selectedPaths).toHaveLength(65);
    expect(pinned.workspaceSnapshot).toEqual({
      mode: "snapshot",
      paths: ["src"],
      max_files: 100,
    });
    expect(() => assertPinnedSandboxPolicy(JSON.parse(JSON.stringify(pinned)))).not.toThrow();
  });

  it("admits future files only under a writable root with an existing selected child", () => {
    const pinned = pinSandboxPolicy(snapshotInput({ paths: ["src"], max_files: 100 }));

    expect(pinned.projectionRoots).toEqual(["src"]);
    expect(pinned.writableRoots).toEqual([{ path: "src", kind: "directory" }]);
  });

  it("rejects caller-supplied projection roots that differ from the snapshot profile", () => {
    expect(() =>
      pinSandboxPolicy({
        ...snapshotInput({ paths: ["src"], max_files: 100 }),
        projectionRoots: ["tests"],
      }),
    ).toThrow("projection roots do not match");
  });

  it.each([
    { paths: ["src"], max_files: 10_001 },
    { paths: ["tests"], max_files: 100 },
    { paths: ["src"], max_files: 64 },
  ])("rejects an invalid snapshot profile before pinning: %j", (snapshot) => {
    expect(() => pinSandboxPolicy(snapshotInput(snapshot))).toThrow();
  });

  it.each([
    { mode: "snapshot" as const, paths: ["src"], max_files: 10_001 },
    { mode: "snapshot" as const, paths: ["tests"], max_files: 100 },
    { mode: "snapshot" as const, paths: ["src"], max_files: 64 },
  ])("rejects a retained snapshot change even with a recomputed digest: %j", (snapshot) => {
    const pinned = pinSandboxPolicy(snapshotInput({ paths: ["src"], max_files: 100 }));

    expect(() => assertPinnedSandboxPolicy(withRecomputedDigest(pinned, snapshot))).toThrow();
  });

  it("keeps excluded tracked descendants out of writable roots", () => {
    expect(() =>
      pinSandboxPolicy({
        ...snapshotInput({ paths: ["src"], max_files: 100 }),
        trackedPaths: [...selectedPaths, "src/unselected.ts"],
      }),
    ).toThrow("sandbox-writable-excluded-descendant");
  });

  it("requires an existing selected descendant for a new output root", () => {
    expect(() =>
      pinSandboxPolicy({
        ...snapshotInput({ paths: ["src"], max_files: 100 }),
        execution: { ...execution, writable_paths: ["src/output"] },
      }),
    ).toThrow("sandbox-writable-outside-projection");
  });

  it("retains unbounded legacy full-materialized policies without snapshot metadata", () => {
    const broad = Array.from({ length: 10_001 }, (_, index) => `src/legacy-${index}.ts`);
    const pinned = pinSandboxPolicy({
      execution,
      selectedPaths: broad,
      trackedPaths: broad,
    });

    expect(pinned.selectedPaths).toHaveLength(10_001);
    expect(pinned.workspaceSnapshot).toBeUndefined();
    expect(() => assertPinnedSandboxPolicy(JSON.parse(JSON.stringify(pinned)))).not.toThrow();
  });
});
