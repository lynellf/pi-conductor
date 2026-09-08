import { describe, expect, it } from "vitest";
import { toMachineDefinition } from "../../src/manifest/definition.js";
import { parseEndGuardConfig, resolveEndGuardConfig } from "../../src/manifest/end-guard.js";
import { parseManifest } from "../../src/manifest/parse.js";
import type { Manifest } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";
import {
  createManifestSnapshot,
  verifyManifestSnapshot,
} from "../../src/persistence/trajectory-records.js";

const BASE_YAML = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
`;

describe("end guard manifest contract", () => {
  it("preserves omitted end_guard for historical manifests", () => {
    expect(parseManifest(BASE_YAML).end_guard).toBeUndefined();
  });

  it("normalizes the configured timeout and freezes the pinned snapshot", () => {
    const manifest = parseManifest(`${BASE_YAML}end_guard:\n  command: npm test\n`);

    const config = manifest.end_guard;
    expect(config).toEqual({ command: "npm test", timeout_seconds: 60 });
    expect(Object.isFrozen(config)).toBe(true);
    if (config === undefined) throw new Error("expected parsed end_guard");
    expect(resolveEndGuardConfig(config)).toEqual({
      command: "npm test",
      timeout_seconds: 60,
    });
  });

  it("accepts positive fractional deadlines through the maximum", () => {
    expect(parseEndGuardConfig({ command: "check", timeout_seconds: 0.25 })).toEqual({
      command: "check",
      timeout_seconds: 0.25,
    });
    expect(parseEndGuardConfig({ command: "check", timeout_seconds: 3_600 })).toEqual({
      command: "check",
      timeout_seconds: 3_600,
    });
  });

  it("rejects an omitted config when the parser helper is called directly", () => {
    expect(() => parseEndGuardConfig(undefined)).toThrow("end_guard must be configured");
    expect(() => resolveEndGuardConfig(undefined as unknown as { command: string })).toThrow(
      "end_guard must be configured",
    );
  });

  it.each([
    ["empty command", { command: "   " }],
    ["unknown field", { command: "check", cwd: "/tmp" }],
    ["zero timeout", { command: "check", timeout_seconds: 0 }],
    ["negative timeout", { command: "check", timeout_seconds: -1 }],
    ["too large timeout", { command: "check", timeout_seconds: 3_601 }],
    ["NaN timeout", { command: "check", timeout_seconds: Number.NaN }],
    ["infinite timeout", { command: "check", timeout_seconds: Number.POSITIVE_INFINITY }],
  ])("rejects %s", (_name, config) => {
    expect(() => parseEndGuardConfig(config)).toThrow();
  });

  it.each([
    null,
    [],
    "check",
    { command: "check", timeout_seconds: "60" },
  ])("rejects malformed end_guard value %j", (value) => {
    expect(() => parseManifest(`${BASE_YAML}end_guard: ${JSON.stringify(value)}\n`)).toThrow();
  });

  it("rejects malformed programmatic config through manifest validation", () => {
    const manifest = {
      version: 1,
      roles: [{ name: "orchestrator", is_orchestrator: true }],
      end_guard: { command: "check", timeout_seconds: Number.NaN },
    } as unknown as Manifest;

    expect(validateManifest(manifest).errors.map((error) => error.code)).toContain(
      "invalid-end-guard",
    );
  });

  it("pins the normalized guard and changes its snapshot hash when edited", () => {
    const firstManifest = parseManifest(
      `${BASE_YAML}end_guard:\n  command: check\n  timeout_seconds: 12.5\n`,
    );
    const changedManifest = parseManifest(
      `${BASE_YAML}end_guard:\n  command: check --strict\n  timeout_seconds: 12.5\n`,
    );
    const first = createManifestSnapshot({
      runId: "run-1",
      manifest: firstManifest,
      definition: toMachineDefinition(firstManifest),
      ts: 1,
    });
    const changed = createManifestSnapshot({
      runId: "run-1",
      manifest: changedManifest,
      definition: toMachineDefinition(changedManifest),
      ts: 1,
    });
    expect(first.normalized_manifest.end_guard).toEqual({
      command: "check",
      timeout_seconds: 12.5,
    });
    expect(verifyManifestSnapshot(first)).toBe(first);
    expect(changed.sha256).not.toBe(first.sha256);
  });
});
