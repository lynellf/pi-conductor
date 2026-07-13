/**
 * Normalize pnpm audit JSON output for stable comparison.
 *
 * The raw audit output contains non-deterministic fields (timestamps, advisory
 * URLs, version ranges with caret/wildcard) that cause spurious diffs when
 * compared across runs. This script:
 *
 *   - Reads the raw JSON from stdin or a file argument.
 *   - Parses the audit report.
 *   - Extracts only the fields needed for a stable baseline comparison:
 *       - `advisories.<id>.advisory_id`
 *       - `advisories.<id>.title`
 *       - `advisories.<id>.url`
 *       - `advisories.<id>.severity`
 *       - `advisories.<id>.cwe`
 *       - `advisories.<id>.cvss`
 *       - `advisories.<id>.range`
 *       - `metadata.totalDependencies`
 *       - `metadata.dependencies`
 *   - Sorts advisories by advisory_id.
 *   - Emits a stable JSON object.
 *   - Also writes the raw exit status into the output for comparison.
 *
 * Usage:
 *   node scripts/normalize-pnpm-audit.mjs --status <code> /tmp/audit.json > normalized.json
 *   node scripts/normalize-pnpm-audit.mjs /tmp/audit.json > normalized.json
 */

import { readFileSync } from "node:fs";
import { argv, exit } from "node:process";

function normalizeAudit(raw, exitStatus) {
  const advisories = raw.advisories ?? {};
  const metadata = raw.metadata ?? {};

  // Sort advisory IDs for stable output order.
  const sortedIds = Object.keys(advisories).sort();

  const normalizedAdvisories = {};
  for (const id of sortedIds) {
    const adv = advisories[id];
    normalizedAdvisories[id] = {
      advisory_id: adv.advisory_id ?? id,
      title: adv.title ?? "",
      url: adv.url ?? "",
      severity: adv.severity ?? "unknown",
      cwe: adv.cwe ?? [],
      cvss: adv.cvss ?? {},
      range: adv.range ?? "",
    };
  }

  return {
    exitStatus,
    metadata: {
      totalDependencies: metadata.totalDependencies ?? 0,
      dependencies: metadata.dependencies ?? 0,
    },
    advisories: normalizedAdvisories,
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────

let exitStatus = 0;
let inputPath = null;

// Parse --status flag.
const args = argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--status" && i + 1 < args.length) {
    exitStatus = parseInt(args[i + 1], 10);
    if (Number.isNaN(exitStatus)) {
      console.error("normalize-pnpm-audit.mjs: --status must be an integer");
      exit(1);
    }
    i++;
  } else if (!args[i].startsWith("--")) {
    inputPath = args[i];
  }
}

let rawInput;
if (inputPath !== null) {
  rawInput = JSON.parse(readFileSync(inputPath, "utf8"));
} else {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }
  rawInput = JSON.parse(stdin);
}

const normalized = normalizeAudit(rawInput, exitStatus);
process.stdout.write(JSON.stringify(normalized, null, 2) + "\n");
