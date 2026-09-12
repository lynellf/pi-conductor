/** Real Issue #106 §6 bootstrap gate; run only through `pnpm test:sandbox`. */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  BUBBLEWRAP_BOOTSTRAP_SOURCE,
  BUBBLEWRAP_RELEASE_FRAME,
  releaseAfterSandboxReady,
} from "../../src/host/execution/sandbox/bootstrap.js";
import { buildBubblewrapBootstrapArgs } from "../../src/host/execution/sandbox/bootstrap-launcher.js";
import {
  captureProcessIdentity,
  classifyOwnedProcess,
  type LaunchedBootstrap,
  launchBootstrap,
  listSandboxProcessFds,
  observeHostNamespaces,
  observeProcess,
  type ProcessIdentity,
  terminateOwned,
} from "./bubblewrap-bootstrap-real-harness.js";

const execute = promisify(execFile);
const runtimeFiles = [
  "bin/bash",
  "lib/x86_64-linux-gnu/libtinfo.so.6",
  "lib/x86_64-linux-gnu/libc.so.6",
  "lib64/ld-linux-x86-64.so.2",
];

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Real bootstrap gate requires ${name}; unavailable is not a passing result`);
  return value;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function releaseWriter(stream: NodeJS.WritableStream) {
  return {
    end: (frame: string) =>
      new Promise<void>((resolve, reject) => {
        stream.once("error", reject);
        stream.end(frame, (error?: Error | null) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("verified Bubblewrap bootstrap", () => {
  let root: string;
  let binary: string;
  let runtime: string;
  let runtimeSource: string;
  let bootstrap: string;
  let writable: string;
  let active: LaunchedBootstrap | undefined;
  const runtimeDigests = new Map<string, string>();

  beforeAll(async () => {
    binary = required("PI_CONDUCTOR_BWRAP");
    const expectedHash = required("PI_CONDUCTOR_BWRAP_SHA256");
    const source = required("PI_CONDUCTOR_BWRAP_RUNTIME");
    runtimeSource = source;
    if (process.platform !== "linux" || process.getuid?.() === 0)
      throw new Error("Run the Linux gate as an unprivileged user");
    expect(digest(await readFile(binary))).toBe(expectedHash);
    const binaryStat = await lstat(binary);
    expect(binaryStat.isFile() && binaryStat.uid === 0 && (binaryStat.mode & 0o6022) === 0).toBe(
      true,
    );
    const inventory: unknown = JSON.parse(
      await readFile(join(dirname(source), "bash-runtime-inventory.json"), "utf8"),
    );
    if (!Array.isArray(inventory)) throw new Error("missing approved Bash inventory");
    root = await mkdtemp(join(tmpdir(), "conductor-bwrap-bootstrap-"));
    runtime = join(root, "runtime");
    for (const path of runtimeFiles) {
      const entry = inventory.find(
        (value: unknown) =>
          typeof value === "object" && value !== null && "path" in value && value.path === path,
      );
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("sha256" in entry) ||
        typeof entry.sha256 !== "string"
      )
        throw new Error(`missing runtime digest for ${path}`);
      const input = join(source, path);
      expect((await lstat(input)).isFile()).toBe(true);
      expect(digest(await readFile(input))).toBe(entry.sha256);
      runtimeDigests.set(path, entry.sha256);
      await mkdir(dirname(join(runtime, path)), { recursive: true });
      await copyFile(input, join(runtime, path));
    }
    await execute(
      "/usr/bin/cc",
      [
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "tests/fixtures/bubblewrap/fd-probe.c",
        "-o",
        join(runtime, "bin/fd-probe"),
      ],
      { env: { PATH: "/usr/bin:/bin", LANG: "C" } },
    );
    const elf = await execute("/usr/bin/readelf", ["-d", join(runtime, "bin/fd-probe")], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    expect(elf.stdout.match(/Shared library: \[[^\]]+\]/g)).toEqual([
      "Shared library: [libc.so.6]",
    ]);
    writable = join(root, "writable");
    bootstrap = join(root, "bootstrap.sh");
    await mkdir(writable);
    await writeFile(bootstrap, BUBBLEWRAP_BOOTSTRAP_SOURCE, { mode: 0o500 });
  }, 15_000);

  afterEach(async () => {
    if (active) {
      await terminateOwned(active.launcher);
      await active.close.catch(() => undefined);
    }
    active = undefined;
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function launch(command: readonly [string, ...string[]]): Promise<LaunchedBootstrap> {
    await assertPrivateRuntimeIntegrity();
    active = await launchBootstrap(
      binary,
      buildBubblewrapBootstrapArgs({
        runtimePath: runtime,
        bootstrapPath: bootstrap,
        writablePath: writable,
        command,
      }),
    );
    return active;
  }

  async function assertPrivateRuntimeIntegrity(): Promise<void> {
    for (const path of runtimeFiles) {
      const expected = runtimeDigests.get(path);
      if (!expected) throw new Error(`missing copied runtime digest for ${path}`);
      const stat = await lstat(join(runtime, path));
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        digest(await readFile(join(runtime, path))) !== expected
      )
        throw new Error(`private runtime integrity changed: ${path}`);
    }
  }

  it("binds PID1 before release and verifies namespaces, FDs, and the correlated exit", async () => {
    const host = await observeHostNamespaces();
    const launched = await launch([
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      'test -z "$' + '{LC_ALL+x}" && exec /bin/fd-probe',
    ]);
    const startup = await launched.startup;
    const early = await observeProcess(startup.childPid);
    expect(early.namespaces.pid).toBe(`pid:[${startup.pidNamespace}]`);
    await launched.ready;
    const final = await observeProcess(startup.childPid);
    expect(final.pid).toBe(early.pid);
    expect(final.start).toBe(early.start);
    expect(final.nspid.at(-1)).toBe("1");
    expect(final.namespaces.pid).toBe(early.namespaces.pid);
    expect(final.namespaces.pid).not.toBe(host.namespaces.pid);
    for (const name of ["mnt", "user", "net", "ipc", "uts"] as const)
      expect(final.namespaces[name]).not.toBe(host.namespaces[name]);
    expect(await listSandboxProcessFds(final.pid, 2)).toEqual(
      expect.arrayContaining(["0", "1", "2", "3", "4"]),
    );
    expect(await listSandboxProcessFds(final.pid, 2)).not.toContain("5");
    await releaseAfterSandboxReady(releaseWriter(launched.release), async () => undefined);
    const settled = await launched.settle();
    active = undefined;
    expect(settled.code).toBe(0);
    expect(settled.stderr).toBe("");
    expect(settled.statusFrames).toContainEqual({ "exit-code": 0 });
  }, 10_000);

  it("rejects a changed private Bash runtime before spawning Bubblewrap", async () => {
    const path = "bin/bash";
    const copiedRuntime = join(runtime, path);
    await writeFile(copiedRuntime, "tampered runtime");
    try {
      await expect(launch(["/bin/fd-probe"])).rejects.toThrow(
        "private runtime integrity changed: bin/bash",
      );
    } finally {
      await copyFile(join(runtimeSource, path), copiedRuntime);
    }
  });

  it("does not reach READY or release when the bootstrap interpreter is changed", async () => {
    const sentinel = join(writable, "tampered-bootstrap-sentinel");
    const args = Array.from(
      buildBubblewrapBootstrapArgs({
        runtimePath: runtime,
        bootstrapPath: bootstrap,
        writablePath: writable,
        command: [
          "/bin/bash",
          "--noprofile",
          "--norc",
          "-c",
          "printf executed > /work/tampered-bootstrap-sentinel",
        ],
      }),
    );
    args[args.indexOf("--") + 1] = "/bin/not-an-approved-bash";
    active = await launchBootstrap(binary, args);
    await expect(active.ready).rejects.toThrow("bootstrap closed READY pipe before READY");
    await expect(active.settle()).resolves.toMatchObject({ code: expect.any(Number) });
    active = undefined;
    await expect(lstat(sentinel)).rejects.toThrow();
  }, 10_000);

  it.each([
    ["EOF", "", 81],
    ["partial frame", BUBBLEWRAP_RELEASE_FRAME.slice(0, -1), 81],
    ["bad frame", "X".repeat(BUBBLEWRAP_RELEASE_FRAME.length), 81],
    ["NUL after frame", `${BUBBLEWRAP_RELEASE_FRAME}\0`, 80],
    ["trailing byte", `${BUBBLEWRAP_RELEASE_FRAME}X`, 80],
    ["multiple frames", `${BUBBLEWRAP_RELEASE_FRAME}${BUBBLEWRAP_RELEASE_FRAME}`, 80],
  ])(
    "rejects %s without executing user code",
    async (_name, frame, code) => {
      const sentinelName = `sentinel-${_name.replaceAll(" ", "-")}`;
      const sentinel = join(writable, sentinelName);
      const launched = await launch([
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        `printf executed > /work/${sentinelName}`,
      ]);
      await launched.startup;
      await launched.ready;
      await releaseWriter(launched.release).end(frame);
      expect((await launched.settle()).code).toBe(code);
      active = undefined;
      await expect(lstat(sentinel)).rejects.toThrow();
    },
    10_000,
  );

  it("closes the release pipe after persistence failure and never executes user code", async () => {
    const sentinelName = "persistence-failure-sentinel";
    const sentinel = join(writable, sentinelName);
    const launched = await launch([
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      `printf executed > /work/${sentinelName}`,
    ]);
    await launched.startup;
    await launched.ready;
    await expect(
      releaseAfterSandboxReady(releaseWriter(launched.release), async () => {
        throw new Error("durable sandbox_ready append failed");
      }),
    ).rejects.toThrow("durable sandbox_ready append failed");
    expect((await launched.settle()).code).toBe(81);
    active = undefined;
    await expect(lstat(sentinel)).rejects.toThrow();
  }, 10_000);

  it("never executes user code when the direct host dies before release", async () => {
    const sentinelName = "host-death-before-release-sentinel";
    const sentinel = join(writable, sentinelName);
    const args = buildBubblewrapBootstrapArgs({
      runtimePath: runtime,
      bootstrapPath: bootstrap,
      writablePath: writable,
      command: [
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        `printf executed > /work/${sentinelName}`,
      ],
    });
    const fixture = await launchHostDeathFixture(binary, args, true);
    let report: FixtureReport | undefined;
    try {
      report = await readFixtureReport(fixture.child);
      if (!report.init) throw new Error("host-death fixture omitted init identity");
      await fixture.close;
      await expectOwnedIdentityToSettle(report.init);
      await expect(lstat(sentinel)).rejects.toThrow();
    } finally {
      await terminateOwned(fixture.identity);
      if (report?.init) await terminateOwned(report.init);
      await fixture.close.catch(() => undefined);
    }
  }, 10_000);

  it("kills a released descendant when its direct host dies", async () => {
    const args = buildBubblewrapBootstrapArgs({
      runtimePath: runtime,
      bootstrapPath: bootstrap,
      writablePath: writable,
      command: [
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        "(while :; do :; done) & descendant=$!; printf 'DESCENDANT_NSPID=%s\\n' \"$descendant\"; while :; do :; done",
      ],
    });
    const fixture = await launchHostDeathFixture(binary, args, false);
    let report: FixtureReport | undefined;
    try {
      report = await readFixtureReport(fixture.child);
      if (!report.init || !report.descendant)
        throw new Error("host-death fixture omitted owned identities");
      await fixture.close;
      await expectOwnedIdentityToSettle(report.init);
      await expectOwnedIdentityToSettle(report.descendant);
    } finally {
      await terminateOwned(fixture.identity);
      if (report?.init) await terminateOwned(report.init);
      if (report?.descendant) await terminateOwned(report.descendant);
      await fixture.close.catch(() => undefined);
    }
  }, 10_000);
});

interface HostDeathFixture {
  readonly child: ReturnType<typeof spawn>;
  readonly identity: ProcessIdentity;
  readonly close: Promise<void>;
}

interface FixtureReport {
  readonly descendant?: ProcessIdentity;
  readonly init?: ProcessIdentity;
}

async function launchHostDeathFixture(
  binary: string,
  args: readonly string[],
  beforeRelease: boolean,
): Promise<HostDeathFixture> {
  const child = spawn(
    process.execPath,
    [join("tests", "fixtures", "bubblewrap", "host-death-after-release.mjs")],
    {
      env: {
        BWRAP: binary,
        BWRAP_ARGS: JSON.stringify(args),
        ...(beforeRelease ? { HOST_DEATH_BEFORE_RELEASE: "1" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const close = waitForFixtureExit(child);
  if (child.pid === undefined) throw new Error("host-death fixture returned no PID");
  child.stderr?.resume();
  return { child, identity: await captureProcessIdentity(child.pid), close };
}

async function readFixtureReport(child: ReturnType<typeof spawn>): Promise<FixtureReport> {
  if (!child.stdout) throw new Error("host-death fixture has no stdout");
  let output = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    output += chunk;
    const line = output.split("\n").find((value) => value.startsWith("{"));
    if (line) return JSON.parse(line) as FixtureReport;
  }
  throw new Error(`host-death fixture exited before identity report: ${output}`);
}

function waitForFixtureExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`)),
    );
  });
}

async function expectOwnedIdentityToSettle(identity: ProcessIdentity): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await classifyOwnedProcess(identity);
    if (state === "missing" || state === "reused" || state === "zombie") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`owned process ${identity.pid}/${identity.start} remained live after host death`);
}
