import { describe, expect, it, vi } from "vitest";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";

const origin = {
  schema_version: 1 as const,
  boot_id: "12345678-1234-1234-1234-123456789abc",
  pid_namespace: "pid:[100]",
  time_namespace: "time:[101]",
  network_namespace: "net:[102]",
  init_start_time: "1",
  preexisting_before: "500",
};

async function subject(changes: Record<string, string | Error> = {}, entries = ["1", "100"]) {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const values: Record<string, string | Error> = {
    "/proc/sys/kernel/random/boot_id": origin.boot_id,
    "/proc/self/ns/pid": origin.pid_namespace,
    "/proc/self/ns/time": origin.time_namespace,
    "/proc/self/ns/net": origin.network_namespace,
    "/proc/self/status": `NSpid:\t${process.pid}\n`,
    "/proc/1/stat": `1 (init) S 0 1 1 ${Array(15).fill(0).join(" ")} 1`,
    "/proc/100/stat": `100 (worker) S 0 100 100 ${Array(15).fill(0).join(" ")} 500`,
    ...changes,
  };
  const read = vi.fn(async (path: string) => {
    const value = values[path];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`unexpected access: ${path}`);
    return value;
  });
  vi.resetModules();
  vi.doMock("node:fs/promises", () => ({
    ...actual,
    readFile: read,
    readlink: read,
    readdir: vi.fn().mockResolvedValue(entries),
  }));
  const module = await import("../../src/host/execution/tool-admission.js");
  return { ...module, read };
}

describe("persisted admission origin", () => {
  it("keeps real capture stat failures sanitized and prevents persistence or launch", async () => {
    try {
      const { captureToolAdmission } = await subject({
        "/proc/100/stat": Object.assign(new Error("PRIVATE credentials"), { code: "EACCES" }),
      });
      const persist = vi.fn();
      const operation = vi.fn();
      const controller = new ToolExecutionController({
        runId: "run",
        logicalSessionId: "logical",
        roleSessionId: "role",
        policy: DEFAULT_TOOL_EXECUTION_POLICY,
        persist,
      });
      const failure = await controller
        .run("bash", "call", operation, { captureAdmission: captureToolAdmission })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ operation: "read_stat", code: "EACCES", pid: 100 });
      expect(failure).toHaveProperty("message", expect.not.stringContaining("PRIVATE"));
      expect(persist).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("rejects an origin change while capturing the snapshot", async () => {
    try {
      const { captureToolAdmission, read } = await subject();
      const original = read.getMockImplementation();
      if (original === undefined) throw new Error("missing fixture reader");
      let bootReads = 0;
      read.mockImplementation(async (path) => {
        if (path === "/proc/sys/kernel/random/boot_id" && bootReads++ > 0)
          return "99999999-1234-1234-1234-123456789abc";
        return original(path);
      });
      await expect(captureToolAdmission()).rejects.toMatchObject({
        code: "admission_origin_mismatch",
      });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("captures the maximum pre-launch tick with only identity metadata", async () => {
    try {
      const { captureToolAdmission, read } = await subject();
      expect(await captureToolAdmission()).toEqual(origin);
      expect(read.mock.calls.some(([path]) => path.endsWith("/environ"))).toBe(false);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("refuses an empty snapshot instead of manufacturing a boundary", async () => {
    try {
      const { captureToolAdmission } = await subject({}, []);
      await expect(captureToolAdmission()).rejects.toMatchObject({
        code: "admission_origin_unavailable",
      });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("restores a matching origin without taking a new baseline", async () => {
    try {
      const { restoreToolAdmission, read } = await subject();
      const scope = await restoreToolAdmission(origin);
      expect(scope.preexistingBefore).toBe("500");
      expect(scope.preexisting.size).toBe(0);
      expect(read.mock.calls.some(([path]) => path.endsWith("/environ"))).toBe(false);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it.each([
    ["boot", "/proc/sys/kernel/random/boot_id", "99999999-1234-1234-1234-123456789abc"],
    ["PID namespace", "/proc/self/ns/pid", "pid:[900]"],
    ["time namespace", "/proc/self/ns/time", "time:[901]"],
    ["network namespace", "/proc/self/ns/net", "net:[902]"],
    ["PID view", "/proc/self/status", `NSpid:\t900\t${process.pid}\n`],
    ["namespace init", "/proc/1/stat", `1 (init) S 0 1 1 ${Array(15).fill(0).join(" ")} 2`],
  ])("rejects a changed %s", async (_label, path, value) => {
    try {
      const { restoreToolAdmission } = await subject({ [path]: value });
      await expect(restoreToolAdmission(origin)).rejects.toMatchObject({
        code: "admission_origin_mismatch",
      });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it.each([
    { ...origin, preexisting_before: "PRIVATE" },
    { ...origin, preexisting_before: "-1" },
    { ...origin, schema_version: 2 },
    { ...origin, private: "PRIVATE" },
    { ...origin, boot_id: undefined },
  ])("rejects corrupt evidence without using it", async (evidence) => {
    try {
      const { restoreToolAdmission, read } = await subject();
      await expect(restoreToolAdmission(evidence)).rejects.toMatchObject({
        code: "admission_evidence_invalid",
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("reports unavailable origin observation without exposing raw errors", async () => {
    try {
      const { restoreToolAdmission } = await subject({
        "/proc/self/ns/time": Object.assign(new Error("PRIVATE"), { code: "EACCES" }),
      });
      await expect(restoreToolAdmission(origin)).rejects.toMatchObject({
        code: "admission_origin_unavailable",
      });
      await expect(restoreToolAdmission(origin)).rejects.not.toThrow("PRIVATE");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});
