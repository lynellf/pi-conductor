import { describe, expect, it } from "vitest";
import { effectConflictLaneKeys } from "../../src/persistence/controller-effect-records.js";

const sha = (character: string) => character.repeat(64);

describe("local effect resource lanes", () => {
  it("shares a target lane and overlaps named resources across provider registrations", () => {
    const first = effectConflictLaneKeys({
      kind: "local_program",
      repository_fingerprint: sha("1"),
      target_ref: "refs/heads/main",
      resource_keys: ["pull-request", "release"],
    });
    const second = effectConflictLaneKeys({
      kind: "local_program",
      repository_fingerprint: sha("1"),
      target_ref: "refs/heads/release",
      resource_keys: ["release"],
    });
    expect(first).toHaveLength(3);
    expect(second.some((key) => first.includes(key))).toBe(true);
  });

  it("shares the legacy Git lane for the same repository target", () => {
    const local = effectConflictLaneKeys({
      kind: "local_program",
      repository_fingerprint: sha("1"),
      target_ref: "refs/heads/main",
      resource_keys: ["pull-request"],
    });
    const git = effectConflictLaneKeys({
      kind: "git",
      repository_fingerprint: sha("1"),
      target_ref: "refs/heads/main",
    });
    expect(local).toContain(git[0]);
  });
});
