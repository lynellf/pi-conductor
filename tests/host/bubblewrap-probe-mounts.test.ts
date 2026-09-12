import { describe, expect, it } from "vitest";

import {
  assertSandboxProbeMounts,
  parseSandboxProbeMountinfo,
} from "../../src/host/execution/sandbox/probe-mounts.js";

function line(id: number, point: string, mode: "ro" | "rw", fsType = "tmpfs", root = "/"): string {
  return [id, "1", `0:${id}`, root, point, `${mode},nosuid`, "-", fsType, "none", mode].join(" ");
}

function mountinfo(): string {
  return [
    line(1, "/", "ro"),
    line(2, "/bin", "ro", "ext4"),
    line(3, "/workspace", "ro", "xfs"),
    line(4, "/workspace/src", "rw", "btrfs"),
    line(5, "/proc", "rw", "proc"),
    line(6, "/dev", "rw"),
    line(7, "/dev/pts", "rw", "devpts"),
    line(8, "/dev/shm", "rw"),
    line(9, "/tmp", "rw"),
    line(10, "/home/sandbox", "rw"),
    line(11, "/run", "rw"),
    line(12, "/bootstrap/bootstrap.sh", "ro", "ext4"),
    line(13, "/dev/null", "rw", "ext4"),
    line(14, "/dev/zero", "rw", "ext4"),
    line(15, "/dev/full", "rw", "ext4"),
    line(16, "/dev/random", "rw", "ext4"),
    line(17, "/dev/urandom", "rw", "ext4"),
    line(18, "/dev/tty", "rw", "ext4"),
  ].join("\n");
}

describe("sandbox probe mountinfo", () => {
  it("accepts precisely the fixed mount-plan destinations", () => {
    const mounts = assertSandboxProbeMounts(mountinfo(), {
      runtimeDirectories: ["bin"],
      writablePaths: ["src"],
    });

    expect(mounts).toHaveLength(18);
  });

  it.each([
    ["an unknown mount", `${mountinfo()}\n${line(19, "/host", "rw")}`],
    [
      "a writable workspace base",
      mountinfo().replace("/workspace ro,nosuid", "/workspace rw,nosuid"),
    ],
    ["a malformed escape", mountinfo().replace(" /workspace ", " /work\\141space ")],
    ["a duplicate mountpoint", `${mountinfo()}\n${line(19, "/tmp", "rw")}`],
  ])("rejects %s", (_name, value) => {
    expect(() =>
      assertSandboxProbeMounts(value, {
        runtimeDirectories: ["bin"],
        writablePaths: ["src"],
      }),
    ).toThrow();
  });

  it("decodes only Linux mountinfo path escapes", () => {
    const [mount] = parseSandboxProbeMountinfo(
      "1 1 0:1 /root\\040path /mount\\040point ro - tmpfs none ro",
    );

    expect(mount?.root).toBe("/root path");
    expect(mount?.mountPoint).toBe("/mount point");
  });
});
