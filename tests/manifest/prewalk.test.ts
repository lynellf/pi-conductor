import { describe, expect, it } from "vitest";

import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError, type PrewalkConfig } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

const PREWALK_YAML = `
version: 2
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: implementer
    max_visits: 2
    models: [{ model: omlx:Qwen3.8-27B-oQ4e-mtp, effort: high }]
    max_session_cost_usd: 8
    system_prompt: roles/implementer.md
    tools: [read, write, edit, bash, handoff, end]
    prewalk:
      validation_allowlist: [pnpm, node, git]
      guide:
        model: openai:gpt-5.6-terra
        effort: high
        max_cost_usd: 2.5
        max_turns: 12
      executor:
        max_turns: 60
        max_wall_clock_s: 1800
`;

const VALIDATION_CONTEXT = {
  prewalk: {
    implementer: {
      executor_context_window: 131_072,
      executor_max_tokens: 32_768,
      executor_envelope_tokens: 4_000,
      safety_margin_tokens: 8_192,
      workspace_is_git_repository: true,
    },
  },
} as const;

describe("Prewalk manifest parsing", () => {
  it("normalizes defaults and deeply freezes the opt-in config", () => {
    const role = parseManifest(PREWALK_YAML).roles[1];

    expect(role?.prewalk).toEqual({
      transfer: "native",
      on_preflight_failure: "project",
      visits: "first",
      max_todos: 12,
      executor_output_reservation: 8192,
      validation_retries: 2,
      validation_allowlist: ["pnpm", "node", "git"],
      guide: {
        model: "openai:gpt-5.6-terra",
        effort: "high",
        max_cost_usd: 2.5,
        max_turns: 12,
      },
      executor: { max_turns: 60, max_wall_clock_s: 1800 },
    });
    expect(Object.isFrozen(role?.prewalk)).toBe(true);
    expect(Object.isFrozen(role?.prewalk?.guide)).toBe(true);
    expect(Object.isFrozen(role?.prewalk?.executor)).toBe(true);
    expect(Object.isFrozen(role?.prewalk?.validation_allowlist)).toBe(true);
  });

  it("preserves every explicit transfer and budget option", () => {
    const role = parseManifest(
      PREWALK_YAML.replace(
        "validation_allowlist: [pnpm, node, git]",
        `transfer: projection
      on_preflight_failure: fail
      visits: all
      max_todos: 20
      executor_output_reservation: 4096
      validation_retries: 0
      validation_allowlist: [pnpm]`,
      ),
    ).roles[1];

    expect(role?.prewalk).toMatchObject({
      transfer: "projection",
      on_preflight_failure: "fail",
      visits: "all",
      max_todos: 20,
      executor_output_reservation: 4096,
      validation_retries: 0,
    });
  });

  it("rejects malformed prewalk enums instead of silently defaulting", () => {
    expect(() =>
      parseManifest(
        PREWALK_YAML.replace(
          "validation_allowlist:",
          "transfer: exact\n      validation_allowlist:",
        ),
      ),
    ).toThrow(ManifestParseError);
  });
});

