import { describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

// Touch ManifestParseError so the contract import is referenced even when no
// test currently asserts on its identity. The green phase may rely on this
// error type being available.
const _manifestParseErrorRef: typeof ManifestParseError = ManifestParseError;

// ---------- helpers ----------

type AnyObj = Record<string, unknown>;

function minimalYaml(recipes?: unknown[]): string {
  const obj: AnyObj = {
    version: 1,
    roles: [
      { name: "orchestrator", is_orchestrator: true },
      { name: "parent", max_visits: 1 },
    ],
  };
  if (recipes !== undefined) obj.verification_recipes = recipes;
  return yamlStringify(obj);
}

function recipe(overrides: AnyObj = {}): AnyObj {
  return {
    name: "r0",
    commands: [{ executable: "/bin/echo", args: ["hi"] }],
    evaluation: "report_only",
    required_paths: ["src/foo.ts"],
    timeout_seconds: 30,
    max_calls: 1,
    ...overrides,
  };
}

function uniqueRecipes(n: number, prefix = "r"): AnyObj[] {
  return Array.from({ length: n }, (_, i) =>
    recipe({ name: `${prefix}${i.toString().padStart(2, "0")}` }),
  );
}

interface CheckResult {
  manifest: AnyObj;
  errors: string[];
  threw: boolean;
}

function check(yamlStr: string): CheckResult {
  let threw = false;
  let manifest: AnyObj = {};
  let errors: string[] = [];
  try {
    manifest = parseManifest(yamlStr) as unknown as AnyObj;
    errors = validateManifest(
      manifest as unknown as Parameters<typeof validateManifest>[0],
    ).errors.map((e) => (e as unknown as AnyObj).code as string);
  } catch {
    threw = true;
  }
  return { manifest, errors, threw };
}

function expectAccepted(yamlStr: string, expectedCount: number) {
  const { manifest, errors, threw } = check(yamlStr);
  expect(threw).toBe(false);
  expect(errors).toEqual([]);
  expect(manifest.verification_recipes).toHaveLength(expectedCount);
}

function expectRejected(yamlStr: string) {
  const { errors, threw } = check(yamlStr);
  // A recipe inventory is rejected when either the parser throws (closed
  // shape violation) or the validator reports errors (semantic bound).
  expect(threw || errors.length > 0).toBe(true);
}

// ---------- suite ----------

describe("delegated-verification §3.1 top-level verification_recipes", () => {
  it("(1) omits verification_recipes when absent and validates clean", () => {
    const { manifest, errors, threw } = check(minimalYaml());
    expect(threw).toBe(false);
    expect(errors).toEqual([]);
    expect(manifest.verification_recipes).toBeUndefined();
  });

  it("(2) accepts exactly 1 valid recipe", () => {
    expectAccepted(minimalYaml([recipe({ name: "single" })]), 1);
  });

  it("(3) accepts exactly 64 unique-named recipes", () => {
    expectAccepted(minimalYaml(uniqueRecipes(64)), 64);
  });

  it("(4) rejects 65 recipes", () => {
    expectRejected(minimalYaml(uniqueRecipes(65)));
  });

  it("(5) rejects duplicate recipe names", () => {
    expectRejected(minimalYaml([recipe({ name: "dup" }), recipe({ name: "dup" })]));
  });

  describe("(6) NAME GRAMMAR (^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$)", () => {
    it.each([
      ["starts with hyphen", "-bad"],
      ["contains space", "has space"],
      ["contains slash", "has/slash"],
      ["65 chars exceeds 64 max", "a".repeat(65)],
    ])("rejects: %s", (_label, name) => {
      expectRejected(minimalYaml([recipe({ name })]));
    });
  });

  describe("(7) COMMANDS COUNT (1..16)", () => {
    it.each([
      ["empty (rejected)", [], true],
      [
        "17 (rejected)",
        Array.from({ length: 17 }, () => ({ executable: "/bin/echo", args: [] })),
        true,
      ],
      ["1 (accepted)", [{ executable: "/bin/echo", args: [] }], false],
      [
        "16 (accepted)",
        Array.from({ length: 16 }, () => ({ executable: "/bin/echo", args: [] })),
        false,
      ],
    ])("commands=%s", (_label, commands, rejected) => {
      const y = minimalYaml([recipe({ commands })]);
      if (rejected) {
        expectRejected(y);
      } else {
        expectAccepted(y, 1);
      }
    });
  });

  describe("(8) EXECUTABLE ABSOLUTE PATH", () => {
    it.each([
      ["relative 'echo'", "echo"],
      ["outside /bin|/sbin|/usr|/opt '/etc/passwd'", "/etc/passwd"],
      ["contains NUL byte", "/bin/echo\u0000bad"],
      ["path > 1024 UTF-8 bytes", `/bin/${"a".repeat(1024)}`],
    ])("rejects executable: %s", (_label, executable) => {
      expectRejected(minimalYaml([recipe({ commands: [{ executable, args: [] }] })]));
    });
  });

  describe("(9) ARGS BOUNDS", () => {
    it("rejects 129 args in a single command", () => {
      expectRejected(
        minimalYaml([
          recipe({
            commands: [
              {
                executable: "/bin/echo",
                args: Array.from({ length: 129 }, (_, i) => `a${i}`),
              },
            ],
          }),
        ]),
      );
    });

    it("rejects arg > 4096 bytes", () => {
      expectRejected(
        minimalYaml([
          recipe({
            commands: [{ executable: "/bin/echo", args: ["x".repeat(4097)] }],
          }),
        ]),
      );
    });

    it("rejects arg containing NUL", () => {
      expectRejected(
        minimalYaml([
          recipe({
            commands: [{ executable: "/bin/echo", args: ["bad\u0000arg"] }],
          }),
        ]),
      );
    });
  });

  describe("(10) EVALUATION POLICY {report_only, require_pass, require_fail}", () => {
    it("rejects unknown evaluation value", () => {
      expectRejected(minimalYaml([recipe({ evaluation: "block_hard" })]));
    });

    it("rejects require_fail with > 1 command", () => {
      expectRejected(
        minimalYaml([
          recipe({
            evaluation: "require_fail",
            commands: [
              { executable: "/bin/echo", args: [] },
              { executable: "/bin/ls", args: [] },
            ],
          }),
        ]),
      );
    });

    it("accepts require_fail with exactly 1 command", () => {
      expectAccepted(
        minimalYaml([
          recipe({
            evaluation: "require_fail",
            commands: [{ executable: "/bin/echo", args: [] }],
          }),
        ]),
        1,
      );
    });

    it("accepts require_pass with multiple commands", () => {
      expectAccepted(
        minimalYaml([
          recipe({
            evaluation: "require_pass",
            commands: [
              { executable: "/bin/echo", args: [] },
              { executable: "/bin/ls", args: [] },
            ],
          }),
        ]),
        1,
      );
    });
  });

  describe("(11) REQUIRED_PATHS", () => {
    it("rejects empty required_paths array", () => {
      expectRejected(minimalYaml([recipe({ required_paths: [] })]));
    });

    it("rejects duplicate paths", () => {
      expectRejected(minimalYaml([recipe({ required_paths: ["a/b", "a/b"] })]));
    });

    it("rejects more than 64 required_paths entries", () => {
      const many = Array.from({ length: 65 }, (_, i) => `p${i}`);
      expectRejected(minimalYaml([recipe({ required_paths: many })]));
    });

    it.each([
      ["absolute '/etc/passwd'", "/etc/passwd"],
      ["contains '..'", "foo/../bar"],
    ])("rejects unsafe path: %s", (_label, p) => {
      expectRejected(minimalYaml([recipe({ required_paths: [p] })]));
    });
  });

  describe("(12) TIMEOUT_SECONDS (1..600)", () => {
    it.each([
      ["0 (rejected)", 0, true],
      ["601 (rejected)", 601, true],
      ["1 (accepted)", 1, false],
      ["600 (accepted)", 600, false],
    ])("timeout_seconds %s", (_label, timeout_seconds, rejected) => {
      const y = minimalYaml([recipe({ timeout_seconds })]);
      if (rejected) {
        expectRejected(y);
      } else {
        expectAccepted(y, 1);
      }
    });
  });

  describe("(13) MAX_CALLS (1..32)", () => {
    it.each([
      ["0 (rejected)", 0, true],
      ["33 (rejected)", 33, true],
      ["1 (accepted)", 1, false],
      ["32 (accepted)", 32, false],
    ])("max_calls %s", (_label, max_calls, rejected) => {
      const y = minimalYaml([recipe({ max_calls })]);
      if (rejected) {
        expectRejected(y);
      } else {
        expectAccepted(y, 1);
      }
    });
  });

  describe("(14) FORBIDDEN COMMAND FIELDS (closed shape)", () => {
    it.each([
      "shell",
      "environment",
      "working_directory",
      "network",
      "credentials",
      "host_paths",
      "glob",
      "interpolation",
      "output_destinations",
    ])("rejects command carrying extra field: %s", (field) => {
      const cmd: AnyObj = { executable: "/bin/echo", args: [] };
      cmd[field] = "anything";
      expectRejected(minimalYaml([recipe({ commands: [cmd] })]));
    });
  });

  it("(15) rejects recipe with extra unknown top-level key (strict shape)", () => {
    expectRejected(minimalYaml([recipe({ extra_top_level_key: "oops" })]));
  });

  it("(16) rejects single recipe whose canonical JSON exceeds 65,536 bytes", () => {
    // Build unique strings per command so yaml cannot anchor-share. Each
    // command: executable "/bin/" + 1019 unique chars = 1024 bytes; arg 4096
    // unique chars. 16 commands => ~82KB canonical JSON per recipe, > 65,536 cap.
    const commands: AnyObj[] = [];
    for (let j = 0; j < 16; j++) {
      const exePad = `A${j}`.repeat(Math.ceil(1019 / 2)).slice(0, 1019);
      const argPad = `B${j}`.repeat(Math.ceil(4096 / 2)).slice(0, 4096);
      commands.push({ executable: `/bin/${exePad}`, args: [argPad] });
    }
    const big = recipe({
      name: "big-recipe",
      commands,
    });
    expectRejected(minimalYaml([big]));
  });

  it("(17) rejects total recipe inventory whose canonical JSON exceeds 1,048,576 bytes", () => {
    // 13 recipes x ~82KB canonical JSON ≈ 1.07MB, > 1,048,576 cap.
    // Each command has unique strings; otherwise the yaml library refuses to
    // expand shared anchors past a resource-exhaustion threshold.
    const recipes: AnyObj[] = [];
    for (let i = 0; i < 13; i++) {
      const commands: AnyObj[] = [];
      for (let j = 0; j < 16; j++) {
        const exePad = `A${i}${j}`.repeat(Math.ceil(1019 / 3)).slice(0, 1019);
        const argPad = `B${i}${j}`.repeat(Math.ceil(4096 / 3)).slice(0, 4096);
        commands.push({ executable: `/bin/${exePad}`, args: [argPad] });
      }
      recipes.push(
        recipe({
          name: `big-${i.toString().padStart(2, "0")}`,
          commands,
        }),
      );
    }
    expectRejected(minimalYaml(recipes));
  });

  // ---- Reviewer remediation regressions (commit c35e3a6) ----------------

  describe("(F1 CRITICAL) rejects executable with .. or non-canonical forms", () => {
    // Spec §3.1 says command.executable must be a trusted absolute path under
    // /bin|/sbin|/usr|/opt; literal-prefix matching is bypassable by path
    // traversal, redundant separators, or non-canonical dot segments. Each
    // literal starts with /usr/ yet must be rejected.
    it.each([
      ["dotdot sibling", "/usr/../../etc/passwd"],
      ["dotdot child", "/usr/../bin/x"],
      ["redundant separator", "/usr//foo"],
      ["dot segment", "/usr/./bin/x"],
      ["traversal via dotdot", "/usr/x/../y"],
    ])("rejects executable: %s", (_label, executable) => {
      expectRejected(minimalYaml([recipe({ commands: [{ executable, args: [] }] })]));
    });
  });

  describe("(F9 MEDIUM) inventory canonical JSON is the OBJECT-array form, not an escaped string-array", () => {
    // With the per-arg 4,096-byte cap and 64-recipe cap, no public inventory
    // can exceed the 1 MB cap under either canonical form, so we assert the
    // canonical form structurally: importing canonicalizeVerificationRecipe
    // and confirming the inventory canonical JSON parses to an array of
    // OBJECTS, not an array of escaped strings (the buggy F9 form).
    it("inventory canonical form is an array of objects, not an array of escaped strings", async () => {
      const { canonicalizeVerificationRecipe } = await import(
        "../../src/manifest/verification-recipes.js"
      );
      const recipes: Array<{
        name: string;
        commands: Array<{ executable: string; args: string[] }>;
        evaluation: "report_only" | "require_pass" | "require_fail";
        required_paths: string[];
        timeout_seconds: number;
        max_calls: number;
      }> = [
        {
          name: "a",
          commands: [{ executable: "/usr/bin/git", args: ["x"] }],
          evaluation: "report_only",
          required_paths: ["src/a.ts"],
          timeout_seconds: 30,
          max_calls: 1,
        },
        {
          name: "b",
          commands: [{ executable: "/usr/bin/git", args: ["y"] }],
          evaluation: "report_only",
          required_paths: ["src/b.ts"],
          timeout_seconds: 30,
          max_calls: 1,
        },
      ];
      const inventoryCanonical = `[${recipes.map(canonicalizeVerificationRecipe).join(",")}]`;
      const parsed = JSON.parse(inventoryCanonical);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(typeof parsed[0]).toBe("object");
      expect(typeof parsed[1]).toBe("object");
      expect(parsed[0].name).toBe("a");
      expect(parsed[1].name).toBe("b");
    });
  });

  describe("(F6/F7 HIGH) command.args is structurally required and empty-string args are allowed", () => {
    it("(F6) rejects a command missing the `args` field", () => {
      // Parse throws on unknown keys / wrong types; expectRejected accepts
      // either parse-throw or validate-error.
      expectRejected(minimalYaml([recipe({ commands: [{ executable: "/usr/bin/git" }] })]));
    });

    it("(F7) accepts a command with empty array args", () => {
      expectAccepted(
        minimalYaml([recipe({ commands: [{ executable: "/usr/bin/git", args: [] }] })]),
        1,
      );
    });

    it("(F7) accepts a command with a single empty-string arg", () => {
      expectAccepted(
        minimalYaml([recipe({ commands: [{ executable: "/usr/bin/git", args: [""] }] })]),
        1,
      );
    });
  });
});
