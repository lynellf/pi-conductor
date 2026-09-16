/** Fixed-argv launch and verified retained-output retrieval for controller programs. */
import { readSandboxExecutionOutput } from "../execution/sandbox/output-retrieval.js";
import { createControllerCommandRunner } from "./controller-command-runner.js";
import type { Authority, ProgramInvocation, ProgramResult } from "./executable-host-contract.js";
import { prepareControllerInvocationFiles } from "./invocation-files.js";

const MAX_STDOUT = 1024 * 1024,
  MAX_STDERR = 4 * 1024,
  CHUNK = 64 * 1024;
export async function runControllerProgram(invocation: ProgramInvocation): Promise<ProgramResult> {
  let staging: ProgramResult["staging"];
  const owner = ownerFor(invocation.origin, invocation.runtimeId, invocation.authority);
  const runner = createControllerCommandRunner({
    binaryPath: invocation.options.sandboxHostApproval.binaryPath,
    approvedBuilds: invocation.options.sandboxHostApproval.approvedBuilds,
    ...(invocation.options.sandboxHostApproval.getcapPath === undefined
      ? {}
      : { getcapPath: invocation.options.sandboxHostApproval.getcapPath }),
    runStateDir: invocation.options.runStateDir,
    executable: invocation.executable,
    argv: invocation.argv,
    request: invocation.request,
    loadVerifiedContext: async (scope) => {
      const fence = () => {
        scope.assertOpen();
        invocation.options.assertOpen();
      };
      fence();
      const definition = await invocation.currentDefinition();
      const runtime = await invocation.runtimeStore.prepare(invocation.runtimeId, fence);
      const verified = await invocation.runtimeStore.verify(invocation.runtimeId, runtime);
      assertExecutable(verified, invocation.authority.executable_digest, invocation.executable);
      if (invocation.needsStaging)
        staging = await invocation.options.artifactStore.createStaging(
          invocation.origin.action_id ?? "adapter-output",
        );
      fence();
      const files = await prepareControllerInvocationFiles(
        invocation.options.runStateDir,
        fence,
        staging?.directory,
      );
      await files.verify();
      fence();
      assertExactProgram(definition, invocation);
      return {
        runtime: verified,
        readonlyWorkspaceRoot: files.readonlyWorkspaceRoot,
        privateWritableRoot: files.privateWritableRoot,
        bootstrapPath: files.bootstrapPath,
        owner,
        writableMounts: invocation.capability === "private_staging" ? files.writableMounts : [],
        environment: {},
        runId: definition.record.run_id,
        outputCaps: { maxBytes: MAX_STDOUT + MAX_STDERR, previewBytes: 0 },
      };
    },
  });
  const result = await invocation.options.toolExecutionController.runControllerLifecycle(
    invocation.origin,
    owner,
    runner,
    {
      ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
      ...(invocation.origin.operation_kind === "planner"
        ? {
            modelTimeoutSeconds:
              (await invocation.currentDefinition()).config.limits?.planner_deadline_seconds ?? 30,
          }
        : {}),
    },
  );
  if (
    result.normalizedStatus !== 0 ||
    result.output.capture !== "complete" ||
    result.output.stderr.byteCount > MAX_STDERR
  )
    throw new Error("controller executable status or diagnostics are invalid");
  return Object.freeze({
    stdout: await stdout(
      invocation.options.runStateDir,
      invocation.options.approvedDefinition.record.run_id,
      result.executionId,
      result.output.outputRef,
      invocation.origin,
    ),
    ...(staging === undefined ? {} : { staging }),
  });
}
function ownerFor(origin: ProgramInvocation["origin"], runtimeId: string, authority: Authority) {
  return {
    kind: "controller_operation" as const,
    origin,
    runtime: {
      runtime_id: runtimeId,
      approval_id: authority.approval_id,
      runtime_digest: authority.runtime_digest,
      executable_digest: authority.executable_digest,
      capability_digest: authority.capability_digest,
    },
  };
}
function assertExecutable(
  runtime: {
    readonly inventory: readonly {
      readonly path: string;
      readonly type: string;
      readonly executableMode?: number;
      readonly sha256?: string;
    }[];
  },
  digest: string,
  executable: string,
): void {
  const item = runtime.inventory.find((entry) => entry.path === executable.slice(1));
  if (
    item?.type !== "file" ||
    item.sha256 !== digest ||
    item.executableMode === undefined ||
    (item.executableMode & 0o100) === 0
  )
    throw new Error("controller executable is not an approved owner-executable runtime file");
}
function assertExactProgram(
  definition: Awaited<ReturnType<ProgramInvocation["currentDefinition"]>>,
  input: ProgramInvocation,
): void {
  const same = (runtimeId: string, executable: string, argv: readonly string[]) =>
    runtimeId === input.runtimeId &&
    executable === input.executable &&
    JSON.stringify(argv) === JSON.stringify(input.argv);
  const authority = (value: Authority) =>
    value.registration_id === input.authority.registration_id &&
    value.approval_id === input.authority.approval_id &&
    value.runtime_digest === input.authority.runtime_digest &&
    value.executable_digest === input.authority.executable_digest &&
    value.capability_digest === input.authority.capability_digest;
  if (
    input.capability === "read_only" &&
    same(definition.config.runtime_id, definition.config.executable, definition.config.argv) &&
    authority(definition.record.controller_authority)
  )
    return;
  const adapter = definition.config.adapters.find(
    (entry) =>
      entry.capability === input.capability && same(entry.runtime_id, entry.executable, entry.argv),
  );
  const found =
    adapter === undefined
      ? undefined
      : definition.record.adapter_authorities.find((entry) => entry.adapter_id === adapter.id);
  if (found === undefined || !authority(found))
    throw new Error("controller executable authority changed during launch");
}
async function stdout(
  runStateDir: string,
  runId: string,
  executionId: string,
  outputRef: string,
  origin: ProgramInvocation["origin"],
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0,
    total = 0;
  for (;;) {
    const part = await readSandboxExecutionOutput({
      runStateDir,
      expectedRunId: runId,
      expectedExecutionId: executionId,
      expectedControllerOrigin: origin,
      outputRef,
      stream: "stdout",
      offset,
      maxBytes: CHUNK,
    });
    if (part.capture !== "complete" || part.retainedByteCount > MAX_STDOUT)
      throw new Error("controller stdout is incomplete or exceeds 1 MiB");
    const bytes = Buffer.from(part.data, part.encoding);
    total += bytes.length;
    if (total > MAX_STDOUT || bytes.length !== part.byteCount)
      throw new Error("controller stdout exceeds its protocol bound");
    chunks.push(bytes);
    if (part.eof) return Buffer.concat(chunks, total);
    if (part.nextOffset <= offset) throw new Error("controller stdout read made no progress");
    offset = part.nextOffset;
  }
}
