#!/usr/bin/env node
// Local test-only authenticated delivery endpoint. It has no external route or credential source.
import { createServer } from "node:http";
import { access, writeFile } from "node:fs/promises";
const token = process.env.PI_CONDUCTOR_EXAMPLE_TOKEN;
if (token === undefined) throw new Error("token is required");
const holdFile = process.env.PI_CONDUCTOR_EXAMPLE_HOLD_FILE;
const receivedFile = process.env.PI_CONDUCTOR_EXAMPLE_RECEIVED_FILE;
const applied = new Map();
createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    const body = request.method === "GET" ? null : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string") { response.writeHead(400); response.end(); return; }
    if (request.method === "GET") { response.end(JSON.stringify(applied.get(key) ?? { schema_version: 1, status: "not_applied", idempotency_key: key, observed_oid: null })); return; }
    if (receivedFile !== undefined) await writeFile(receivedFile, key);
    while (holdFile !== undefined) {
      try { await access(holdFile); await new Promise((resolve) => setTimeout(resolve, 5)); }
      catch { break; }
    }
    const result = { schema_version: 1, kind: "deliver_ref", repository_id: body.repository_id, remote_id: body.remote_id, target_ref: body.target_ref, reviewed_head: body.reviewed_head, prior_remote_oid: body.expected_remote_oid, remote_object_oid: body.reviewed_head, idempotency_key: key };
    const record = { schema_version: 1, status: "applied", result };
    applied.set(key, record); response.end(JSON.stringify(result));
  });
}).listen(0, "127.0.0.1", function () { process.stdout.write(`${this.address().port}\n`); });
