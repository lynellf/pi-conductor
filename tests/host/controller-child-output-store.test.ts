import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type ChildOutputBinding,
  ChildOutputStore,
  type ChildOutputStoreError,
} from "../../src/host/controller/child-output-store.js";
import { childOutputNamespace } from "../../src/host/controller/child-output-store-contract.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.map(makeWritable));
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.length = 0;
});

function digest(character: string): string {
  return character.repeat(64);
}

function binding(overrides: Partial<ChildOutputBinding> = {}): ChildOutputBinding {
  return {
    runId: "run-116",
    definitionDigest: digest("a"),
    childId: "child-1",
    taskId: "review-1",
    acceptedBase: digest("b"),
    terminal: { ordinal: 17, recordDigest: digest("c") },
    producerProfileId: "reviewer",
    output: { id: "review-report", path: "reports/review.txt", kind: "report" },
    outputPolicyDigest: digest("d"),
    mediaType: "text/plain",
    audience: [
      { kind: "native", profile_id: "implementer" },
      { kind: "adapter", adapter_id: "integration" },
    ],
    ...overrides,
  };
}

async function store(
  hook?: (stage: "after-rename-before-journal") => void,
): Promise<ChildOutputStore> {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-child-output-"));
  directories.push(root);
  return ChildOutputStore.open({ root, ...(hook === undefined ? {} : { testHook: hook }) });
}

