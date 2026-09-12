/** Strict mountinfo evidence checks for the fixed capability probe (#106 §5). */

const MAX_MOUNTINFO_BYTES = 64 * 1024;
const DEVICE_MOUNTS = [
  "/dev/null",
  "/dev/zero",
  "/dev/full",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
];

export interface SandboxProbeMount {
  readonly root: string;
  readonly mountPoint: string;
  readonly mountOptions: ReadonlySet<string>;
  readonly fsType: string;
  readonly source: string;
  readonly superOptions: ReadonlySet<string>;
}

export interface SandboxProbeMountExpectations {
  readonly runtimeDirectories: readonly string[];
  readonly writablePaths: readonly string[];
}

/** Parses the bounded Linux proc_pid_mountinfo(5) line format without path ambiguity. */
export function parseSandboxProbeMountinfo(value: string): readonly SandboxProbeMount[] {
  if (Buffer.byteLength(value, "utf8") > MAX_MOUNTINFO_BYTES) {
    throw new Error("sandbox mountinfo exceeds the report limit");
  }
  const lines = value.endsWith("\n") ? value.slice(0, -1).split("\n") : value.split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error("sandbox mountinfo contains an empty line");
  }

  const mounts = lines.map(parseMountinfoLine);
  if (new Set(mounts.map((mount) => mount.mountPoint)).size !== mounts.length) {
    throw new Error("sandbox mountinfo contains stacked mount points");
  }
  return Object.freeze(mounts);
}

/** Verifies that the probe saw precisely the fixed mount-plan destinations. */
export function assertSandboxProbeMounts(
  mountinfo: string,
  expectations: SandboxProbeMountExpectations,
): readonly SandboxProbeMount[] {
  const mounts = parseSandboxProbeMountinfo(mountinfo);
  const expected = new Map<string, "ro" | "rw">([
    ["/", "ro"],
    ["/workspace", "ro"],
    ["/proc", "rw"],
    ["/dev", "rw"],
    ["/dev/pts", "rw"],
    ["/dev/shm", "rw"],
    ["/tmp", "rw"],
    ["/home/sandbox", "rw"],
    ["/run", "rw"],
    ["/bootstrap/bootstrap.sh", "ro"],
  ]);
  for (const directory of expectations.runtimeDirectories) {
    assertTopLevelRuntimeDirectory(directory);
    addExpectedMount(expected, `/${directory}`, "ro");
  }
  for (const path of expectations.writablePaths) {
    assertWritablePath(path);
    addExpectedMount(expected, `/workspace/${path}`, "rw");
  }
  for (const path of DEVICE_MOUNTS) addExpectedMount(expected, path, "rw");

  if (mounts.length !== expected.size) {
    throw new Error("sandbox mountinfo does not contain the expected mount set");
  }
  for (const mount of mounts) {
    const mode = expected.get(mount.mountPoint);
    if (!mode) throw new Error("sandbox mountinfo contains an unexpected mount");
    assertMode(mount, mode);
    assertFilesystem(mount);
  }
  return mounts;
}

