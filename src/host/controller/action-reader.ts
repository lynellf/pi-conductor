/** Bounded controller read and legacy reference resolution — issue #115/116. */

import type { ControllerActivationStartedRecord } from "../../persistence/controller-records.js";
import type { reconstructControllerTimeline } from "../../persistence/log.js";
import type {
  ControllerReadResult,
  CreateControllerActionDispatcherOptions,
} from "./action-dispatcher-contract.js";
import { findControllerRef, parseStrictJson } from "./action-dispatcher-query.js";
import { controllerRefNamespace, parseControllerRef } from "./controller-refs.js";

const MAX_READ_BYTES = 32 * 1024;

/** Apply the same bounded range contract before every record or output read. */
export function assertControllerReadRange(offset: number, limit: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_READ_BYTES
  )
    throw new Error("controller read range is invalid");
}

/** Create bounded host reads without granting raw filesystem access. */
export function createControllerActionReader(options: {
  readonly dispatcher: CreateControllerActionDispatcherOptions;
  readonly identity: ControllerActivationStartedRecord;
  readonly timeline: () => ReturnType<typeof reconstructControllerTimeline>;
}): {
  readonly read: (ref: string, offset?: number, limit?: number) => Promise<ControllerReadResult>;
  readonly resolveLegacyRef: (ref: string) => Promise<unknown>;
} {
  const read = async (
    ref: string,
    offset = 0,
    limit = MAX_READ_BYTES,
  ): Promise<ControllerReadResult> => {
    assertControllerReadRange(offset, limit);
    if (ref.startsWith("source-workspace/v1/")) {
      if (options.dispatcher.sources === undefined)
        throw new Error("source workspaces are not configured");
      const source = await options.dispatcher.sources.resolve(ref, { kind: "controller" });
      const bytes = Buffer.from(JSON.stringify(source.descriptor), "utf8");
      if (offset > bytes.length) throw new Error("controller read range is invalid");
      const page = bytes.subarray(offset, offset + limit);
      return {
        kind: "record",
        value: {
          encoding: "base64",
          data: page.toString("base64"),
          offset,
          next_offset: offset + page.length,
          total_bytes: bytes.length,
          eof: offset + page.length === bytes.length,
        },
      };
    }
    if (ref.startsWith("artifact/v1/")) {
      return {
        kind: "artifact",
        value: await options.dispatcher.artifacts.rangeReadForController({
          ref,
          runId: options.identity.run_id,
          definitionDigest: options.identity.definition_digest,
          offset,
          length: limit,
        }),
      };
    }
    const parsed = parseControllerRef(ref);
    if (parsed.namespace !== controllerRefNamespace(options.identity))
      throw new Error("controller ref is outside active namespace");
    const value = findControllerRef(
      parsed.kind,
      parsed.digest,
      options.timeline(),
      options.dispatcher.admission,
      options.dispatcher.readRecords(),
      options.identity.run_id,
    );
    if (value === undefined) throw new Error("controller ref is unavailable");
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    if (offset > bytes.byteLength) throw new Error("controller read range is invalid");
    const page = bytes.subarray(offset, offset + Math.min(limit, bytes.byteLength - offset));
    return {
      kind: parsed.kind,
      value: {
        encoding: "base64",
        data: page.toString("base64"),
        offset,
        next_offset: offset + page.byteLength,
        total_bytes: bytes.byteLength,
        eof: offset + page.byteLength === bytes.byteLength,
      },
    };
  };
  return Object.freeze({
    read,
    async resolveLegacyRef(ref: string): Promise<unknown> {
      if (!ref.startsWith("artifact/v1/")) {
        const first = await read(ref);
        if (first.kind === "artifact") throw new Error("unexpected artifact resolver result");
        if (!first.value.eof)
          throw new Error("controller reference exceeds bounded resolver limit");
        return parseStrictJson(Buffer.from(first.value.data, "base64"));
      }
      const chunks: Buffer[] = [];
      let offset = 0;
      let total: number | undefined;
      while (true) {
        const page = await read(ref, offset);
        if (page.kind !== "artifact")
          throw new Error("artifact reference resolved to non-artifact");
        if (total === undefined) total = page.value.byteLength;
        if (page.value.byteLength !== total || page.value.bytes.byteLength > MAX_READ_BYTES)
          throw new Error("artifact range binding changed during resolution");
        chunks.push(page.value.bytes);
        offset += page.value.bytes.byteLength;
        if (offset === total) break;
        if (page.value.bytes.byteLength === 0 || total > 1024 * 1024)
          throw new Error("artifact cannot be fully resolved within bounds");
      }
      return parseStrictJson(Buffer.concat(chunks));
    },
  });
}