describe("Issue #116 native child-output store", () => {
  it("seals exact binary bytes under the child terminal identity and enforces its audience", async () => {
    const outputs = await store();
    const bytes = Buffer.from([0, 255, 8, 13]);
    const published = await outputs.publish({ binding: binding(), bytes, inputAudience: null });
    expect(Object.isFrozen(published.binding)).toBe(true);
    expect(Object.isFrozen(published.binding.audience)).toBe(true);

    await expect(
      outputs.read({
        ref: published.ref,
        principal: { kind: "native", profile_id: "implementer" },
        expectedBinding: binding(),
      }),
    ).resolves.toMatchObject({ bytes, binding: binding() });
    await expect(
      outputs.read({
        ref: published.ref,
        principal: { kind: "controller" },
        expectedBinding: binding(),
      }),
    ).rejects.toMatchObject({
      code: "child-output-audience-denied",
    } satisfies Partial<ChildOutputStoreError>);
  });

  it("rejects wrong child, base, path, and explicit size limits without truncating", async () => {
    const outputs = await store();
    await expect(
      outputs.publish({
        binding: binding({ output: { id: "bad", path: "../secret", kind: "report" } }),
        bytes: Buffer.from("x"),
        inputAudience: null,
      }),
    ).rejects.toMatchObject({
      code: "child-output-binding-invalid",
    } satisfies Partial<ChildOutputStoreError>);
    await expect(
      outputs.publish({
        binding: binding(),
        bytes: Buffer.alloc(128 * 1024 + 1),
        inputAudience: null,
      }),
    ).rejects.toMatchObject({
      code: "child-output-oversized",
    } satisfies Partial<ChildOutputStoreError>);
    const published = await outputs.publish({
      binding: binding(),
      bytes: Buffer.from("sealed"),
      inputAudience: null,
    });
    await expect(
      outputs.read({
        ref: published.ref,
        principal: { kind: "adapter", adapter_id: "integration" },
        expectedBinding: binding({ childId: "child-other" }),
      }),
    ).rejects.toMatchObject({
      code: "child-output-binding-mismatch",
    } satisfies Partial<ChildOutputStoreError>);
    await expect(
      outputs.read({
        ref: published.ref,
        principal: { kind: "adapter", adapter_id: "integration" },
        expectedBinding: binding({ runId: "run-other" }),
      }),
    ).rejects.toMatchObject({
      code: "child-output-binding-mismatch",
    } satisfies Partial<ChildOutputStoreError>);
    await expect(
      outputs.read({
        ref: published.ref,
        principal: { kind: "adapter", adapter_id: "integration" },
        expectedBinding: binding({ acceptedBase: digest("f") }),
      }),
    ).rejects.toMatchObject({
      code: "child-output-binding-mismatch",
    } satisfies Partial<ChildOutputStoreError>);
  });

  it("recovers the deterministic sealed artifact after a crash before its journal acknowledgement", async () => {
    const outputs = await store(() => {
      throw new Error("crash after rename");
    });
    const value = binding();
    await expect(
      outputs.publish({ binding: value, bytes: Buffer.from("durable"), inputAudience: null }),
    ).rejects.toThrow("crash after rename");
    const recovered = await outputs.recover(value);
    await expect(
      outputs.read({
        ref: recovered.ref,
        principal: { kind: "native", profile_id: "implementer" },
        expectedBinding: value,
      }),
    ).resolves.toMatchObject({ binding: value, bytes: Buffer.from("durable") });
  });

  it("does not let an output grant widen the audience of private input evidence", async () => {
    const outputs = await store();
    await expect(
      outputs.publish({
        binding: binding(),
        bytes: Buffer.from("derived"),
        inputAudience: [{ kind: "native", profile_id: "implementer" }],
      }),
    ).rejects.toMatchObject({
      code: "child-output-audience-denied",
    } satisfies Partial<ChildOutputStoreError>);
  });

  it("refuses an artifact root reached through a symlink", async () => {
    const target = await mkdtemp(join(tmpdir(), "pi-conductor-child-output-target-"));
    const link = join(tmpdir(), `pi-conductor-child-output-link-${Date.now()}`);
    directories.push(target, link);
    await symlink(target, link);
    await expect(ChildOutputStore.open({ root: link })).rejects.toMatchObject({
      code: "child-output-storage-failure",
    } satisfies Partial<ChildOutputStoreError>);
  });

  it("serializes competing store instances for one producer output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-child-output-race-"));
    directories.push(root);
    const [first, second] = await Promise.all([
      ChildOutputStore.open({ root }),
      ChildOutputStore.open({ root }),
    ]);
    const outcomes = await Promise.allSettled([
      first.publish({ binding: binding(), bytes: Buffer.from("one"), inputAudience: null }),
      second.publish({ binding: binding(), bytes: Buffer.from("two"), inputAudience: null }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "child-output-conflict" },
    });
  });

  it("rejects conflicting bytes for an already sealed producer output and detects corruption", async () => {
    const outputs = await store();
    const first = await outputs.publish({
      binding: binding(),
      bytes: Buffer.from("original"),
      inputAudience: null,
    });
    await expect(
      outputs.publish({ binding: binding(), bytes: Buffer.from("changed"), inputAudience: null }),
    ).rejects.toMatchObject({
      code: "child-output-conflict",
    } satisfies Partial<ChildOutputStoreError>);
    const path = outputs.pathForTest(first.ref);
    await chmod(path, 0o700);
    await chmod(join(path, "payload"), 0o600);
    await writeFile(join(path, "payload"), "tampered");
    await expect(outputs.recover(binding())).rejects.toMatchObject({
      code: "child-output-corrupt",
    } satisfies Partial<ChildOutputStoreError>);
  });

  it("copies bytes and the complete binding before waiting on the namespace queue", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const atHook = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const outputs = await store(async () => {
      calls += 1;
      if (calls === 1) {
        entered?.();
        await gate;
      }
    });
    const first = outputs.publish({
      binding: binding({ output: { id: "first", path: "first.txt", kind: "report" } }),
      bytes: Buffer.from("first"),
      inputAudience: null,
    });
    await atHook;
    const mutableBytes = Buffer.from("sealed");
    const mutableBinding = binding({
      output: { id: "second", path: "second.txt", kind: "report" },
    }) as {
      output: { id: string; path: string | null; kind: "report" };
      childId: string;
    } & ChildOutputBinding;
    const second = outputs.publish({
      binding: mutableBinding,
      bytes: mutableBytes,
      inputAudience: null,
    });
    mutableBytes.fill(0);
    mutableBinding.childId = "attacker";
    mutableBinding.output.id = "attacker";
    release?.();
    await first;
    const published = await second;
    await expect(
      outputs.read({
        ref: published.ref,
        principal: { kind: "native", profile_id: "implementer" },
        expectedBinding: binding({ output: { id: "second", path: "second.txt", kind: "report" } }),
      }),
    ).resolves.toMatchObject({ bytes: Buffer.from("sealed") });
  });

  it("rejects a queued publication whose host writer epoch closes before operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-child-output-fence-"));
    directories.push(root);
    let open = true;
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const atHook = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hooks = 0;
    const outputs = await ChildOutputStore.open({
      root,
      assertPublicationOpen: () => {
        if (!open) throw new Error("writer epoch closed");
      },
      testHook: async () => {
        hooks += 1;
        if (hooks === 1) {
          entered?.();
          await gate;
        }
      },
    });
    const first = outputs.publish({
      binding: binding({ output: { id: "first", path: "first.txt", kind: "report" } }),
      bytes: Buffer.from("first"),
      inputAudience: null,
    });
    await atHook;
    const second = outputs.publish({
      binding: binding({ output: { id: "second", path: "second.txt", kind: "report" } }),
      bytes: Buffer.from("second"),
      inputAudience: null,
    });
    open = false;
    release?.();
    await first;
    await expect(second).rejects.toThrow("writer epoch closed");
    const namespace = join(root, childOutputNamespace(binding()));
    expect((await readdir(namespace)).filter((name) => /^[a-f0-9]{64}$/u.test(name))).toHaveLength(
      1,
    );
  });

  it("rejects malformed bindings and principals with a typed boundary error", async () => {
    const outputs = await store();
    const malformed = { ...binding(), output: null } as unknown as ChildOutputBinding;
    await expect(
      outputs.publish({ binding: malformed, bytes: Buffer.from("x"), inputAudience: null }),
    ).rejects.toMatchObject({
      code: "child-output-binding-invalid",
    } satisfies Partial<ChildOutputStoreError>);
    await expect(
      outputs.read({
        ref: `child-output/v2/${digest("a")}/${digest("b")}`,
        principal: { kind: "native", profile_id: "../bad" },
        expectedBinding: binding(),
      }),
    ).rejects.toMatchObject({
      code: "child-output-binding-invalid",
    } satisfies Partial<ChildOutputStoreError>);
  });

  it("requires a canonical current-user private root and rejects a symlink namespace", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-conductor-child-output-parent-"));
    directories.push(parent);
    await chmod(parent, 0o777);
    await expect(ChildOutputStore.open({ root: join(parent, "store") })).rejects.toMatchObject({
      code: "child-output-storage-failure",
    } satisfies Partial<ChildOutputStoreError>);
    await chmod(parent, 0o700);

    const root = await mkdtemp(join(tmpdir(), "pi-conductor-child-output-root-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-conductor-child-output-outside-"));
    directories.push(root, outside);
    const outputs = await ChildOutputStore.open({ root });
    await symlink(outside, join(root, childOutputNamespace(binding())));
    await expect(
      outputs.publish({ binding: binding(), bytes: Buffer.from("x"), inputAudience: null }),
    ).rejects.toMatchObject({
      code: "child-output-storage-failure",
    } satisfies Partial<ChildOutputStoreError>);
  });

  it("rejects hardlinked sealed files and duplicate publication verifies existing bytes", async () => {
    const outputs = await store();
    const value = binding();
    const published = await outputs.publish({
      binding: value,
      bytes: Buffer.from("original"),
      inputAudience: null,
    });
    const path = outputs.pathForTest(published.ref);
    await chmod(path, 0o700);
    await link(join(path, "payload"), join(path, "payload-link"));
    await chmod(path, 0o500);
    await expect(
      outputs.publish({ binding: value, bytes: Buffer.from("original"), inputAudience: null }),
    ).rejects.toMatchObject({
      code: "child-output-corrupt",
    } satisfies Partial<ChildOutputStoreError>);
  });

  it("fails closed on corrupt committed candidates and absurd manifest lengths without payload allocation", async () => {
    const outputs = await store();
    const published = await outputs.publish({
      binding: binding(),
      bytes: Buffer.from("small"),
      inputAudience: null,
    });
    const path = outputs.pathForTest(published.ref);
    const manifestPath = join(path, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      content: { byte_length: number };
    };
    manifest.content.byte_length = Number.MAX_SAFE_INTEGER;
    await chmod(path, 0o700);
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await chmod(manifestPath, 0o400);
    await chmod(path, 0o500);
    await expect(outputs.recover(binding())).rejects.toMatchObject({
      code: "child-output-corrupt",
    } satisfies Partial<ChildOutputStoreError>);
    await expect(
      outputs.publish({
        binding: binding({ output: { id: "other", path: "other.txt", kind: "report" } }),
        bytes: Buffer.from("other"),
        inputAudience: null,
      }),
    ).rejects.toMatchObject({
      code: "child-output-corrupt",
    } satisfies Partial<ChildOutputStoreError>);
  });

  it("enforces output count atomically across different outputs and store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-child-output-count-"));
    directories.push(root);
    const stores = await Promise.all([
      ChildOutputStore.open({ root }),
      ChildOutputStore.open({ root }),
    ]);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 17 }, (_, index) =>
        stores[index % 2]?.publish({
          binding: binding({
            output: { id: `output-${index}`, path: `report-${index}.txt`, kind: "report" },
          }),
          bytes: Buffer.from("x"),
          inputAudience: null,
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(16);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toMatchObject([
      { reason: { code: "child-output-oversized" } },
    ]);
  });

  it("enforces aggregate bytes atomically across different patch outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-child-output-bytes-"));
    directories.push(root);
    const stores = await Promise.all([
      ChildOutputStore.open({ root }),
      ChildOutputStore.open({ root }),
    ]);
    const patchBinding = (id: string): ChildOutputBinding =>
      binding({
        output: { id, path: null, kind: "patch" },
        mediaType: "application/x-git-patch",
      });
    const outcomes = await Promise.allSettled([
      stores[0]?.publish({
        binding: patchBinding("patch-1"),
        bytes: Buffer.alloc(512 * 1024),
        inputAudience: null,
      }),
      stores[1]?.publish({
        binding: patchBinding("patch-2"),
        bytes: Buffer.alloc(512 * 1024),
        inputAudience: null,
      }),
      stores[0]?.publish({
        binding: patchBinding("patch-3"),
        bytes: Buffer.from("x"),
        inputAudience: null,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toMatchObject([
      { reason: { code: "child-output-oversized" } },
    ]);
  });

  it("seals directories and files before acknowledging publication", async () => {
    const outputs = await store();
    const published = await outputs.publish({
      binding: binding(),
      bytes: Buffer.from("sealed"),
      inputAudience: null,
    });
    const path = outputs.pathForTest(published.ref);
    await expect(lstat(path)).resolves.toMatchObject({ mode: expect.any(Number) });
    expect((await lstat(path)).mode & 0o777).toBe(0o500);
    expect((await lstat(join(path, "payload"))).mode & 0o777).toBe(0o400);
    expect((await lstat(join(path, "manifest.json"))).mode & 0o777).toBe(0o400);
  });
});

async function makeWritable(path: string): Promise<void> {
  const entries = await readdir(path).catch(() => [] as string[]);
  await chmod(path, 0o700).catch(() => undefined);
  await Promise.all(entries.map((entry) => makeWritable(join(path, entry))));
}
