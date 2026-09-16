import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveControllerDefinition,
  verifyControllerApproval,
} from "../../src/host/controller/approved-definition.js";
import { validateControllerHostApproval } from "../../src/host/controller/host-approval.js";
import { ControllerRuntimeStore } from "../../src/host/controller/runtime-store.js";
import { inventoryRuntimeTree } from "../../src/host/execution/sandbox/runtime-files.js";
import { parseControllerConfig } from "../../src/manifest/controller.js";
import { preparedRuntimeInventoryDigest } from "../../src/persistence/sandbox-runtime.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Captured runtimes are deliberately read-only. Restore directory modes for test cleanup.
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) =>
      execFile("chmod", ["-R", "u+w", root], (error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "controller-runtime-"));
  roots.push(root);
  const source = join(root, "source");
  const checkout = join(root, "checkout");
  const state = join(root, "state");
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(checkout);
  await mkdir(state, { mode: 0o700 });
  const bytes = "approved test executable";
  await writeFile(join(source, "bin/bash"), bytes, { mode: 0o700 });
  const config = parseControllerConfig({
    protocol_version: 1,
    controller_id: "planner",
    runtime_id: "runtime",
    executable: "/bin/bash",
    argv: ["literal;$HOME"],
    adapters: [],
    delegation: { allowed_subagents: ["worker"], max_children_per_session: 3, max_parallel: 2 },
  });
  const approval = validateControllerHostApproval({
    schema_version: 1,
    approval_id: "approved-v1",
    runtimes: [
      {
        runtime_id: "runtime",
        source_root: source,
        inventory_sha256: preparedRuntimeInventoryDigest(await inventoryRuntimeTree(source)),
        bootstrap_approval: {
          approvalId: "bash-v1",
          files: [{ path: "bin/bash", sha256: createHash("sha256").update(bytes).digest("hex") }],
        },
      },
    ],
    controllers: [
      {
        controller_id: config.controller_id,
        runtime_id: config.runtime_id,
        executable: config.executable,
        argv: config.argv,
      },
    ],
    adapters: [],
    schemas: [],
  });
  const definition = approveControllerDefinition("run", config, approval, 1);
  const options = {
    runStateDir: state,
    definition,
    protection: { primaryCheckout: checkout, stateRoots: [state], childWorkspaceRoots: [] },
    assertOpen: () => {},
  };
  return { root, source, state, config, approval, definition, options };
}

describe("approved controller runtime", () => {
  it("pins exact arguments and complete runtime authority; revocation cannot substitute a bundle", async () => {
    const f = await fixture();
    expect(verifyControllerApproval(f.definition.record, f.approval).record).toEqual(
      f.definition.record,
    );
    expect(() =>
      approveControllerDefinition("run", { ...f.config, argv: ["changed"] }, f.approval, 1),
    ).toThrow(/arguments/);
    const changed = { ...f.approval, approval_id: "new-approval" };
    expect(() => verifyControllerApproval(f.definition.record, changed)).toThrow(/changed|revoked/);
    expect(() =>
      verifyControllerApproval(f.definition.record, { ...f.approval, controllers: [] }),
    ).toThrow();
  });

  it("rejects an adapter capability upgrade before any capture", async () => {
    const f = await fixture();
    const schema = { type: "object" };
    const adapter = {
      id: "prepare",
      runtime_id: "runtime",
      executable: "/bin/bash",
      argv: [],
      input_schema_id: "packet",
      output_schema_id: "packet",
      capability: "read_only" as const,
    };
    const approval = validateControllerHostApproval({
      ...f.approval,
      adapters: [adapter],
      schemas: [{ schema_id: "packet", schema_digest: sha256Canonical(schema), schema }],
    });
    expect(() =>
      approveControllerDefinition(
        "run",
        { ...f.config, adapters: [{ ...adapter, capability: "private_staging" }] },
        approval,
        1,
      ),
    ).toThrow(/capability/);
  });

  it("captures once, verifies on resume and rejects a mutated sealed runtime", async () => {
    const f = await fixture();
    const store = new ControllerRuntimeStore(f.options);
    const snapshot = await store.prepare("runtime");
    expect(await store.prepare("runtime")).toBe(snapshot);
    expect(await new ControllerRuntimeStore(f.options).prepare("runtime")).toEqual(snapshot);
    expect(await readFile(join(snapshot.snapshotPath, "bin/bash"), "utf8")).toBe(
      "approved test executable",
    );
    await chmod(join(snapshot.snapshotPath, "bin/bash"), 0o700);
    await writeFile(join(snapshot.snapshotPath, "bin/bash"), "tampered");
    await expect(store.verify("runtime", snapshot)).rejects.toThrow();
    await expect(new ControllerRuntimeStore(f.options).prepare("runtime")).rejects.toThrow();
  });

  it("rejects unapproved content and a changed complete inventory", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "bin/bash"), "changed");
    await expect(new ControllerRuntimeStore(f.options).prepare("runtime")).rejects.toThrow(
      /approved|changed/,
    );
    await expect(new ControllerRuntimeStore(f.options).prepare("undeclared")).rejects.toThrow(
      /outside/,
    );
  });

  it("checks owner closure before capture", async () => {
    const f = await fixture();
    const store = new ControllerRuntimeStore({
      ...f.options,
      assertOpen: () => {
        throw new Error("closed epoch");
      },
    });
    await expect(store.prepare("runtime")).rejects.toThrow("closed epoch");
  });

  it("never replaces a snapshot when two preparation instances race", async () => {
    const f = await fixture();
    const attempts = await Promise.allSettled([
      new ControllerRuntimeStore(f.options).prepare("runtime"),
      new ControllerRuntimeStore(f.options).prepare("runtime"),
    ]);
    const durable = await new ControllerRuntimeStore(f.options).prepare("runtime");
    const successes = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" ? [attempt.value] : [],
    );
    expect(successes.length).toBeGreaterThan(0);
    for (const snapshot of successes) expect(snapshot.snapshotPath).toBe(durable.snapshotPath);
  });

  it("retains captured evidence without publishing metadata after the preparation deadline", async () => {
    const f = await fixture();
    let fences = 0;
    const store = new ControllerRuntimeStore(f.options);
    await expect(
      store.prepare("runtime", () => {
        fences += 1;
        if (fences >= 3) throw new Error("preparation deadline");
      }),
    ).rejects.toThrow("preparation deadline");
    const entries = await readdir(f.state, { recursive: true });
    expect(entries.some((entry) => entry.endsWith("bin/bash"))).toBe(true);
    expect(entries.some((entry) => entry.endsWith("snapshot.json"))).toBe(false);
    await expect(store.prepare("runtime")).rejects.toThrow("preparation deadline");
  });

  it("blocks metadata left with two links at the interrupted publication boundary", async () => {
    const f = await fixture();
    const snapshot = await new ControllerRuntimeStore(f.options).prepare("runtime");
    const parent = dirname(dirname(snapshot.snapshotPath));
    await link(join(parent, "snapshot.json"), join(parent, "snapshot-interrupted.tmp"));
    await expect(new ControllerRuntimeStore(f.options).prepare("runtime")).rejects.toThrow();
  });
});
