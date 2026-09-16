import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { captureTrustedChildOutputs } from "../../src/host/controller/child-output-capture.js";
import type { ControllerChildOutputPolicy } from "../../src/manifest/controller-output.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Issue #116 trusted child output capture", () => {
  it("captures exact declared report bytes and an exact base-bound patch", async () => {
    const fixture = await repositoryFixture();
    await mkdir(join(fixture.repository, "reports"));
    await writeFile(join(fixture.repository, "reports/review.md"), "looks good\n");
    await writeFile(join(fixture.repository, "src/value.txt"), "changed\n");

    const selectedPolicy = policy();
    const result = await captureTrustedChildOutputs({
      worktree: { path: fixture.repository, branch: "child-output", acceptedBase: fixture.base },
      policy: selectedPolicy,
      policyDigest: sha256Canonical(selectedPolicy),
    });

    expect(result.capture).toMatchObject({
      accepted_base: fixture.base,
      head_commit: fixture.base,
      policy_digest: sha256Canonical(selectedPolicy),
      profile_id: "reviewer",
      outputs: [
        expect.objectContaining({ id: "report", path: "reports/review.md", kind: "report" }),
        expect.objectContaining({ id: "patch", path: null, kind: "patch" }),
      ],
    });
    expect(result.outputs).toEqual([
      expect.objectContaining({
        id: "report",
        path: "reports/review.md",
        kind: "report",
        mediaType: "text/markdown",
        bytes: Buffer.from("looks good\n"),
      }),
      expect.objectContaining({
        id: "patch",
        path: null,
        kind: "patch",
        mediaType: "application/x-git-patch",
      }),
    ]);
    expect(result.outputs[1]?.bytes.toString()).toContain("changed");
  });

  it("rejects a changed child HEAD before it reads any output", async () => {
    const fixture = await repositoryFixture();
    await writeFile(join(fixture.repository, "src/value.txt"), "committed child change\n");
    await git(fixture.repository, "add", "-A");
    await commit(fixture.repository, "child commit");

    await expect(capture(fixture.repository, fixture.base)).rejects.toThrow(
      "trusted child worktree branch or HEAD changed",
    );
  });

  it("rejects a changed path outside the exact policy", async () => {
    const fixture = await repositoryFixture();
    await writeFile(join(fixture.repository, "unexpected.txt"), "nope\n");

    await expect(capture(fixture.repository, fixture.base)).rejects.toThrow(
      "unexpected changed path",
    );
  });

  it("rejects an output source reached through a symlink", async () => {
    const fixture = await repositoryFixture();
    await mkdir(join(fixture.repository, "reports"));
    await symlink("/etc/hosts", join(fixture.repository, "reports/review.md"));

    await expect(capture(fixture.repository, fixture.base)).rejects.toThrow(
      "not a safe regular file",
    );
  });

  it("rejects a hard-linked report source", async () => {
    const fixture = await repositoryFixture();
    await mkdir(join(fixture.repository, "reports"));
    await link(
      join(fixture.repository, "src/value.txt"),
      join(fixture.repository, "reports/review.md"),
    );

    await expect(capture(fixture.repository, fixture.base)).rejects.toThrow(
      "not a safe regular file",
    );
  });

  it("rejects a report larger than its declared bounded capture", async () => {
    const fixture = await repositoryFixture();
    await mkdir(join(fixture.repository, "reports"));
    await writeFile(join(fixture.repository, "reports/review.md"), "x".repeat(128 * 1024 + 1));

    await expect(capture(fixture.repository, fixture.base)).rejects.toThrow(
      "report exceeds byte limit",
    );
  });

  it("refuses untracked patch sources instead of fabricating an unsafe diff", async () => {
    const fixture = await repositoryFixture();
    await mkdir(join(fixture.repository, "reports"));
    await writeFile(join(fixture.repository, "reports/review.md"), "looks good\n");
    await mkdir(join(fixture.repository, "src/new"));
    await writeFile(join(fixture.repository, "src/new/value.txt"), "new\n");
    const value = policy({ paths: ["src/new/value.txt"] });

    await expect(capture(fixture.repository, fixture.base, value)).rejects.toThrow(
      "cannot safely generate an untracked patch path",
    );
  });

  it("re-hashes an untracked report after capture so same-path mutation is detected", async () => {
    const fixture = await repositoryFixture();
    await mkdir(join(fixture.repository, "reports"));
    await writeFile(join(fixture.repository, "reports/review.md"), "first bytes\n");

    await expect(
      captureTrustedChildOutputs({
        worktree: {
          path: fixture.repository,
          branch: "child-output",
          acceptedBase: fixture.base,
        },
        policy: policy(),
        policyDigest: sha256Canonical(policy()),
        testHook: async () => {
          await writeFile(join(fixture.repository, "reports/review.md"), "other bytes\n");
        },
      }),
    ).rejects.toThrow("source changed during capture");
  });

  it("rejects a generated worktree root that is not current-user private", async () => {
    const fixture = await repositoryFixture();
    await chmod(fixture.repository, 0o755);

    await expect(capture(fixture.repository, fixture.base)).rejects.toThrow(
      "child output directory is unsafe",
    );
  });

  it("rejects a policy digest that does not bind the selected capture policy", async () => {
    const fixture = await repositoryFixture();

    await expect(
      captureTrustedChildOutputs({
        worktree: {
          path: fixture.repository,
          branch: "child-output",
          acceptedBase: fixture.base,
        },
        policy: policy(),
        policyDigest: "a".repeat(64),
      }),
    ).rejects.toThrow("child output policy digest is invalid");
  });
});

function capture(repository: string, base: string, value: ControllerChildOutputPolicy = policy()) {
  return captureTrustedChildOutputs({
    worktree: { path: repository, branch: "child-output", acceptedBase: base },
    policy: value,
    policyDigest: sha256Canonical(value),
  });
}

function policy(
  patch: { readonly paths: string[] } = { paths: ["src/value.txt"] },
): ControllerChildOutputPolicy {
  return {
    profile_id: "reviewer",
    reports: [
      {
        id: "report",
        path: "reports/review.md",
        media_type: "text/markdown",
        max_bytes: 128 * 1024,
        consumers: [{ kind: "controller" }],
      },
    ],
    patch: {
      id: "patch",
      paths: patch.paths,
      max_bytes: 512 * 1024,
      consumers: [{ kind: "controller" }],
    },
  };
}

async function repositoryFixture(): Promise<{
  readonly repository: string;
  readonly base: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-output-capture-"));
  roots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository, { mode: 0o700 });
  await git(repository, "init", "-q", "-b", "child-output");
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src/value.txt"), "original\n");
  await git(repository, "add", "-A");
  await commit(repository, "base");
  return { repository, base: await git(repository, "rev-parse", "HEAD") };
}

async function commit(repository: string, message: string): Promise<void> {
  await execute("/usr/bin/git", [
    "-C",
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

async function git(repository: string, ...args: string[]): Promise<string> {
  return (await execute("/usr/bin/git", ["-C", repository, ...args])).stdout.trim();
}
