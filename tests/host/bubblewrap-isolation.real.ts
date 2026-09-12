/** Real Linux namespace gate for issue #106; invoke explicitly with test:sandbox. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    throw new Error(`Real sandbox gate requires ${name}; unavailable is not a passing result`);
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("verified Bubblewrap isolation", () => {
  let root: string;
  let binary: string;
  let argumentsBeforeCommand: string[];
  const listener = createServer((socket) => socket.destroy());
  let port: number;

  beforeAll(async () => {
    binary = required("PI_CONDUCTOR_BWRAP");
    const expectedHash = required("PI_CONDUCTOR_BWRAP_SHA256");
    const source = required("PI_CONDUCTOR_BWRAP_RUNTIME");
    if (process.platform !== "linux" || process.getuid?.() === 0)
      throw new Error("Run the Linux gate as an unprivileged user");
    expect(sha256(await readFile(binary))).toBe(expectedHash);
    const binaryStat = await lstat(binary);
    expect(binaryStat.isFile() && binaryStat.uid === 0 && (binaryStat.mode & 0o6022) === 0).toBe(
      true,
    );
    root = await mkdtemp(join(tmpdir(), "conductor-bwrap-isolation-"));
    const runtime = join(root, "runtime");
    // The operator prepared this fixed Bash-only inventory outside the project.
    const inventory: unknown = JSON.parse(
      await readFile(join(dirname(source), "bash-runtime-inventory.json"), "utf8"),
    );
    if (!Array.isArray(inventory)) throw new Error("Missing approved Bash inventory");
    for (const path of runtimeFiles) {
      const item: unknown = inventory.find(
        (entry: unknown) =>
          typeof entry === "object" && entry !== null && "path" in entry && entry.path === path,
      );
      if (
        typeof item !== "object" ||
        item === null ||
        !("sha256" in item) ||
        typeof item.sha256 !== "string"
      )
        throw new Error(`Missing approved runtime digest: ${path}`);
      const input = join(source, path);
      const stats = await lstat(input);
      expect(stats.isFile() && stats.nlink === 1).toBe(true);
      expect(sha256(await readFile(input))).toBe(item.sha256);
      await mkdir(dirname(join(runtime, path)), { recursive: true });
      await copyFile(input, join(runtime, path));
      expect(sha256(await readFile(join(runtime, path)))).toBe(item.sha256);
    }
    await execute(
      "/usr/bin/cc",
      [
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-o",
        join(runtime, "bin/probe"),
        resolve("tests/fixtures/bubblewrap/probe.c"),
      ],
      { env: { PATH: "/usr/bin:/bin", LANG: "C" } },
    );
    const elf = await execute("/usr/bin/readelf", ["-d", join(runtime, "bin/probe")], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    expect(elf.stdout.match(/Shared library: \[[^\]]+\]/g)).toEqual([
      "Shared library: [libc.so.6]",
    ]);
    await mkdir(join(root, "base/src"), { recursive: true });
    await mkdir(join(root, "writable"));
    await writeFile(join(root, "base/read-only.txt"), "immutable input\n");
    await writeFile(join(root, "host-sentinel"), "must never be visible\n");
    argumentsBeforeCommand = [
      "--unshare-user",
      "--disable-userns",
      "--unshare-pid",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-uts",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--clearenv",
    ];
    for (const entry of ["bin", "lib", "lib64"])
      argumentsBeforeCommand.push("--ro-bind", join(runtime, entry), `/${entry}`);
    argumentsBeforeCommand.push(
      "--ro-bind",
      join(root, "base"),
      "/workspace",
      "--bind",
      join(root, "writable"),
      "/workspace/src",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/home/sandbox",
      "--tmpfs",
      "/run",
      "--chdir",
      "/workspace",
      "--setenv",
      "HOME",
      "/home/sandbox",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "LANG",
      "C",
      "--remount-ro",
      "/",
    );
    await new Promise<void>((resolveListening, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolveListening);
    });
    const address = listener.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing sentinel listener");
    port = address.port;
    await new Promise<void>((connected, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.destroy();
        connected();
      });
    });
  }, 15000);

  afterAll(async () => {
    if (listener.listening)
      await new Promise<void>((done, reject) =>
        listener.close((error) => (error ? reject(error) : done())),
      );
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("denies nested user namespaces, host listener access, extra FDs, and capabilities", async () => {
    const result = await execute(binary, [...argumentsBeforeCommand, "/bin/probe", String(port)], {
      env: {},
      timeout: 10000,
      maxBuffer: 65536,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema_version: 1,
      capabilities_zero: true,
      extra_fds: 0,
      external_interfaces: 0,
      host_connection_errno: expect.any(Number),
      host_connection_denied: true,
      devices_match: true,
      nested_userns_result: -1,
      nested_userns_denied: true,
      nested_userns_errno: expect.any(Number),
      no_new_privs: 1,
      // The final user namespace need not expose the enforced ancestor limit.
      namespace_limit: expect.any(Number),
    });
    expect(JSON.parse(result.stdout).host_connection_errno).not.toBe(0);
    expect(JSON.parse(result.stdout).nested_userns_errno).not.toBe(0);
  });

  it("keeps host paths hidden and writes confined to the private writable mount", async () => {
    const script = `set -eu
for hidden in "$1" "$2" /root /sys /workspace/.git /run/user; do
  if [[ -e $hidden ]]; then printf 'unexpected visible path\n' >&2; exit 1; fi
done
if (printf altered > /workspace/read-only.txt) 2>/dev/null; then exit 2; fi
if (printf altered > /bin/bash) 2>/dev/null; then exit 3; fi
printf edited > /workspace/src/result.txt
printf temporary > /tmp/local
printf home > /home/sandbox/local
printf run > /run/local
printf PATHS_OK
`;
    const result = await execute(
      binary,
      [
        ...argumentsBeforeCommand,
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        script,
        "sandbox-test",
        join(root, "host-sentinel"),
        homedir(),
      ],
      { env: {}, timeout: 10000 },
    );
    expect(result.stdout).toBe("PATHS_OK");
    expect(await readFile(join(root, "base/read-only.txt"), "utf8")).toBe("immutable input\n");
    expect(await readFile(join(root, "writable/result.txt"), "utf8")).toBe("edited");
  });
});
