/** Validated native capability-probe evidence for Issue #106 §5. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const MAX_PROBE_OUTPUT_BYTES = 128 * 1024;
const MAX_MOUNTINFO_BYTES = 64 * 1024;
const ZERO_CAPABILITY_SET = "0000000000000000";
const CONNECTION_DENIAL_ERRNOS = new Set([101, 111, 113]);
const NESTED_USER_NAMESPACE_DENIAL_ERRNOS = new Set([1, 28, 87]);

/** Fixed path of the approved native probe inside a prepared runtime. */
export const SANDBOX_CAPABILITY_PROBE_PATH = "/opt/pi-conductor/probes/capability-probe-v1";

const capabilitySet = Type.String({ pattern: "^[0-9a-f]{16}$" });
const namespaceSchema = Type.Object(
  {
    ipc: Type.String({ pattern: "^ipc:\\[[0-9]+\\]$" }),
    mnt: Type.String({ pattern: "^mnt:\\[[0-9]+\\]$" }),
    net: Type.String({ pattern: "^net:\\[[0-9]+\\]$" }),
    pid: Type.String({ pattern: "^pid:\\[[0-9]+\\]$" }),
    user: Type.String({ pattern: "^user:\\[[0-9]+\\]$" }),
    uts: Type.String({ pattern: "^uts:\\[[0-9]+\\]$" }),
  },
  { additionalProperties: false },
);

/** Bounded raw observations emitted by the fixed prepared-runtime probe. */
export const sandboxCapabilityProbeReportSchema = Type.Object(
  {
    capabilities_zero: Type.Boolean(),
    cap_amb: capabilitySet,
    cap_bnd: capabilitySet,
    cap_eff: capabilitySet,
    cap_inh: capabilitySet,
    cap_prm: capabilitySet,
    devices_match: Type.Boolean(),
    external_interfaces: Type.Integer({ minimum: 0, maximum: 1_024 }),
    extra_fds: Type.Integer({ minimum: 0, maximum: 1_024 }),
    host_connection_denied: Type.Boolean(),
    host_connection_errno: Type.Integer({ minimum: 0, maximum: 4_096 }),
    mountinfo: Type.String({ maxLength: MAX_MOUNTINFO_BYTES }),
    namespace: namespaceSchema,
    nested_userns_denied: Type.Boolean(),
    nested_userns_errno: Type.Integer({ minimum: 0, maximum: 4_096 }),
    nested_userns_result: Type.Integer({ minimum: -1, maximum: 1 }),
    no_new_privs: Type.Integer({ minimum: 0, maximum: 1 }),
    schema_version: Type.Literal(1),
    sentinel_absent: Type.Boolean(),
    sentinel_errno: Type.Integer({ minimum: 0, maximum: 4_096 }),
  },
  { additionalProperties: false },
);

/** Raw report from the fixed operator-prepared native capability probe. */
export type SandboxCapabilityProbeReport = Readonly<
  Static<typeof sandboxCapabilityProbeReportSchema>
>;

/** Host namespace links used to reject a probe report that observed host identity. */
export type SandboxCapabilityProbeHostNamespaces = Readonly<Static<typeof namespaceSchema>>;

/**
 * Parses and verifies direct probe observations before sandbox admission.
 * Mount-plan validation consumes the retained bounded mountinfo separately.
 */
export function parseSandboxCapabilityProbeReport(
  stdout: string,
  hostNamespaces: SandboxCapabilityProbeHostNamespaces,
): SandboxCapabilityProbeReport {
  if (Buffer.byteLength(stdout, "utf8") > MAX_PROBE_OUTPUT_BYTES) {
    throw new Error("sandbox capability probe report is too large");
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(stdout);
  } catch {
    throw new Error("sandbox capability probe report is not valid JSON");
  }

  return assertSandboxCapabilityProbeReport(candidate, hostNamespaces);
}

/** Verifies raw capability-probe facts and returns an immutable typed report. */
export function assertSandboxCapabilityProbeReport(
  candidate: unknown,
  hostNamespaces: SandboxCapabilityProbeHostNamespaces,
): SandboxCapabilityProbeReport {
  if (!Value.Check(namespaceSchema, hostNamespaces)) {
    throw new Error("host sandbox namespace observation does not match schema");
  }
  if (!Value.Check(sandboxCapabilityProbeReportSchema, candidate)) {
    throw new Error("sandbox capability probe report does not match schema version 1");
  }

  const report = candidate as Static<typeof sandboxCapabilityProbeReportSchema>;
  const capabilitySets = [
    report.cap_inh,
    report.cap_prm,
    report.cap_eff,
    report.cap_bnd,
    report.cap_amb,
  ];
  if (!report.capabilities_zero || capabilitySets.some((set) => set !== ZERO_CAPABILITY_SET)) {
    throw new Error("sandbox capability probe retained capabilities");
  }
  if (report.extra_fds !== 0) {
    throw new Error("sandbox capability probe observed an unexpected file descriptor");
  }
  if (report.external_interfaces !== 0 || !report.host_connection_denied) {
    throw new Error("sandbox capability probe observed host network access");
  }
  if (!CONNECTION_DENIAL_ERRNOS.has(report.host_connection_errno)) {
    throw new Error("sandbox capability probe reported an unexpected network denial errno");
  }
  if (!report.devices_match) {
    throw new Error("sandbox capability probe observed unexpected devices");
  }
  if (
    !report.nested_userns_denied ||
    report.nested_userns_result !== -1 ||
    !NESTED_USER_NAMESPACE_DENIAL_ERRNOS.has(report.nested_userns_errno)
  ) {
    throw new Error("sandbox capability probe allowed a nested user namespace");
  }
  if (report.no_new_privs !== 1) {
    throw new Error("sandbox capability probe did not set no_new_privs");
  }
  if (!report.sentinel_absent || report.sentinel_errno !== 2) {
    throw new Error("sandbox capability probe could access the host sentinel");
  }
  if (
    report.mountinfo.length === 0 ||
    Buffer.byteLength(report.mountinfo, "utf8") > MAX_MOUNTINFO_BYTES
  ) {
    throw new Error("sandbox capability probe did not report mountinfo");
  }

  for (const name of ["mnt", "user", "net", "ipc", "uts", "pid"] as const) {
    if (report.namespace[name] === hostNamespaces[name]) {
      throw new Error(
        "sandbox capability probe retained the host %s namespace".replace("%s", name),
      );
    }
  }

  return Object.freeze({ ...report, namespace: Object.freeze({ ...report.namespace }) });
}
