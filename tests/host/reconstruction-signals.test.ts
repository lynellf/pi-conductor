/**
 * Issue #139 Phase 3 RED: reconstruction-signal classifier + prompt guidance.
 *
 * Signals are observability only; they neither reject tool calls nor claim
 * to observe all repository reads. The classifier is conservative and
 * documented; fingerprints are hash-only.
 */

import { describe, expect, it } from "vitest";
import {
  classifyBashCommand,
  classifyHostTool,
  fingerprintCommand,
  normalizeCommand,
} from "../../src/host/reconstruction-classifier.js";

describe("reconstruction classifier (issue #139 Phase 3)", () => {
  it("flags broad find over the workspace root without -maxdepth", () => {
    expect(classifyBashCommand("find . -name '*.ts'")).toBe("broad_find");
    expect(classifyBashCommand("find . -type f")).toBe("broad_find");
  });

  it("does not flag a depth-bounded find", () => {
    expect(classifyBashCommand("find . -maxdepth 2 -name '*.ts'")).toBeNull();
    expect(classifyBashCommand("find src -name '*.ts'")).toBeNull();
  });

  it("flags wide rg with no path or dot root", () => {
    expect(classifyBashCommand("rg 'phase_work_packet'")).toBe("wide_rg");
    expect(classifyBashCommand("rg pattern .")).toBe("wide_rg");
  });

  it("does not flag a narrowly-scoped rg", () => {
    expect(classifyBashCommand("rg pattern src/host")).toBeNull();
  });

  it("flags handoff_context reads and ignores other tools", () => {
    expect(classifyHostTool("handoff_context")).toBe("predecessor_context_read");
    expect(classifyHostTool("bash")).toBeNull();
    expect(classifyHostTool("handoff")).toBeNull();
  });

  it("redacts commands to hash-only fingerprints", () => {
    const fingerprint = fingerprintCommand(normalizeCommand("find . -name '*.ts'"));
    expect(fingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(fingerprint).not.toContain("find");
  });
});
