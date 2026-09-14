import { expect, it } from "vitest";
import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

function source(snapshot: string, execution = true, extra = "") {
  return `version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: parent
    max_visits: 1
subagents:
  - name: worker
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: worker.md
    ${execution ? "execution: { backend: bubblewrap, runtime_root: runtime, writable_paths: [src] }" : ""}
    workspace:
      snapshot: ${snapshot}
${extra}
`;
}

it("parses and freezes an explicit sandbox snapshot without changing its roots", () => {
  const manifest = parseManifest(source("{ paths: [src, tests], max_files: 4096 }"));
  expect(manifest.subagents?.[0]?.workspace).toEqual({
    snapshot: { paths: ["src", "tests"], max_files: 4096 },
  });
  const workspace = manifest.subagents?.[0]?.workspace;
  expect(Object.isFrozen(workspace)).toBe(true);
  expect(Object.isFrozen(Object.values(workspace ?? {})[0])).toBe(true);
  expect(validateManifest(manifest).errors).toEqual([]);
});

it.each([
  ["missing roots", "{ max_files: 10 }"],
  ["non-array roots", "{ paths: src, max_files: 10 }"],
  ["non-string root", "{ paths: [1], max_files: 10 }"],
  ["missing limit", "{ paths: [src] }"],
  ["non-number limit", "{ paths: [src], max_files: many }"],
  ["unknown field", "{ paths: [src], max_files: 10, writable: true }"],
])("rejects %s snapshot shape", (_name, snapshot) => {
  expect(() => parseManifest(source(snapshot))).toThrow(ManifestParseError);
});

it("rejects a mixed projection and snapshot block", () => {
  expect(() =>
    parseManifest(
      source(
        "{ paths: [src], max_files: 10 }",
        true,
        "      projection: { required: true, allowed_paths: [src] }",
      ),
    ),
  ).toThrow(ManifestParseError);
});

it.each([
  "{ paths: [], max_files: 10 }",
  "{ paths: [src, src], max_files: 10 }",
  "{ paths: [src/a, src], max_files: 10 }",
  "{ paths: [../secret], max_files: 10 }",
  "{ paths: [/home], max_files: 10 }",
  '{ paths: ["src/*.ts"], max_files: 10 }',
  "{ paths: [.git], max_files: 10 }",
  "{ paths: [src/.git/config], max_files: 10 }",
  "{ paths: [.pi-conductor/runs], max_files: 10 }",
  "{ paths: [src], max_files: 0 }",
  "{ paths: [src], max_files: 10001 }",
  "{ paths: [src], max_files: 1.5 }",
  `{ paths: [${Array.from({ length: 65 }, (_, i) => `root-${i}`).join(", ")}], max_files: 100 }`,
])("rejects invalid snapshot authority %s", (snapshot) => {
  const manifest = parseManifest(source(snapshot));
  expect(validateManifest(manifest).errors.map((e) => e.code)).toContain(
    "invalid-subagent-snapshot",
  );
});

it("rejects a snapshot on a file-only profile", () => {
  const manifest = parseManifest(source("{ paths: [src], max_files: 100 }", false));
  expect(validateManifest(manifest).errors.map((e) => e.code)).toContain(
    "snapshot-requires-sandbox",
  );
});
