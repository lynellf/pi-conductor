#!/usr/bin/env node
// A fixed, operator-reviewed example provider for a Forge-style pull-request API.
// The broker controls stdin; the operator fixes this program and the origin argv in its grant.

const forgeOrigin = process.argv[2];
if (typeof forgeOrigin !== "string") throw new Error("the Forge origin must be fixed in argv");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", async () => {
  const invocation = JSON.parse(input);
  const request = invocation.request;
  if (!invocation.scope.allowed_network_origins.includes(forgeOrigin))
    throw new Error("the fixed Forge origin is outside the host-authorized network scope");
  const credential = invocation.credentials.find((entry) => entry.source_id === "forge_token");
  if (credential === undefined) throw new Error("the fixed Forge credential is unavailable");

  const api = async (method, path, body) => {
    const response = await fetch(new URL(path, forgeOrigin), {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${credential.value}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`Forge request failed: ${response.status}`);
    return value;
  };
  const prPath = `/v1/pull-requests/${encodeURIComponent(request.payload.pr_key)}`;
  const observation = (pr) => ({
    schema_version: 1,
    kind: "local_program",
    repository_id: request.repository_id,
    operation: request.operation,
    source_ref: request.source_ref,
    target_ref: request.target_ref,
    reviewed_head: request.reviewed_head,
    payload: {
      stage: pr === null ? "missing" : pr.stage,
      pull_request_id: pr === null ? null : pr.id,
      head: pr === null ? null : pr.head,
      merged: pr === null ? false : pr.merged,
    },
  });
  const outcome = (status, fields) =>
    process.stdout.write(
      JSON.stringify({
        protocol_version: 1,
        operation_id: invocation.operation_id,
        invocation_id: invocation.invocation_id,
        implementation_id: invocation.implementation_id,
        implementation_digest: invocation.implementation_digest,
        authority_digest: invocation.authority_digest,
        request_digest: invocation.request_digest,
        status,
        ...fields,
      }),
    );
  const read = async () => {
    const response = await fetch(new URL(prPath, forgeOrigin), {
      redirect: "error",
      headers: { authorization: `Bearer ${credential.value}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Forge read failed: ${response.status}`);
    return response.json();
  };
  const inspectWrite = async () => {
    const pr = await read();
    const result = observation(pr);
    if (
      pr !== null &&
      pr.head === request.reviewed_head &&
      pr.target_ref === request.target_ref
    )
      return outcome("applied", { result });
    return outcome("not_applied", { diagnostic_code: "forge_postcondition_absent", observation: result });
  };

  if (request.operation === "publish_reviewed" || request.operation === "publish_crash_after_remote") {
    if (invocation.command === "inspect") return inspectWrite();
    const pr = await api("POST", "/v1/pull-requests", {
      key: request.payload.pr_key,
      head: request.reviewed_head,
      target_ref: request.target_ref,
    });
    if (pr.head !== request.reviewed_head || pr.target_ref !== request.target_ref)
      throw new Error("Forge publish response does not prove the requested reviewed head");
    if (request.operation === "publish_crash_after_remote") process.exit(97);
    return outcome("applied", { result: observation(pr) });
  }

  if (request.operation === "observe_ci") {
    const pr = await read();
    const result = observation(pr);
    if (pr === null)
      return outcome("not_applied", { diagnostic_code: "forge_pull_request_missing", observation: result });
    // A pending CI result is a complete observation, not uncertainty about a write.
    return outcome("applied", { result });
  }

  if (request.operation === "request_merge") {
    if (invocation.command === "inspect") {
      const pr = await read();
      const result = observation(pr);
      return pr !== null && pr.merged && pr.head === request.reviewed_head
        ? outcome("applied", { result })
        : outcome("not_applied", { diagnostic_code: "forge_merge_not_observed", observation: result });
    }
    const pr = await read();
    const result = observation(pr);
    if (
      pr === null ||
      pr.head !== request.reviewed_head ||
      pr.target_ref !== request.target_ref ||
      pr.stage !== "passed"
    )
      return outcome("not_applied", { diagnostic_code: "forge_merge_precondition_failed", observation: result });
    const merged = await api("POST", `${prPath}/merge`, { expected_head: request.reviewed_head });
    if (
      merged.head !== request.reviewed_head ||
      merged.target_ref !== request.target_ref ||
      merged.merged !== true
    )
      throw new Error("Forge merge response does not prove the requested postcondition");
    const verified = await read();
    if (
      verified === null ||
      verified.head !== request.reviewed_head ||
      verified.target_ref !== request.target_ref ||
      verified.merged !== true
    )
      throw new Error("Forge merge verification does not prove the requested postcondition");
    return outcome("applied", { result: observation(verified) });
  }
  throw new Error("unregistered local provider operation");
});
