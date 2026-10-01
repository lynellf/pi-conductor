import * as childProcess from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actualExec = childProcess.execFileSync;
let home = "";
const originalHome = process.env.HOME;

describe.runIf(process.platform === "darwin")("private Darwin observer setup", () => {
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "pi-conductor-native-cache-")));
    process.env.HOME = home;
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });
  it("builds a signed architecture-checked observer and rejects subsequent changes", async () => {
    const { prepareMacObserver } = await import(
      "../../src/host/execution/macos/observer-runtime.js"
    );
    const path = prepareMacObserver();
    expect(path.startsWith(`${home}/.pi-conductor-native/`)).toBe(true);
    expect(prepareMacObserver()).toBe(path);
    writeFileSync(path, "not the compiled observer");
    expect(() => prepareMacObserver()).toThrow("observer changed after preparation");
  });
  it("refuses unavailable native API visibility even when compilation and signature succeed", async () => {
    const setup = vi.fn((...args: Parameters<typeof actualExec>) => {
      if (String(args[0]).endsWith("/observer")) throw new Error("PRIVATE denied metadata");
      return actualExec(...args);
    });
    vi.doMock("node:child_process", () => ({ ...childProcess, execFileSync: setup }));
    const { assertMacObserverReady } = await import(
      "../../src/host/execution/macos/observer-runtime.js"
    );
    expect(() => assertMacObserverReady()).toThrow(
      "native API visibility or observer protocol is unavailable",
    );
  });
  it("refuses a symlink cache without invoking compiler installation", async () => {
    symlinkSync(home, join(home, ".pi-conductor-native"));
    const { prepareMacObserver } = await import(
      "../../src/host/execution/macos/observer-runtime.js"
    );
    expect(() => prepareMacObserver()).toThrow("canonical, owned, and mode 0700");
  });
  it("rejects an extended ACL even when the private cache has mode 0700", async () => {
    const root = join(home, ".pi-conductor-native");
    mkdirSync(root, { mode: 0o700 });
    actualExec("/bin/chmod", ["+a", "everyone allow add_file", root]);
    const { prepareMacObserver } = await import(
      "../../src/host/execution/macos/observer-runtime.js"
    );
    expect(() => prepareMacObserver()).toThrow("must not have an extended ACL");
  });
  it("probes xcode-select before any compiler shim and sanitizes a missing toolchain", async () => {
    const setup = vi.fn((..._args: Parameters<typeof actualExec>) => {
      throw new Error("PRIVATE toolchain failure");
    });
    vi.doMock("node:child_process", () => ({ ...childProcess, execFileSync: setup }));
    const { prepareMacObserver } = await import(
      "../../src/host/execution/macos/observer-runtime.js"
    );
    expect(() => prepareMacObserver()).toThrow("install Xcode Command Line Tools");
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup.mock.calls[0]?.[0]).toBe("/usr/bin/xcode-select");
  });
  it("retains the private build lock after unobserved compiler settlement", async () => {
    const setup = vi.fn((...args: Parameters<typeof actualExec>) => {
      if (String(args[0]).endsWith("/clang"))
        throw Object.assign(new Error("interrupted"), { status: null, signal: "SIGTERM" });
      return actualExec(...args);
    });
    vi.doMock("node:child_process", () => ({ ...childProcess, execFileSync: setup }));
    const { prepareMacObserver } = await import(
      "../../src/host/execution/macos/observer-runtime.js"
    );
    expect(() => prepareMacObserver()).toThrow("inspect compiler settlement");
    const root = join(home, ".pi-conductor-native");
    const version = readdirSync(root)[0];
    if (version === undefined) throw new Error("missing version directory");
    expect(existsSync(join(root, version, "build-lock"))).toBe(true);
    expect(() => prepareMacObserver()).toThrow("already active or uncertain");
  });
});
