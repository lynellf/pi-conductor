import { expect, it } from "vitest";
import { validateBatch } from "../../src/host/delegation/validate-batch.js";
import type { SubagentProfile } from "../../src/manifest/types.js";
import type { DelegateSubmissionArgs } from "../../src/seam/schema.js";

const files = Array.from({ length: 80 }, (_, i) => `src/file-${i}.ts`);
const profile: SubagentProfile = {
  name: "worker",
  models: [{ model: "stub:model", effort: "medium" }],
  max_session_cost_usd: 1,
  system_prompt: "worker.md",
  completion_protocol: "minimal",
  execution: { backend: "bubblewrap", runtime_root: "runtime", writable_paths: ["src"] },
  workspace: { snapshot: { paths: ["src"], max_files: 100 } },
};
const task = {
  id: "first",
  subagent: "worker",
  objective: "repair",
  expected_output: "tested patch",
};
function admit(
  tasks: DelegateSubmissionArgs["tasks"] = [task],
  paths: readonly string[] | undefined = files,
  worker = profile,
  host = true,
) {
  return validateBatch(
    { tasks },
    { allowed_subagents: ["worker"], max_children_per_session: 4, max_parallel: 2 },
    [worker],
    4,
    { isGit: true, isClean: true, headCommit: "base" },
    paths,
    host,
  );
}

it("expands more than 64 files under approved roots without exposing siblings", () => {
  const result = admit([task], [...files, "private/evidence.txt", "src-sibling/no.ts"]);
  expect(result.valid).toBe(true);
  if (!result.valid) throw Error("rejected");
  expect(result.tasks[0]?.projectionPaths).toEqual([...files].sort());
  expect(Object.isFrozen(result.tasks[0]?.projectionPaths)).toBe(true);
});

it("later batches capture newly materialized files under the unchanged profile", () => {
  const first = admit();
  const next = admit([{ ...task, id: "later" }], [...files, "src/later.test.ts"]);
  expect(first.valid && first.tasks[0]?.projectionPaths).not.toContain("src/later.test.ts");
  expect(next.valid && next.tasks[0]?.projectionPaths).toContain("src/later.test.ts");
});

it("never expands a sparse parent's absent files", () => {
  const result = admit([task], ["src/one.ts"]);
  expect(result.valid && result.tasks[0]?.projectionPaths).toEqual(["src/one.ts"]);
});

it.each([
  [
    "an unavailable root",
    { ...profile, workspace: { snapshot: { paths: ["src", "tests"], max_files: 100 } } },
    "snapshot-root-not-materialized",
  ],
  [
    "a file-count overflow",
    { ...profile, workspace: { snapshot: { paths: ["src"], max_files: 79 } } },
    "snapshot-too-large",
  ],
  [
    "invalid bounds",
    { ...profile, workspace: { snapshot: { paths: ["src"], max_files: 10001 } } },
    "invalid-snapshot-policy",
  ],
  [
    "reserved roots",
    { ...profile, workspace: { snapshot: { paths: [".git"], max_files: 100 } } },
    "invalid-snapshot-policy",
  ],
] as const)("rejects %s before accepting a batch", (_name, worker, code) => {
  const result = admit([task], files, worker);
  expect(result.valid).toBe(false);
  if (result.valid) throw Error("accepted invalid snapshot");
  expect(result.errors.map((e) => e.code)).toContain(code);
});

it("rejects the whole batch when one snapshot task tries to specify exact files", () => {
  const result = admit([task, { ...task, id: "second", projection_paths: [files[0] ?? ""] }]);
  expect(result.valid).toBe(false);
  if (result.valid) throw Error("accepted ambiguous authority");
  expect(result.errors.map((e) => e.code)).toContain("snapshot-task-projection-conflict");
});

it("requires an approved sandbox adapter", () => {
  const result = admit([task], files, profile, false);
  expect(result.valid).toBe(false);
  if (result.valid) throw Error("accepted without sandbox");
  expect(result.errors.map((e) => e.code)).toContain("sandbox-backend-unavailable");
});

it("rejects mixed workspace modes from direct programmatic callers", () => {
  // Simulate malformed runtime input that bypassed the YAML parser.
  const mixed = {
    ...profile,
    workspace: {
      snapshot: { paths: ["src"], max_files: 100 },
      projection: { required: true, allowed_paths: ["src"] },
    },
  } as unknown as SubagentProfile;
  const result = admit([task], files, mixed);
  expect(result.valid).toBe(false);
  if (result.valid) throw Error("accepted ambiguous workspace");
  expect(result.errors.map((e) => e.code)).toContain("invalid-snapshot-policy");
});

it("rejects direct programmatic file-only snapshot profiles", () => {
  const { execution: _execution, ...fileOnly } = profile;
  const result = admit([task], files, fileOnly);
  expect(result.valid).toBe(false);
});

it("keeps the legacy default-projection ceiling", () => {
  const result = admit([task], files, {
    ...profile,
    workspace: { projection: { required: false, allowed_paths: ["src"], default_paths: ["src"] } },
  });
  expect(result.valid).toBe(false);
  if (result.valid) throw Error("legacy policy silently expanded");
  expect(result.errors.map((e) => e.code)).toContain("default-projection-too-large");
});
