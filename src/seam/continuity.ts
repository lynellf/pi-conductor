/**
 * Durable continuity packet TypeBox schemas — durable-continuity spec §6.
 *
 * One TypeBox schema is the single source of truth for packet shape at
 * the seam (handoff + report_result), in the derived TypeScript types,
 * and in the materializer (§11). No handwritten parallel validator is
 * permitted; the seam contract comes from this module.
 *
 * Bounds enforced here (spec §6.1):
 *   - serialized packet: ≤ 32 KiB UTF-8 (measured after validation)
 *   - summary: 1–2,048 characters
 *   - each collection: ≤ 32 entries
 *   - each item statement/question/action: 1–2,048 characters
 *   - each item has 0–8 evidence references
 *   - each supersedes collection: ≤ 8 item IDs
 *   - okf_candidate_ids: ≤ 16 unique IDs
 *   - all IDs: 1–96 chars matching `[A-Za-z][A-Za-z0-9._:-]*` (must start with a letter)
 *   - repository evidence paths: relative paths only — no leading `/`,
 *     no `..` segments, no backslashes, no `.git` segments, no empty
 *     components (spec §7)
 *
 * Byte-budget enforcement (32 KiB) is performed by `normalizeAndMeasurePacket`
 * in `src/persistence/continuity.ts` because TypeBox does not measure
 * serialized UTF-8 byte length. Structural rules that fit a TypeBox
 * constraint live here.
 */

import { type Static, Type } from "typebox";

// IDs must start with a letter so a leading digit cannot be smuggled in
// (the schema rejects `0bad` etc.). 96-char ceiling is enforced via
// maxLength and the pattern.
const idPattern = "^[A-Za-z][A-Za-z0-9._:-]{0,95}$";
const idSchema = Type.String({ minLength: 1, maxLength: 96, pattern: idPattern });

// Repository paths: relative, no traversal, no `.git` segments, no empty
// components, no backslashes, no leading dot. The first character of each
// segment is alphanumeric; later chars may include `.` and `_` and `-`.
const pathPattern = "^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$";
const repositoryPathSchema = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: pathPattern,
});

const MAX_COLLECTION_ITEMS = 32;
const MAX_ITEM_TEXT_LENGTH = 2_048;
const MAX_SUMMARY_LENGTH = 2_048;
const MAX_EVIDENCE_REFS_PER_ITEM = 8;
const MAX_SUPERSEDES_PER_ITEM = 8;
const MAX_OKF_CANDIDATES = 16;

// ─── Evidence references (spec §7) ────────────────────────────────────

const sha256Hex = Type.String({ pattern: "^[a-f0-9]{64}$" });
const commitOid = Type.String({
  minLength: 40,
  maxLength: 40,
  pattern: "^[0-9a-f]{40}$",
});

