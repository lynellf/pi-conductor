#!/usr/bin/env node
// Fixed private-staging adapter for the no-model controller example.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const request = JSON.parse(readFileSync(0, "utf8"));
function preparation(value) {
  return value !== null && typeof value === "object" && value.packet === "prepared" && value.stage === "prepare";
}
function completedNativeResult(value) {
  return value !== null && typeof value === "object" &&
    value.type === "subagent_completed" && value.status === "completed" &&
    typeof value.summary === "string" && value.summary.includes("packet received");
}

let output;
if (request.action_id === "prepare") {
  if (request.input_refs.length !== 0) throw new Error("prepare accepts no inputs");
  output = { packet: "prepared", stage: "prepare" };
} else if (request.action_id === "validate") {
  const [prepared, nativeTerminal] = request.input_refs;
  if (!preparation(prepared?.value) || !completedNativeResult(nativeTerminal?.value))
    throw new Error("validator requires prepared packet and successful native terminal result");
  output = { packet: "prepared", stage: "validated", native_status: nativeTerminal.value.status };
} else {
  throw new Error("unknown fixed adapter action");
}
mkdirSync("/workspace/output", { recursive: true });
writeFileSync("/workspace/output/result.json", JSON.stringify(output));
console.log(JSON.stringify({ output: "result.json" }));
