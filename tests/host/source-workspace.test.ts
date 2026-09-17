import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { measureGitEffectRepository } from "../../src/host/controller/git-effect.js";
import {
  createSourceWorkspaceService,
  type SourceWorkspaceGrant,
  SourceWorkspaceStore,
} from "../../src/host/controller/source-workspace.js";
import { createIndependentSourceWorktree } from "../../src/host/delegation/worktree.js";
import { ToolExecutionError } from "../../src/host/execution/tool-execution-controller.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await execute("chmod", ["-R", "u+w", root]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("source workspace store", () => {
  it("pins an unapproved patch into an independent immutable Git view", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const patch = await patchFor(fixture.repository, fixture.base, "src/value.txt", "two\n");
    const grant = await grantFor(fixture.repository);
    const records: unknown[] = [];
    const intent = await source.resolveIntent(
      request({
        patches: [
          {
            ref: "child-output/v2/patch",
            sha256: patch.sha256,
            byteLength: patch.bytes.length,
            acceptedBase: fixture.base,
          },
        ],
      }),
      grant,
      async () => ({
        bytes: patch.bytes,
        sha256: patch.sha256,
        byteLength: patch.bytes.length,
        acceptedBase: fixture.base,
        allowedPaths: ["src/value.txt"],
        audience: [{ kind: "controller" }],
      }),
    );
    records.push(intent);
    const prepared = await source.prepare(intent, grant, {
      resolvePatch: async () => ({
        bytes: patch.bytes,
        sha256: patch.sha256,
        byteLength: patch.bytes.length,
        acceptedBase: fixture.base,
        allowedPaths: ["src/value.txt"],
        audience: [{ kind: "controller" }],
      }),
      persist: async (record) => {
        records.push(record);
      },
      assertOpen: () => undefined,
    });

    expect(await readFile(join(prepared.checkoutPath, "src/value.txt"), "utf8")).toBe("two\n");
    expect(await git(fixture.repository, "rev-parse", "HEAD")).toBe(fixture.base);
    expect(await git(prepared.checkoutPath, "rev-parse", "HEAD")).toBe(prepared.headCommit);
    expect(await readFile(join(prepared.checkoutPath, ".git", "config"), "utf8")).not.toContain(
      fixture.repository,
    );
    expect(records.map((record) => (record as { type: string }).type)).toEqual([
      "source_workspace_intent",
      "source_workspace_started",
      "source_workspace_prepared",
    ]);
  });

  it("rejects a patch whose claimed digest differs before preparation starts", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const patch = await patchFor(fixture.repository, fixture.base, "src/value.txt", "two\n");
    await expect(
      source.resolveIntent(
        request({
          patches: [
            {
              ref: "child-output/v2/patch",
              sha256: patch.sha256,
              byteLength: patch.bytes.length,
              acceptedBase: fixture.base,
            },
          ],
        }),
        await grantFor(fixture.repository),
        async () => ({
          bytes: patch.bytes,
          sha256: "0".repeat(64),
          byteLength: patch.bytes.length,
          acceptedBase: fixture.base,
          allowedPaths: ["src/value.txt"],
          audience: [{ kind: "controller" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "patch-digest-mismatch" });
  });

  it("rejects a patch accepted against another base before applying or publishing it", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const patch = await patchFor(fixture.repository, fixture.base, "src/value.txt", "two\n");
    const grant = await grantFor(fixture.repository);
    const resolve = async () => ({
      bytes: patch.bytes,
      sha256: patch.sha256,
      byteLength: patch.bytes.length,
      acceptedBase: "0".repeat(40),
      allowedPaths: ["src/value.txt"],
      audience: [{ kind: "controller" as const }],
    });
    const intent = await source.resolveIntent(
      request({
        patches: [
          {
            ref: "child-output/v2/patch",
            sha256: patch.sha256,
            byteLength: patch.bytes.length,
            acceptedBase: "0".repeat(40),
          },
        ],
      }),
      grant,
      resolve,
    );
    const records: string[] = [];
    await expect(
      source.prepare(intent, grant, {
        resolvePatch: resolve,
        persist: async (record) => {
          records.push(record.type);
        },
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "patch-base-mismatch" });
    expect(records).toEqual(["source_workspace_started", "source_workspace_failed"]);
  });

  it("rejects Git symlinks before they can be checked out or copied", async () => {
    const fixture = await repositoryFixture();
    await execute("ln", ["-s", "/etc/passwd", join(fixture.repository, "src", "leak")]);
    await git(fixture.repository, "add", "src/leak");
    await git(fixture.repository, "commit", "--quiet", "-m", "unsafe link");
    await git(fixture.repository, "branch", "-f", "delivery");
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const intent = await source.resolveIntent(request({ patches: [] }), grant, async () => {
      throw new Error("no patch requested");
    });
    await expect(
      source.prepare(intent, grant, {
        resolvePatch: async () => {
          throw new Error("no patch requested");
        },
        persist: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "patch-path-denied" });
  });

  it("supports bounded multi-megabyte source trees and patches above legacy artifact limits", async () => {
    const fixture = await repositoryFixture();
    await writeFile(join(fixture.repository, "src", "large.txt"), "a".repeat(2 * 1024 * 1024));
    await git(fixture.repository, "add", "src/large.txt");
    await git(fixture.repository, "commit", "--quiet", "-m", "large source");
    await git(fixture.repository, "branch", "-f", "delivery");
    const base = await git(fixture.repository, "rev-parse", "HEAD");
    const patch = await patchFor(
      fixture.repository,
      base,
      "src/value.txt",
      `${"b".repeat(40 * 1024)}\n`,
    );
    expect(patch.bytes.length).toBeGreaterThan(32 * 1024);
    const source = await service(fixture.privateRoot);
    const grant = { ...(await grantFor(fixture.repository)), maxBytes: 4 * 1024 * 1024 };
    const intent = await source.resolveIntent(
      request({
        patches: [
          {
            ref: "child-output/v2/large-patch",
            sha256: patch.sha256,
            byteLength: patch.bytes.length,
            acceptedBase: base,
          },
        ],
      }),
      grant,
      async () => ({
        bytes: patch.bytes,
        sha256: patch.sha256,
        byteLength: patch.bytes.length,
        acceptedBase: base,
        allowedPaths: ["src/value.txt"],
        audience: [{ kind: "controller" }],
      }),
    );
    const prepared = await source.prepare(intent, grant, {
      resolvePatch: async () => ({
        bytes: patch.bytes,
        sha256: patch.sha256,
        byteLength: patch.bytes.length,
        acceptedBase: base,
        allowedPaths: ["src/value.txt"],
        audience: [{ kind: "controller" }],
      }),
      persist: async () => undefined,
      assertOpen: () => undefined,
    });
    expect(prepared.byteLength).toBeGreaterThan(1024 * 1024);
  });

  it("quarantines a conflicting ordered patch sequence without publishing a workspace", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const first = await patchFor(fixture.repository, fixture.base, "src/value.txt", "two\n");
    const second = await patchFor(fixture.repository, fixture.base, "src/value.txt", "three\n");
    const patches = new Map([
      ["child-output/v2/first", first],
      ["child-output/v2/second", second],
    ]);
    const claims = [...patches].map(([ref, patch]) => ({
      ref,
      sha256: patch.sha256,
      byteLength: patch.bytes.length,
      acceptedBase: fixture.base,
    }));
    const resolve = async (ref: string) => {
      const patch = patches.get(ref);
      if (patch === undefined) throw new Error("missing patch");
      return {
        bytes: patch.bytes,
        sha256: patch.sha256,
        byteLength: patch.bytes.length,
        acceptedBase: fixture.base,
        allowedPaths: ["src/value.txt"],
        audience: [{ kind: "controller" as const }],
      };
    };
    const intent = await source.resolveIntent(
      request({ patches: claims }),
      await grantFor(fixture.repository),
      resolve,
    );
    const records: string[] = [];
    await expect(
      source.prepare(intent, await grantFor(fixture.repository), {
        resolvePatch: resolve,
        persist: async (record) => {
          records.push(record.type);
        },
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "patch-conflict" });
    expect(records).toEqual(["source_workspace_started", "source_workspace_failed"]);
  });

  it("composes compatible parallel patches accepted against the same original base", async () => {
    const fixture = await repositoryFixture();
    await writeFile(join(fixture.repository, "src", "parallel.txt"), "parallel one\n");
    await git(fixture.repository, "add", "src/parallel.txt");
    await git(fixture.repository, "commit", "--quiet", "-m", "parallel baseline");
    await git(fixture.repository, "branch", "-f", "delivery");
    const base = await git(fixture.repository, "rev-parse", "HEAD");
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const patches = [
      {
        ref: "child-output/v2/parallel-value",
        patch: await patchFor(fixture.repository, base, "src/value.txt", "two\n"),
        path: "src/value.txt",
      },
      {
        ref: "child-output/v2/parallel-file",
        patch: await patchFor(fixture.repository, base, "src/parallel.txt", "parallel two\n"),
        path: "src/parallel.txt",
      },
    ];
    const resolve = async (ref: string) => {
      const entry = patches.find((candidate) => candidate.ref === ref);
      if (entry === undefined) throw new Error("missing patch");
      return {
        bytes: entry.patch.bytes,
        sha256: entry.patch.sha256,
        byteLength: entry.patch.bytes.length,
        acceptedBase: base,
        allowedPaths: [entry.path],
        audience: [{ kind: "controller" as const }],
      };
    };
    const intent = await source.resolveIntent(
      request({
        patches: patches.map((entry) => ({
          ref: entry.ref,
          sha256: entry.patch.sha256,
          byteLength: entry.patch.bytes.length,
          acceptedBase: base,
        })),
      }),
      grant,
      resolve,
    );
    const prepared = await source.prepare(intent, grant, {
      resolvePatch: resolve,
      persist: async () => undefined,
      assertOpen: () => undefined,
    });
    expect(await readFile(join(prepared.sourcePath, "src/value.txt"), "utf8")).toBe("two\n");
    expect(await readFile(join(prepared.sourcePath, "src/parallel.txt"), "utf8")).toBe(
      "parallel two\n",
    );
    expect(await git(prepared.checkoutPath, "rev-parse", "HEAD")).toBe(prepared.headCommit);
    expect(await readFile(join(prepared.checkoutPath, "src/value.txt"), "utf8")).toBe("two\n");
    expect(await readFile(join(prepared.checkoutPath, "src/parallel.txt"), "utf8")).toBe(
      "parallel two\n",
    );
    expect(await readFile(join(fixture.repository, "src/value.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(fixture.repository, "src/parallel.txt"), "utf8")).toBe(
      "parallel one\n",
    );
  });

  it("preserves an ambiguous prepared append without fabricating a failed source record", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const intent = await source.resolveIntent(request({ patches: [] }), grant, noPatch);
    const records: string[] = [];
    const ambiguous = new ToolExecutionError(
      "tool_persistence_ambiguous",
      "prepared append is unknown",
      {
        cleanup: "unconfirmed",
      },
    );
    await expect(
      source.prepare(intent, grant, {
        ...prepareOptions(),
        persist: async (record) => {
          if (record.type === "source_workspace_prepared") throw ambiguous;
          records.push(record.type);
        },
      }),
    ).rejects.toBe(ambiguous);
    expect(records).toEqual(["source_workspace_started"]);
  });

  it("rejects binary Git patches before a private workspace is staged", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const bytes = Buffer.from("GIT binary patch\nliteral 1\nA\n");
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await expect(
      source.resolveIntent(
        request({
          patches: [
            {
              ref: "child-output/v2/binary",
              sha256,
              byteLength: bytes.length,
              acceptedBase: fixture.base,
            },
          ],
        }),
        await grantFor(fixture.repository),
        async () => ({
          bytes,
          sha256,
          byteLength: bytes.length,
          acceptedBase: fixture.base,
          allowedPaths: ["src/value.txt"],
          audience: [{ kind: "controller" as const }],
        }),
      ),
    ).rejects.toMatchObject({ code: "patch-binary-denied" });
  });

  it("reprepares an original patch with a repair pinned to its synthetic prefix", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const original = await patchFor(fixture.repository, fixture.base, "src/value.txt", "two\n");
    const originalResolver = patchResolver(original, fixture.base);
    const firstIntent = await source.resolveIntent(
      request({
        patches: [
          {
            ref: "child-output/v2/original",
            sha256: original.sha256,
            byteLength: original.bytes.length,
            acceptedBase: fixture.base,
          },
        ],
      }),
      grant,
      originalResolver,
    );
    const first = await source.prepare(firstIntent, grant, {
      resolvePatch: originalResolver,
      persist: async () => undefined,
      assertOpen: () => undefined,
    });
    const child = join(fixture.privateRoot, "repair-child");
    await createIndependentSourceWorktree(child, "repair", first.headCommit, first.checkoutPath);
    const repair = await patchFor(child, first.headCommit, "src/value.txt", "three\n");
    const patches = new Map([
      ["child-output/v2/original", { patch: original, base: fixture.base }],
      ["child-output/v2/repair", { patch: repair, base: first.headCommit }],
    ]);
    const resolve = async (ref: string) => {
      const entry = patches.get(ref);
      if (entry === undefined) throw new Error("missing patch");
      return {
        bytes: entry.patch.bytes,
        sha256: entry.patch.sha256,
        byteLength: entry.patch.bytes.length,
        acceptedBase: entry.base,
        allowedPaths: ["src/value.txt"],
        audience: [{ kind: "controller" as const }],
      };
    };
    const repairedIntent = await source.resolveIntent(
      request({
        actionId: "prepare-repair",
        patches: [...patches].map(([ref, entry]) => ({
          ref,
          sha256: entry.patch.sha256,
          byteLength: entry.patch.bytes.length,
          acceptedBase: entry.base,
        })),
      }),
      grant,
      resolve,
    );
    const repaired = await source.prepare(repairedIntent, grant, {
      resolvePatch: resolve,
      persist: async () => undefined,
      assertOpen: () => undefined,
    });
    expect(await readFile(join(repaired.sourcePath, "src/value.txt"), "utf8")).toBe("three\n");
    expect(await git(fixture.repository, "rev-parse", "HEAD")).toBe(fixture.base);

    const wrongPrefix = new Map([
      ["child-output/v2/original", { patch: original, base: fixture.base }],
      ["child-output/v2/repair", { patch: repair, base: "0".repeat(40) }],
    ]);
    const resolveWrongPrefix = async (ref: string) => {
      const entry = wrongPrefix.get(ref);
      if (entry === undefined) throw new Error("missing patch");
      return {
        bytes: entry.patch.bytes,
        sha256: entry.patch.sha256,
        byteLength: entry.patch.bytes.length,
        acceptedBase: entry.base,
        allowedPaths: ["src/value.txt"],
        audience: [{ kind: "controller" as const }],
      };
    };
    const wrongIntent = await source.resolveIntent(
      request({
        actionId: "prepare-wrong-prefix",
        patches: [...wrongPrefix].map(([ref, entry]) => ({
          ref,
          sha256: entry.patch.sha256,
          byteLength: entry.patch.bytes.length,
          acceptedBase: entry.base,
        })),
      }),
      grant,
      resolveWrongPrefix,
    );
    await expect(
      source.prepare(wrongIntent, grant, {
        resolvePatch: resolveWrongPrefix,
        persist: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "patch-base-mismatch" });
  });

  it("reprepares an original ref with a native patch accepted against its unpatched synthetic head", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const unpatchedIntent = await source.resolveIntent(request({ patches: [] }), grant, noPatch);
    const unpatched = await source.prepare(unpatchedIntent, grant, prepareOptions());
    const child = join(fixture.privateRoot, "native-unpatched-child");
    await createIndependentSourceWorktree(
      child,
      "native",
      unpatched.headCommit,
      unpatched.checkoutPath,
    );
    const patch = await patchFor(child, unpatched.headCommit, "src/value.txt", "native two\n");
    const resolve = patchResolver(patch, unpatched.headCommit);
    const intent = await source.resolveIntent(
      request({
        actionId: "prepare-native-unpatched-repair",
        patches: [
          {
            ref: "child-output/v2/native-unpatched",
            sha256: patch.sha256,
            byteLength: patch.bytes.length,
            acceptedBase: unpatched.headCommit,
          },
        ],
      }),
      grant,
      resolve,
    );
    const prepared = await source.prepare(intent, grant, {
      resolvePatch: resolve,
      persist: async () => undefined,
      assertOpen: () => undefined,
    });
    expect(await readFile(join(prepared.sourcePath, "src/value.txt"), "utf8")).toBe("native two\n");
    expect(await readFile(join(fixture.repository, "src/value.txt"), "utf8")).toBe("one\n");
  });

  it("does not start private preparation after its controller scope aborts", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const intent = await source.resolveIntent(request({ patches: [] }), grant, noPatch);
    const abort = new AbortController();
    abort.abort();
    const records: string[] = [];
    await expect(
      source.prepare(intent, grant, {
        ...prepareOptions(),
        signal: abort.signal,
        persist: async (record) => {
          records.push(record.type);
        },
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(records).toEqual([]);
  });

  it("rejects a revoked consumer and a changed sealed checkout during open", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const records: unknown[] = [];
    const intent = await source.resolveIntent(request({ patches: [] }), grant, async () => {
      throw new Error("no patch requested");
    });
    records.push(intent);
    const prepared = await source.prepare(intent, grant, {
      resolvePatch: async () => {
        throw new Error("no patch requested");
      },
      persist: async (record) => {
        records.push(record);
      },
      assertOpen: () => undefined,
    });
    await expect(
      source.open(prepared.ref, grant, { kind: "native", profile_id: "reviewer" }),
    ).rejects.toMatchObject({ code: "consumer-denied" });

    await chmod(join(prepared.checkoutPath, "src"), 0o700);
    await chmod(join(prepared.checkoutPath, "src", "value.txt"), 0o600);
    await writeFile(join(prepared.checkoutPath, "src", "value.txt"), "tampered\n");
    await chmod(join(prepared.checkoutPath, "src", "value.txt"), 0o400);
    await chmod(join(prepared.checkoutPath, "src"), 0o500);
    await expect(source.open(prepared.ref, grant, { kind: "controller" })).rejects.toMatchObject({
      code: "workspace-corrupt",
    });
  });

  it("detects modified Git controls during open", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const intent = await source.resolveIntent(request({ patches: [] }), grant, async () => {
      throw new Error("no patch requested");
    });
    const prepared = await source.prepare(intent, grant, {
      resolvePatch: async () => {
        throw new Error("no patch requested");
      },
      persist: async () => undefined,
      assertOpen: () => undefined,
    });
    const controls = join(prepared.checkoutPath, ".git");
    await chmod(controls, 0o700);
    await chmod(join(controls, "config"), 0o600);
    await writeFile(join(controls, "config"), "[core]\n\tbare = false\n");
    await chmod(join(controls, "config"), 0o400);
    await chmod(controls, 0o500);
    await expect(source.open(prepared.ref, grant, { kind: "controller" })).rejects.toMatchObject({
      code: "workspace-corrupt",
    });
  });

  it("rejects opening a workspace through a changed authority policy", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const intent = await source.resolveIntent(request({ patches: [] }), grant, noPatch);
    const prepared = await source.prepare(intent, grant, prepareOptions());
    await expect(
      source.open(prepared.ref, { ...grant, maxBytes: grant.maxBytes + 1 }, { kind: "controller" }),
    ).rejects.toMatchObject({ code: "grant-revoked" });
  });

  it("detects extra and hard-linked source files during open", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const intent = await source.resolveIntent(request({ patches: [] }), grant, noPatch);
    const prepared = await source.prepare(intent, grant, prepareOptions());
    await chmod(prepared.sourcePath, 0o700);
    await writeFile(join(prepared.sourcePath, "extra"), "unexpected\n", { mode: 0o400 });
    await chmod(prepared.sourcePath, 0o500);
    await expect(source.open(prepared.ref, grant, { kind: "controller" })).rejects.toMatchObject({
      code: "workspace-corrupt",
    });

    const second = await repositoryFixture();
    const secondSource = await service(second.privateRoot);
    const secondGrant = await grantFor(second.repository);
    const secondIntent = await secondSource.resolveIntent(
      request({ patches: [] }),
      secondGrant,
      noPatch,
    );
    const secondPrepared = await secondSource.prepare(secondIntent, secondGrant, prepareOptions());
    const sourceDirectory = join(secondPrepared.sourcePath, "src");
    await chmod(sourceDirectory, 0o700);
    await execute("ln", [join(sourceDirectory, "value.txt"), join(sourceDirectory, "linked.txt")]);
    await chmod(sourceDirectory, 0o500);
    await expect(
      secondSource.open(secondPrepared.ref, secondGrant, { kind: "controller" }),
    ).rejects.toMatchObject({
      code: "workspace-corrupt",
    });
  });
});