describe("Prewalk manifest validation", () => {
  it("accepts the intended cross-vendor native configuration", () => {
    expect(validateManifest(parseManifest(PREWALK_YAML), VALIDATION_CONTEXT).errors).toEqual([]);
  });

  it.each([
    [
      "orchestrator role",
      PREWALK_YAML.replace("    prewalk:\n", "    is_orchestrator: true\n    prewalk:\n"),
      "prewalk_orchestrator_unsupported",
    ],
    [
      "executor model omission",
      PREWALK_YAML.replace(
        "    models: [{ model: omlx:Qwen3.8-27B-oQ4e-mtp, effort: high }]\n",
        "",
      ),
      "prewalk_executor_model_unresolved",
    ],
    [
      "executor fallback",
      PREWALK_YAML.replace(
        "models: [{ model: omlx:Qwen3.8-27B-oQ4e-mtp, effort: high }]",
        "models: [omlx:qwen, omlx:tiel]",
      ),
      "prewalk_executor_fallback_unsupported",
    ],
    [
      "system prompt omission",
      PREWALK_YAML.replace("    system_prompt: roles/implementer.md\n", ""),
      "prewalk_system_prompt_unresolved",
    ],
    [
      "non-shared workspace",
      PREWALK_YAML.replace(
        "    prewalk:\n",
        "    workspace: { backend: worktree }\n    prewalk:\n",
      ),
      "prewalk_workspace_unsupported",
    ],
    [
      "delegation",
      PREWALK_YAML.replace(
        "version: 2",
        `version: 2
subagents:
  - name: source-worker
    models: [openai:gpt-5.6-sol]
    max_session_cost_usd: 1
    system_prompt: roles/source-worker.md`,
      )
        .replace(
          "tools: [read, write, edit, bash, handoff, end]",
          "tools: [read, write, edit, bash, delegate, handoff, end]",
        )
        .replace(
          "    prewalk:\n",
          `    delegation:
      allowed_subagents: [source-worker]
      max_children_per_session: 1
      max_parallel: 1
    prewalk:
`,
        ),
      "prewalk_delegation_unsupported",
    ],
    [
      "guide cap not below role cap",
      PREWALK_YAML.replace("max_cost_usd: 2.5", "max_cost_usd: 8"),
      "prewalk_guide_cost_cap_invalid",
    ],
    [
      "too many TODOs",
      PREWALK_YAML.replace("validation_allowlist:", "max_todos: 21\n      validation_allowlist:"),
      "prewalk_max_todos_invalid",
    ],
    [
      "empty validation allowlist",
      PREWALK_YAML.replace("[pnpm, node, git]", "[]"),
      "prewalk_validation_allowlist_empty",
    ],
  ])("rejects %s", (_name, yaml, code) => {
    const report = validateManifest(parseManifest(yaml), VALIDATION_CONTEXT);
    expect(report.errors.map((error) => error.code)).toContain(code);
  });

  it("rejects malformed programmatic config instead of trusting TypeScript casts", () => {
    const manifest = parseManifest(PREWALK_YAML);
    const orchestrator = manifest.roles[0];
    const role = manifest.roles[1];
    if (orchestrator === undefined || role?.prewalk === undefined)
      throw new Error("fixture must contain both roles and prewalk");
    const malformed = {
      ...manifest,
      roles: [
        orchestrator,
        {
          ...role,
          prewalk: {
            ...role.prewalk,
            transfer: "guessed",
            guide: { ...role.prewalk.guide, effort: "turbo", max_turns: Number.NaN },
          } as unknown as PrewalkConfig,
        },
      ],
    };

    expect(
      validateManifest(malformed, VALIDATION_CONTEXT).errors.map((error) => error.code),
    ).toContain("prewalk_config_invalid");
  });

  it("fails closed when executor context metadata is unavailable", () => {
    const report = validateManifest(parseManifest(PREWALK_YAML));
    expect(report.errors.map((error) => error.code)).toContain("prewalk_context_metadata_unknown");
  });

  it("rejects a derived guide transcript budget at zero", () => {
    const report = validateManifest(parseManifest(PREWALK_YAML), {
      prewalk: {
        implementer: {
          executor_context_window: 13_192,
          executor_max_tokens: 32_768,
          executor_envelope_tokens: 1_000,
          safety_margin_tokens: 4_000,
          workspace_is_git_repository: true,
        },
      },
    });
    expect(report.errors.map((error) => error.code)).toContain("prewalk_budget_unsatisfiable");
  });

  it("rejects a non-Git shared workspace", () => {
    const report = validateManifest(parseManifest(PREWALK_YAML), {
      prewalk: {
        implementer: {
          ...VALIDATION_CONTEXT.prewalk.implementer,
          workspace_is_git_repository: false,
        },
      },
    });
    expect(report.errors.map((error) => error.code)).toContain("prewalk_git_repository_required");
  });
});
