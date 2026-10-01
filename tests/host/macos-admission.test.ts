import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  captureToolAdmission,
  restoreToolAdmission,
} from "../../src/host/execution/tool-admission.js";
import { toolAdmissionSchema } from "../../src/persistence/tool-admission.js";

describe.runIf(process.platform === "darwin")("Darwin durable admission", () => {
  it("retains an original boot-bound raw Mach boundary", async () => {
    const admission = await captureToolAdmission();
    expect(admission).toMatchObject({ schema_version: 2, platform: "darwin" });
    expect(Value.Check(toolAdmissionSchema, admission)).toBe(true);
    const restored = await restoreToolAdmission(admission);
    if (admission.schema_version !== 2) throw new Error("expected Darwin origin");
    expect(restored.preexisting.size).toBe(admission.preexisting_sessions.length);
    expect([...restored.preexisting.values()]).toEqual(
      admission.preexisting_sessions.map((value) => ({
        pid: value.pid,
        startTime: value.start_time,
        startTimeKind: value.start_time_kind,
        processGroupId: value.process_group_id,
        sessionId: value.session_id,
      })),
    );
    expect(restored.preexistingBefore).toBe(admission.preexisting_before);
  });

  it("refuses a foreign boot without manufacturing a new baseline", async () => {
    const admission = await captureToolAdmission();
    await expect(
      restoreToolAdmission({ ...admission, boot_id: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toMatchObject({ code: "admission_origin_mismatch" });
  });

  it("never interprets a historical Linux record as Darwin evidence", async () => {
    await expect(
      restoreToolAdmission({
        schema_version: 1,
        boot_id: "00000000-0000-0000-0000-000000000000",
        pid_namespace: "pid:[1]",
        time_namespace: "time:[2]",
        network_namespace: "net:[3]",
        init_start_time: "1",
        preexisting_before: "2",
      }),
    ).rejects.toMatchObject({ code: "admission_origin_mismatch" });
  });
});