function request(
  overrides: Partial<{
    patches: readonly { ref: string; sha256: string; byteLength: number; acceptedBase: string }[];
    actionId: string;
  }> = {},
) {
  return {
    runId: "run-118",
    controllerId: "controller",
    definitionDigest: "a".repeat(64),
    activationId: "activation",
    ownerEpoch: 1,
    actionId: "prepare-source",
    requestDigest: "b".repeat(64),
    sourceId: "repository",
    repositoryRef: "refs/heads/delivery",
    patches: [],
    ...overrides,
  };
}

async function service(root: string) {
  const store = await SourceWorkspaceStore.open({ root: join(root, "source-workspaces") });
  return createSourceWorkspaceService(store);
}

async function grantFor(repository: string): Promise<SourceWorkspaceGrant> {
  const measured = await measureGitEffectRepository(repository);
  return {
    sourceId: "repository",
    authorityDigest: "c".repeat(64),
    canonicalPath: measured.canonical_path,
    repositoryFingerprint: measured.fingerprint,
    allowedRefs: ["refs/heads/delivery"],
    allowedPaths: ["src"],
    maxFiles: 100,
    maxBytes: 1024 * 1024,
    consumers: [{ kind: "controller" }],
    allowGitView: true,
  };
}

async function repositoryFixture() {
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-conductor-source-workspace-"));
  roots.push(privateRoot);
  const repository = join(privateRoot, "repository");
  await execute("git", ["init", "--quiet", repository]);
  await git(repository, "config", "user.email", "test@example.invalid");
  await git(repository, "config", "user.name", "Test");
  await execute("mkdir", ["-p", join(repository, "src")]);
  await writeFile(join(repository, "src", "value.txt"), "one\n");
  await git(repository, "add", "src/value.txt");
  await git(repository, "commit", "--quiet", "-m", "base");
  await git(repository, "branch", "delivery");
  return { privateRoot, repository, base: await git(repository, "rev-parse", "HEAD") };
}

async function patchFor(repository: string, base: string, path: string, contents: string) {
  await writeFile(join(repository, path), contents);
  const { stdout } = await execute("git", ["diff", "--binary", base], { cwd: repository });
  await git(repository, "reset", "--hard", "--quiet", base);
  const bytes = Buffer.from(stdout);
  const { createHash } = await import("node:crypto");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, { cwd });
  return stdout.trim();
}

async function noPatch(): Promise<never> {
  throw new Error("no patch requested");
}

function prepareOptions() {
  return { resolvePatch: noPatch, persist: async () => undefined, assertOpen: () => undefined };
}

function patchResolver(patch: { readonly bytes: Buffer; readonly sha256: string }, base: string) {
  return async () => ({
    bytes: patch.bytes,
    sha256: patch.sha256,
    byteLength: patch.bytes.length,
    acceptedBase: base,
    allowedPaths: ["src/value.txt"],
    audience: [{ kind: "controller" as const }],
  });
}
