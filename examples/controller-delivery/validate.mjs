#!/usr/bin/env node
// Fixed exact-head validator. The broker supplies bytes materialized from its selected-source artifact.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(2); };
if (input?.schema_version !== 1 || typeof input.head !== "string" || !Array.isArray(input.files)) fail("invalid validation input");
const expected = "line-1\nchild-a-change\nline-3\nline-4\nline-5\nline-6\nline-7\nline-8\nline-9\nline-10\nchild-b-change\nline-12\n";
const value = input.files.find((file) => file?.path === "value.txt");
if (input.files.length !== 1 || typeof value?.bytes_b64 !== "string" ||
  Buffer.from(value.bytes_b64, "base64").toString("utf8") !== expected
) fail("selected source policy rejected");
process.stdout.write(`${JSON.stringify({ schema_version: 1, subject_head: input.head, verdict: "approved" })}\n`);