function parseMountinfoLine(line: string): SandboxProbeMount {
  if (line.includes("\0") || line.includes("  ")) {
    throw new Error("sandbox mountinfo contains ambiguous field spacing");
  }
  const fields = line.split(" ");
  const separator = fields.indexOf("-");
  if (
    separator < 6 ||
    fields.filter((field) => field === "-").length !== 1 ||
    fields.length !== separator + 4
  ) {
    throw new Error("sandbox mountinfo line has an invalid field layout");
  }
  const [mountId, parentId, device, root, mountPoint, options] = fields;
  const fsType = fields[separator + 1];
  const source = fields[separator + 2];
  const superOptions = fields[separator + 3];
  if (
    !mountId ||
    !parentId ||
    !device ||
    !root ||
    !mountPoint ||
    !options ||
    !fsType ||
    !source ||
    !superOptions ||
    !/^[1-9][0-9]*$/.test(mountId) ||
    !/^[1-9][0-9]*$/.test(parentId) ||
    !/^[0-9]+:[0-9]+$/.test(device) ||
    !/^[A-Za-z0-9_.-]+$/.test(fsType)
  ) {
    throw new Error("sandbox mountinfo line contains invalid fixed fields");
  }
  for (const optional of fields.slice(6, separator)) {
    if (!/^[A-Za-z0-9_]+(?::[A-Za-z0-9_.-]+)?$/.test(optional)) {
      throw new Error("sandbox mountinfo line contains an invalid optional field");
    }
  }
  return Object.freeze({
    root: decodeMountinfoPath(root),
    mountPoint: decodeMountinfoPath(mountPoint),
    mountOptions: parseOptions(options),
    fsType,
    source: decodeMountinfoSource(source),
    superOptions: parseOptions(superOptions),
  });
}

function decodeMountinfoPath(value: string): string {
  const decoded = decodeMountinfoEscapes(value);
  if (
    !decoded.startsWith("/") ||
    decoded.includes("\0") ||
    decoded.includes("//") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("sandbox mountinfo contains an ambiguous path");
  }
  return decoded;
}

function decodeMountinfoSource(value: string): string {
  const decoded = decodeMountinfoEscapes(value);
  if (decoded.length === 0 || decoded.includes("\0")) {
    throw new Error("sandbox mountinfo contains an invalid mount source");
  }
  return decoded;
}

function decodeMountinfoEscapes(value: string): string {
  return value
    .replace(/\\([0-9]{3})/g, (full, octal: string) => {
      if (!["040", "011", "012", "134"].includes(octal)) {
        throw new Error(`sandbox mountinfo contains an unsupported escape ${full}`);
      }
      return String.fromCharCode(Number.parseInt(octal, 8));
    })
    .replace(/\\/g, () => {
      throw new Error("sandbox mountinfo contains a malformed escape");
    });
}

function parseOptions(value: string): ReadonlySet<string> {
  const options = value.split(",");
  if (options.some((option) => !/^[A-Za-z0-9_.=-]+$/.test(option))) {
    throw new Error("sandbox mountinfo contains invalid mount options");
  }
  const result = new Set(options);
  if (result.size !== options.length || result.has("ro") === result.has("rw")) {
    throw new Error("sandbox mountinfo must contain exactly one read mode");
  }
  return result;
}

function addExpectedMount(
  expected: Map<string, "ro" | "rw">,
  path: string,
  mode: "ro" | "rw",
): void {
  if (expected.has(path)) throw new Error(`sandbox mount expectation overlaps ${path}`);
  expected.set(path, mode);
}

function assertMode(mount: SandboxProbeMount, expected: "ro" | "rw"): void {
  if (!mount.mountOptions.has(expected)) {
    throw new Error("sandbox mount has an unexpected read mode");
  }
}

function assertFilesystem(mount: SandboxProbeMount): void {
  const expected = new Map([
    ["/", "tmpfs"],
    ["/proc", "proc"],
    ["/dev", "tmpfs"],
    ["/dev/pts", "devpts"],
    ["/dev/shm", "tmpfs"],
    ["/tmp", "tmpfs"],
    ["/home/sandbox", "tmpfs"],
    ["/run", "tmpfs"],
  ]);
  const type = expected.get(mount.mountPoint);
  if (type && mount.fsType !== type) {
    throw new Error("sandbox mount has an unexpected filesystem");
  }
}

function assertTopLevelRuntimeDirectory(value: string): void {
  if (!["bin", "sbin", "usr", "lib", "lib64", "etc", "opt"].includes(value)) {
    throw new Error("sandbox mount expectation contains an invalid runtime directory");
  }
}

function assertWritablePath(value: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("sandbox mount expectation contains an invalid writable path");
  }
}
