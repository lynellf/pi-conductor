import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  verifyTrustedGitBinary: vi.fn(),
}));

let runSourceGit: typeof import("../../src/host/controller/source-workspace-git.js").runSourceGit;

beforeEach(async () => {
  vi.resetModules();
  mocks.spawn.mockReset();
  mocks.verifyTrustedGitBinary.mockReset();
  vi.doMock("node:child_process", () => ({ spawn: mocks.spawn }));
  vi.doMock("../../src/host/execution/sandbox/trusted-git-environment.js", () => ({
    trustedGitConfig: () => [],
    trustedGitEnvironment: () => ({}),
  }));
  vi.doMock("../../src/host/execution/sandbox/trusted-git-validation.js", () => ({
    verifyTrustedGitBinary: mocks.verifyTrustedGitBinary,
  }));
  ({ runSourceGit } = await import("../../src/host/controller/source-workspace-git.js"));
});

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("../../src/host/execution/sandbox/trusted-git-environment.js");
  vi.doUnmock("../../src/host/execution/sandbox/trusted-git-validation.js");
  vi.resetModules();
});

describe("source Git runner", () => {
  it("does not launch Git when its scope aborts while binary verification is pending", async () => {
    let releaseVerification: (() => void) | undefined;
    mocks.verifyTrustedGitBinary.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseVerification = resolve;
        }),
    );
    const abort = new AbortController();
    const running = runSourceGit("/sealed", ["status"], { signal: abort.signal });
    await vi.waitFor(() => expect(mocks.verifyTrustedGitBinary).toHaveBeenCalledOnce());

    abort.abort();
    releaseVerification?.();

    await expect(running).rejects.toMatchObject({ code: "aborted" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("waits for a killed process to close before reporting an abort", async () => {
    mocks.verifyTrustedGitBinary.mockResolvedValue(undefined);
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child as never);
    const abort = new AbortController();
    const running = runSourceGit("/sealed", ["status"], { signal: abort.signal });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    let settled = false;
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    abort.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("close", null, "SIGKILL");
    await expect(running).rejects.toMatchObject({ code: "aborted" });
    expect(settled).toBe(true);
  });
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    kill: vi.fn((_: NodeJS.Signals) => {
      child.killed = true;
      return true;
    }),
  });
  return child;
}
