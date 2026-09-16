#!/usr/bin/env node
// Fixed review adapter for the issue #116 example. It approves only this closed evidence shape.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};
if (input?.schema_version !== 1 || typeof input.reviewed_head !== "string") fail("invalid review input");
if (typeof input.report_b64 !== "string" || typeof input.patch_b64 !== "string") fail("missing sealed outputs");
const report = Buffer.from(input.report_b64, "base64");
const patch = Buffer.from(input.patch_b64, "base64");
if (report.toString("utf8") !== "review: approved\n") fail("report policy rejected");
if (!patch.toString("utf8").startsWith("diff --git ")) fail("patch policy rejected");
const subjectDigest = createHash("sha256").update(patch).digest("hex");
process.stdout.write(
  `${JSON.stringify({
    schema_version: 1,
    subject_digest: subjectDigest,
    verdict: "approved",
  })}\n`,
);
