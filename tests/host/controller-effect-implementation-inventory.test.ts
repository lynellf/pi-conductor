import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  builtinEffectInventoryPaths,
  measureBuiltinEffectImplementations,
  measureProtectedImplementationFiles,
  verifyBuiltinEffectImplementations,
} from "../../src/host/controller/effect-implementation-inventory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("controller effect implementation inventory", () => {
  it("measures all three built-ins from actual module and runtime inventory bytes", async () => {
    const paths = await builtinEffectInventoryPaths();
    const implementations = await measureBuiltinEffectImplementations();
    expect(implementations.map((entry) => entry.kind)).toEqual([
      "git_integrate",
      "git_promote",
      "deliver_ref",
    ]);
    expect(paths.git_integrate).toContainEqual(expect.stringMatching(/git-effect\.(?:ts|js)$/));
    expect(paths.git_integrate).toContainEqual(
      expect.stringMatching(/trusted-git-validation\.(?:ts|js)$/),
    );
    expect(paths.deliver_ref).toContainEqual(expect.stringMatching(/remote-effect\.(?:ts|js)$/));
    expect(paths.runtime).toContainEqual(expect.stringMatching(/typebox\/build\/value\/check\//));
    expect(paths.shared).toContainEqual(expect.stringMatching(/controller-effect\.(?:ts|js)$/));
    expect(paths.runtime).toContain(await realpath(process.execPath));
    expect(paths.runtime).toContainEqual(expect.stringMatching(/typebox\/build\/.*\.(?:mjs|js)$/));
    expect(paths.runtime).not.toContainEqual(expect.stringMatching(/pnpm-lock\.yaml$/));
    for (const implementation of implementations)
      expect(implementation.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyBuiltinEffectImplementations(implementations)).resolves.toEqual(
      implementations,
    );
    const first = implementations[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("expected a built-in implementation");
    await expect(
      verifyBuiltinEffectImplementations([
        { ...first, digest: "0".repeat(64) },
        ...implementations.slice(1),
      ]),
    ).rejects.toThrow("inventory changed or was replaced");
  });

  it("binds the digest to actual bytes and stable file identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-effect-inventory-"));
    roots.push(root);
    const file = join(root, "implementation.js");
    await writeFile(file, "export const value = 1;\n", { mode: 0o600 });
    const first = await measureProtectedImplementationFiles([file], { runtime: "test" });
    expect(first.files[0]?.sha256).toBe(
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    );
    await writeFile(file, "export const value = 2;\n", { mode: 0o600 });
    const second = await measureProtectedImplementationFiles([file], { runtime: "test" });
    expect(second.digest).not.toBe(first.digest);
  });

  it("rejects symlink substitution instead of hashing its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-effect-symlink-"));
    roots.push(root);
    const target = join(root, "target.js");
    const link = join(root, "link.js");
    await writeFile(target, "export {};\n", { mode: 0o600 });
    await symlink(target, link);
    await expect(measureProtectedImplementationFiles([link], {})).rejects.toThrow(
      "canonical regular file",
    );
  });

  it("rejects a hard link outside the resolved pnpm dependency store", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-effect-hardlink-"));
    roots.push(root);
    const source = join(root, "store.js");
    const linked = join(root, "package.js");
    await writeFile(source, "export const value = 1;\n", { mode: 0o600 });
    await link(source, linked);

    await expect(measureProtectedImplementationFiles([linked], {})).rejects.toThrow(
      "canonical regular file",
    );
  });

  it("rejects a group-writable implementation before hashing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-effect-permissions-"));
    roots.push(root);
    const file = join(root, "implementation.js");
    await writeFile(file, "export const value = 1;\n", { mode: 0o600 });
    await chmod(file, 0o660);
    await expect(measureProtectedImplementationFiles([file], {})).rejects.toThrow(
      "canonical regular file",
    );
  });

  it("keeps the audited local runtime import closure complete", async () => {
    const inventory = await builtinEffectInventoryPaths();
    const all = new Set([
      ...inventory.shared,
      ...inventory.git_integrate,
      ...inventory.deliver_ref,
    ]);
    for (const path of all) {
      const source = await readFile(path, "utf8");
      const runtimeSource = source.replace(/import\s+type\s+[\s\S]*?from\s+["'][^"']+["'];?/g, "");
      for (const match of runtimeSource.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
        if (match[1]?.endsWith(".js") !== true) continue;
        const resolved = new URL(
          match[1].replace(/\.js$/, path.endsWith(".ts") ? ".ts" : ".js"),
          `file://${path}`,
        ).pathname;
        expect(all, `${path} imports unmeasured ${resolved}`).toContain(resolved);
      }
    }
  });
});
