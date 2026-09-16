/** Durable runtime capture and inert capability probing for executable hosts. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  runVerifiedSandboxCapabilityProbe,
  SandboxCapabilityProbeError,
} from "../execution/sandbox/probe-runner.js";
import { ToolExecutionError } from "../execution/tool-execution-controller.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";
import type { CreateExecutableControllerHostOptions } from "./executable-host-contract.js";
import type { ControllerRuntimeStore } from "./runtime-store.js";

export function createRuntimePreparation(input: {
  readonly options: Readonly<CreateExecutableControllerHostOptions>;
  readonly runtimeStore: ControllerRuntimeStore;
  readonly currentDefinition: () => Promise<ApprovedControllerDefinition>;
}) {
  const pending = new Map<string, Promise<void>>();
  return (
    runtimeId: string,
    capability: "read_only" | "private_staging",
    signal?: AbortSignal,
  ): Promise<void> => {
    const key = `${runtimeId}:${capability}`;
    const prior = pending.get(key);
    if (prior !== undefined) return prior;
    const origin = {
      kind: "controller_operation" as const,
      controller_id: input.options.approvedDefinition.record.controller_id,
      definition_digest: input.options.approvedDefinition.record.definition_digest,
      activation_id: input.options.activationId,
      owner_epoch: input.options.ownerEpoch,
      operation_id: randomUUID(),
      operation_kind: "preparation" as const,
      action_id: null,
      request_sha256: digest(`preparation:${runtimeId}:${capability}`),
    };
    const work = input.options.toolExecutionController.runController(
      origin,
      async (scope) => {
        const fence = () => {
          scope.assertOpen();
          input.options.assertOpen();
        };
        fence();
        await input.currentDefinition();
        const runtime = await input.runtimeStore.prepare(runtimeId, fence);
        fence();
        await mkdir(join(input.options.runStateDir, "controller-probes"), {
          recursive: true,
          mode: 0o700,
        });
        await runVerifiedSandboxCapabilityProbe({
          binaryPath: input.options.sandboxHostApproval.binaryPath,
          approvedBuilds: input.options.sandboxHostApproval.approvedBuilds,
          ...(input.options.sandboxHostApproval.getcapPath === undefined
            ? {}
            : { getcapPath: input.options.sandboxHostApproval.getcapPath }),
          probeApproval: input.options.sandboxHostApproval.probeApproval,
          loadVerifiedContext: async () => {
            fence();
            const definition = await input.currentDefinition();
            const verified = await input.runtimeStore.verify(runtimeId, runtime);
            const registration = definition.approval.runtimes.find(
              (entry) => entry.runtime_id === runtimeId,
            );
            if (registration === undefined) throw new Error("controller probe runtime was revoked");
            return {
              runtime: verified,
              writableRoots:
                capability === "private_staging"
                  ? [{ path: "output", kind: "directory" as const }]
                  : [],
              environment: {},
              artifactParent: join(input.options.runStateDir, "controller-probes"),
              owner: {
                kind: "controller_operation" as const,
                origin,
                runtime: {
                  runtime_id: runtimeId,
                  approval_id: input.options.sandboxHostApproval.probeApproval.approvalId,
                  runtime_digest: registration.inventory_sha256,
                  executable_digest: input.options.sandboxHostApproval.probeApproval.sha256,
                  capability_digest: digest(`preparation:${runtimeId}:${capability}`),
                },
              },
            };
          },
          signal: scope.signal,
          assertOpen: fence,
        }).catch((cause) => {
          if (cause instanceof SandboxCapabilityProbeError && cause.cleanup === "confirmed")
            throw cause;
          throw new ToolExecutionError(
            "tool_cleanup_unconfirmed",
            "controller capability probe failed; cleanup is unconfirmed",
            { cleanup: "unconfirmed", executionId: scope.executionId, cause },
          );
        });
        fence();
      },
      signal === undefined ? {} : { signal },
    );
    pending.set(key, work);
    void work.catch(() => undefined);
    return work;
  };
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
