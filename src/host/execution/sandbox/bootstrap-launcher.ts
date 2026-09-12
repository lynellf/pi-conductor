import { isAbsolute } from "node:path";

/** Inputs for a fixed Bubblewrap bootstrap invocation before production wiring (#106 §6). */
export interface BubblewrapBootstrapLaunch {
  readonly runtimePath: string;
  readonly bootstrapPath: string;
  readonly writablePath: string;
  /** User command values; these become bootstrap argv without source interpolation. */
  readonly command: readonly [string, ...string[]];
}

/** Build Bubblewrap argv with its JSON status pipe fixed to FD 5 (#106 §6). */
export function buildBubblewrapBootstrapArgs(
  launch: Readonly<BubblewrapBootstrapLaunch>,
): readonly string[] {
  assertAbsolutePath("runtimePath", launch.runtimePath);
  assertAbsolutePath("bootstrapPath", launch.bootstrapPath);
  assertAbsolutePath("writablePath", launch.writablePath);
  for (const [index, argument] of launch.command.entries()) {
    if ((index === 0 && argument.length === 0) || argument.includes("\0"))
      throw new TypeError(`command[${index}] must be NUL-free and argv[0] must be non-empty`);
  }

  return [
    "--unshare-user",
    "--disable-userns",
    "--assert-userns-disabled",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--json-status-fd",
    "5",
    "--ro-bind",
    `${launch.runtimePath}/bin`,
    "/bin",
    "--ro-bind",
    `${launch.runtimePath}/lib`,
    "/lib",
    "--ro-bind",
    `${launch.runtimePath}/lib64`,
    "/lib64",
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
    "--dir",
    "/work",
    "--bind",
    launch.writablePath,
    "/work",
    "--chdir",
    "/work",
    "--setenv",
    "HOME",
    "/home/sandbox",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "LANG",
    "C",
    "--ro-bind",
    launch.bootstrapPath,
    "/bootstrap.sh",
    "--remount-ro",
    "/",
    "--",
    "/bin/bash",
    "/bootstrap.sh",
    ...launch.command,
  ];
}

function assertAbsolutePath(name: string, value: string): void {
  if (!isAbsolute(value) || value.includes("\0"))
    throw new TypeError(`${name} must be an absolute, NUL-free path`);
}