const toolExecutionEvidence = Type.Object(
  {
    kind: Type.Literal("tool_execution"),
    execution_id: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

const contextArtifactEvidence = Type.Object(
  {
    kind: Type.Literal("context_artifact"),
    artifact_id: Type.String({ minLength: 1, maxLength: 64 }),
    sha256: sha256Hex,
  },
  { additionalProperties: false },
);

const repositoryEvidence = Type.Object(
  {
    kind: Type.Literal("repository"),
    path: repositoryPathSchema,
    commit: commitOid,
    sha256: Type.Optional(sha256Hex),
    line_start: Type.Optional(Type.Integer({ minimum: 1 })),
    line_end: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const externalEvidence = Type.Object(
  {
    kind: Type.Literal("external"),
    url: Type.String({ minLength: 8, maxLength: 2_048, pattern: "^https:" }),
    title: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);

/** Closed union of v1 evidence variants (spec §7). */
export const evidenceRefSchema = Type.Union(
  [toolExecutionEvidence, contextArtifactEvidence, repositoryEvidence, externalEvidence],
  { description: "Closed union of evidence reference variants (spec §7)." },
);

/** Typed view of one evidence reference. */
export type EvidenceRef = Static<typeof evidenceRefSchema>;

// ─── Continuity packet items (spec §6.2–§6.4) ──────────────────────────

const supersedesField = Type.Array(idSchema, {
  maxItems: MAX_SUPERSEDES_PER_ITEM,
  description: "Earlier item IDs superseded by this one. Order is preserved.",
});

const evidenceField = Type.Array(evidenceRefSchema, {
  maxItems: MAX_EVIDENCE_REFS_PER_ITEM,
  description: "Evidence backing this item (0–8 references).",
});

export const continuityFindingSchema = Type.Object(
  {
    id: idSchema,
    kind: Type.Union([
      Type.Literal("fact"),
      Type.Literal("decision"),
      Type.Literal("negative_result"),
      Type.Literal("risk"),
    ]),
    confidence: Type.Union([
      Type.Literal("observed"),
      Type.Literal("verified"),
      Type.Literal("inferred"),
    ]),
    statement: Type.String({ minLength: 1, maxLength: MAX_ITEM_TEXT_LENGTH }),
    evidence: evidenceField,
    supersedes: supersedesField,
  },
  { additionalProperties: false },
);

export const continuityEvaluationSchema = Type.Object(
  {
    id: idSchema,
    label: Type.String({ minLength: 1, maxLength: MAX_ITEM_TEXT_LENGTH }),
    execution_id: Type.String({ minLength: 1, maxLength: 128 }),
    supersedes: supersedesField,
  },
  { additionalProperties: false },
);

export const continuityQuestionSchema = Type.Object(
  {
    id: idSchema,
    question: Type.String({ minLength: 1, maxLength: MAX_ITEM_TEXT_LENGTH }),
    blocking: Type.Boolean(),
    evidence: evidenceField,
    supersedes: supersedesField,
  },
  { additionalProperties: false },
);

export const continuityNextStepSchema = Type.Object(
  {
    id: idSchema,
    action: Type.String({ minLength: 1, maxLength: MAX_ITEM_TEXT_LENGTH }),
    owner: Type.Union([
      Type.Literal("parent"),
      Type.Literal("recipient"),
      Type.Literal("reviewer"),
      Type.Literal("operator"),
    ]),
    evidence: evidenceField,
    supersedes: supersedesField,
  },
  { additionalProperties: false },
);

export const continuityPacketV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_LENGTH }),
    findings: Type.Array(continuityFindingSchema, { maxItems: MAX_COLLECTION_ITEMS }),
    evaluations: Type.Array(continuityEvaluationSchema, { maxItems: MAX_COLLECTION_ITEMS }),
    open_questions: Type.Array(continuityQuestionSchema, { maxItems: MAX_COLLECTION_ITEMS }),
    next_steps: Type.Array(continuityNextStepSchema, { maxItems: MAX_COLLECTION_ITEMS }),
    okf_candidate_ids: Type.Array(idSchema, {
      maxItems: MAX_OKF_CANDIDATES,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

/** Typed view of a v1 continuity packet. */
export type ContinuityPacketV1 = Static<typeof continuityPacketV1Schema>;

/** Typed views of the individual item types. */
export type ContinuityFinding = Static<typeof continuityFindingSchema>;
export type ContinuityEvaluation = Static<typeof continuityEvaluationSchema>;
export type ContinuityQuestion = Static<typeof continuityQuestionSchema>;
export type ContinuityNextStep = Static<typeof continuityNextStepSchema>;

/** Schema constants surfaced for downstream bound checks. */
export const CONTINUITY_CONSTRAINTS = Object.freeze({
  MAX_PACKET_BYTES: 32 * 1024,
  MAX_SUMMARY_LENGTH,
  MAX_COLLECTION_ITEMS,
  MAX_ITEM_TEXT_LENGTH,
  MAX_EVIDENCE_REFS_PER_ITEM,
  MAX_SUPERSEDES_PER_ITEM,
  MAX_OKF_CANDIDATES,
  ID_PATTERN: idPattern,
  PATH_PATTERN: pathPattern,
});
