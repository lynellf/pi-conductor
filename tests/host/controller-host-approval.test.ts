import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadControllerHostApproval,
  validateControllerHostApproval,
} from "../../src/host/controller/host-approval.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function approval() {
  const schema = { type: "object", additionalProperties: false };
  return {
    schema_version: 1,
    approval_id: "controller-test-v1",
    runtimes: [
      {
        runtime_id: "runtime",
        source_root: "/operator/controller-runtime",
        inventory_sha256: "a".repeat(64),
        bootstrap_approval: {
          approvalId: "runtime-v1",
          files: [{ path: "bin/bash", sha256: "b".repeat(64) }],
        },
      },
    ],
    controllers: [
      {
        controller_id: "planner",
        runtime_id: "runtime",
        executable: "/bin/bash",
        argv: ["/opt/planner.sh"],
      },
    ],
    adapters: [
      {
        id: "prepare",
        runtime_id: "runtime",
        executable: "/bin/bash",
        argv: ["/opt/prepare.sh"],
        capability: "private_staging",
        input_schema_id: "packet",
        output_schema_id: "packet",
      },
    ],
    schemas: [{ schema_id: "packet", schema_digest: sha256Canonical(schema), schema }],
  };
}

describe("controller authority boundary", () => {
  it("freezes independent host authority and pins registered schema digests", () => {
    const source = approval();
    const value = validateControllerHostApproval(source);
    first(source.controllers).argv.push("changed");
    expect(value.controllers[0]?.argv).toEqual(["/opt/planner.sh"]);
    expect(Object.isFrozen(value.adapters)).toBe(true);
  });

  it.each([
    [
      "unknown capability",
      (value: ReturnType<typeof approval>) => {
        first(value.adapters).capability = "external_write";
      },
    ],
    [
      "changed schema",
      (value: ReturnType<typeof approval>) => {
        first(value.schemas).schema_digest = "c".repeat(64);
      },
    ],
    [
      "duplicate runtime",
      (value: ReturnType<typeof approval>) => {
        value.runtimes.push(first(value.runtimes));
      },
    ],
    [
      "unknown runtime",
      (value: ReturnType<typeof approval>) => {
        first(value.controllers).runtime_id = "missing";
      },
    ],
    [
      "unknown schema",
      (value: ReturnType<typeof approval>) => {
        first(value.adapters).input_schema_id = "missing";
      },
    ],
    [
      "runtime traversal",
      (value: ReturnType<typeof approval>) => {
        first(first(value.runtimes).bootstrap_approval.files).path = "../secret";
      },
    ],
    [
      "relative executable",
      (value: ReturnType<typeof approval>) => {
        first(value.controllers).executable = "bash";
      },
    ],
    [
      "NUL argument",
      (value: ReturnType<typeof approval>) => {
        first(value.controllers).argv.push("bad\0argument");
      },
    ],
  ])("rejects %s before execution", (_name, mutate) => {
    const value = approval();
    mutate(value);
    expect(() => validateControllerHostApproval(value)).toThrow();
  });

  it("loads only private, current-user, no-follow approval files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "controller-approval-"));
    directories.push(directory);
    const path = join(directory, "approval.json");
    await writeFile(path, JSON.stringify(approval()), { mode: 0o600 });
    expect((await loadControllerHostApproval(path)).approval_id).toBe("controller-test-v1");
    await chmod(path, 0o644);
    await expect(loadControllerHostApproval(path)).rejects.toThrow();
    await chmod(path, 0o4600);
    await expect(loadControllerHostApproval(path)).rejects.toThrow();
    await chmod(path, 0o600);
    const link = join(directory, "link.json");
    await symlink(path, link);
    await expect(loadControllerHostApproval(link)).rejects.toThrow();
  });
});

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("fixture is missing its required entry");
  return value;
}
