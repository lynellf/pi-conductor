/** Trusted, bounded native-observer setup for #165; never installs developer tools. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMacObservation } from "./observer-protocol.js";

/** Setup failure is a capability error, never permission to run unsupervised. */
export class MacObserverRuntimeError extends Error {
  readonly code = "macos-observer-unavailable";
  constructor(message: string) {
    super(`macOS process observer unavailable: ${message}`);
    this.name = "MacObserverRuntimeError";
  }
}

let cached: { readonly path: string; readonly digest: string } | undefined;

function remember(path: string): string {
  cached = { path, digest: digest(readFileSync(path)) };
  return path;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function privateDirectory(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(path) !== path
  )
    throw new MacObserverRuntimeError("observer cache must be canonical, owned, and mode 0700");
  // POSIX mode bits alone do not exclude a Darwin extended ACL granting access.
  // Fixed Apple metadata utility, numeric IDs and C locale; never publish its output.
  try {
    const metadata = trustedSetup("/bin/ls", ["-ldne", path]);
    if (metadata.trimEnd().split("\n").length !== 1)
      throw new MacObserverRuntimeError("observer cache must not have an extended ACL");
  } catch (error) {
    if (error instanceof MacObserverRuntimeError) throw error;
    throw new MacObserverRuntimeError("observer cache access metadata is unavailable");
  }
  return path;
}

function ownedFile(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.size > 2 * 1024 * 1024 ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0 ||
    realpathSync(path) !== path
  )
    throw new MacObserverRuntimeError("observer artifact ownership is invalid");
}

function verifyArchitecture(path: string, arch: "arm64" | "x86_64"): void {
  const bytes = readFileSync(path);
  if (
    bytes.length < 32 ||
    bytes.readUInt32LE(0) !== 0xfeedfacf ||
    bytes.readUInt32LE(4) !== (arch === "arm64" ? 0x0100000c : 0x01000007)
  )
    throw new MacObserverRuntimeError("observer architecture is invalid");
}

function trustedSetup(file: string, args: string[]): string {
  return execFileSync(file, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: homedir() },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Prove native API visibility before any production role/model work, not merely compilation. */
export function assertMacObserverReady(): void {
  const file = prepareMacObserver();
  try {
    const output = execFileSync(file, ["snapshot"], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const value: unknown = JSON.parse(output);
    const observation = parseMacObservation(value);
    const self = observation.processes.find((entry) => entry.pid === process.pid);
    if (
      observation.uid !== process.getuid?.() ||
      self?.uid !== observation.uid ||
      self.startKind !== "mach"
    )
      throw new Error("observer origin unavailable");
    // Fixed, preload-free setup code proves this Node binary exposes its inherited
    // marker. It invokes only the prepared observer; no repository/workload code.
    const probe = `const {execFileSync}=require('node:child_process');
      process.stdout.write(execFileSync(process.argv[1], ['observe', String(process.pid)], {
        input: process.env.PI_CONDUCTOR_EXECUTION_ID, timeout: 1000,
        env: {PATH:'/usr/bin:/bin',LANG:'C'}, maxBuffer:4096
      }));`;
    const marked: unknown = JSON.parse(
      execFileSync(process.execPath, ["-e", probe, file], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 4096,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", LANG: "C", PI_CONDUCTOR_EXECUTION_ID: randomUUID() },
      }),
    );
    const visible = parseMacObservation(marked);
    if (
      visible.bootId !== observation.bootId ||
      visible.uid !== observation.uid ||
      visible.processes.length !== 1 ||
      visible.processes[0]?.marker !== "present"
    )
      throw new MacObserverRuntimeError(
        "Node ownership marker is unavailable; use a verified Node installation",
      );
  } catch (error) {
    if (error instanceof MacObserverRuntimeError) throw error;
    throw new MacObserverRuntimeError("native API visibility or observer protocol is unavailable");
  }
}

/** Prepare a source-versioned observer in the user's private cache before workload admission. */
export function prepareMacObserver(): string {
  if (process.platform !== "darwin") throw new MacObserverRuntimeError("requires Darwin");
  if (cached !== undefined) {
    privateDirectory(dirname(cached.path));
    privateDirectory(dirname(dirname(cached.path)));
    ownedFile(cached.path);
    if (digest(readFileSync(cached.path)) !== cached.digest)
      throw new MacObserverRuntimeError("observer changed after preparation");
    return cached.path;
  }
  // xcode-select -p does not invoke the compiler shim or present the CLT installer.
  let developer: string;
  try {
    developer = realpathSync(trustedSetup("/usr/bin/xcode-select", ["-p"]).trim());
  } catch {
    throw new MacObserverRuntimeError(
      "install Xcode Command Line Tools before starting a tool-enabled run",
    );
  }
  const compiler = [
    join(developer, "Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"),
    join(developer, "usr/bin/clang"),
  ].find(existsSync);
  if (compiler === undefined || lstatSync(realpathSync(compiler)).uid !== 0)
    throw new MacObserverRuntimeError("installed Apple compiler is unavailable");
  const source = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../resources/macos/process-observer.c",
  );
  const sourceDigest = digest(readFileSync(source));
  // The native observer talks to the kernel, not Node's translated architecture.
  const arm = trustedSetup("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"]).trim();
  if (arm !== "0" && arm !== "1")
    throw new MacObserverRuntimeError("kernel architecture is unrecognized");
  const arch = arm === "1" ? "arm64" : "x86_64";
  const home = realpathSync(homedir());
  const root = privateDirectory(join(home, ".pi-conductor-native"));
  const directory = privateDirectory(join(root, `${sourceDigest}-${arch}`));
  const binary = join(directory, "observer");
  const receipt = join(directory, "sha256");
  if (existsSync(binary) && existsSync(receipt)) {
    ownedFile(binary);
    ownedFile(receipt);
    verifyArchitecture(binary, arch);
    if (readFileSync(receipt, "utf8") !== digest(readFileSync(binary)))
      throw new MacObserverRuntimeError("observer digest changed; inspect the private cache");
    trustedSetup("/usr/bin/codesign", ["--verify", "--strict", binary]);
    return remember(binary);
  }
  const lock = join(directory, "build-lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new MacObserverRuntimeError(
      "observer setup is already active or uncertain; inspect the cache build-lock",
    );
  }
  const temporary = join(directory, "observer-building");
  let settled = false;
  try {
    // Fixed trusted source/flags: no repository include paths, plugins, or inherited compiler env.
    const sdk = realpathSync(
      trustedSetup("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]).trim(),
    );
    trustedSetup(compiler, [
      "-isysroot",
      sdk,
      "-arch",
      arch,
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      source,
      "-o",
      temporary,
    ]);
    settled = true;
    ownedFile(temporary);
    verifyArchitecture(temporary, arch);
    trustedSetup("/usr/bin/codesign", ["--verify", "--strict", temporary]);
    renameSync(temporary, binary);
    writeFileSync(receipt, digest(readFileSync(binary)), { mode: 0o600, flag: "wx" });
    return remember(binary);
  } catch (error) {
    // A numeric compiler exit was observed; only interrupted/unknown settlement retains the lock.
    if (typeof (error as { readonly status?: unknown }).status === "number") settled = true;
    // Retain the lock if compiler settlement was not observed. Never admit workloads after timeout.
    throw new MacObserverRuntimeError(
      "native observer setup failed; inspect compiler settlement and cache before retrying",
    );
  } finally {
    if (settled) rmdirSync(lock);
  }
}
