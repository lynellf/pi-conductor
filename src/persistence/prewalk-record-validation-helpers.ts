/** Shared strict field validators for Prewalk persistence records. */

import type { ModelEffort, UsageRecord } from "../core/types.js";

/** Typed rejection of a malformed or semantically inconsistent Prewalk record. */
export class PrewalkRecordError extends Error {
  constructor(message: string) {
    super(`invalid Prewalk record: ${message}`);
    this.name = "PrewalkRecordError";
  }
}

export function usage(value: unknown, path: string): asserts value is UsageRecord {
  const record = object(value, path);
  exactKeys(record, ["input", "output", "cache_read", "cache_write", "tokens", "cost"]);
  for (const name of ["input", "output", "cache_read", "cache_write", "tokens", "cost"]) {
    nonNegative(record[name], `${path}.${name}`);
  }
}

export function gitCheckpoint(value: unknown, exemplarNullable: boolean): void {
  const record = object(value, "git_checkpoint");
  exactKeys(record, ["base_sha", "exemplar_sha"]);
  gitSha(record.base_sha, "git_checkpoint.base_sha");
  if (exemplarNullable && record.exemplar_sha === null) return;
  gitSha(record.exemplar_sha, "git_checkpoint.exemplar_sha");
}

export function conversation(value: unknown, path: string): void {
  const record = object(value, path);
  exactKeys(record, ["id", "file"]);
  nonEmpty(record.id, `${path}.id`);
  nonEmpty(record.file, `${path}.file`);
}

export function stringList(
  value: unknown,
  path: string,
  nonEmptyList = false,
  unique = false,
): void {
  if (!Array.isArray(value) || (nonEmptyList && value.length === 0))
    fail(`${path} must be an array${nonEmptyList ? " with at least one item" : ""}`);
  for (const [index, item] of value.entries()) nonEmpty(item, `${path}[${index}]`);
  if (unique && new Set(value).size !== value.length) fail(`${path} must not contain duplicates`);
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) fail(`unknown field '${unknown}'`);
}

export function effort(value: unknown, path: string): asserts value is ModelEffort {
  oneOf(value, ["off", "minimal", "low", "medium", "high", "xhigh", "max"], path);
}

export function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${path} must be an object`);
  return value as Record<string, unknown>;
}

export function oneOf<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T))
    fail(`${path} has an unsupported value`);
  return value as T;
}

export function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(`${path} must be a non-empty string`);
}

export function nonNegative(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    fail(`${path} must be finite and non-negative`);
}

export function positive(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    fail(`${path} must be finite and positive`);
}

export function integer(value: unknown, path: string): asserts value is number {
  nonNegative(value, path);
  if (!Number.isInteger(value)) fail(`${path} must be an integer`);
}

export function number(value: unknown): number {
  return value as number;
}

export function sha256(value: unknown, path: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    fail(`${path} must be a lowercase SHA-256`);
}

export function absent(value: unknown, path: string): void {
  if (value !== undefined) fail(`${path} is not valid for this transfer mode or outcome`);
}

export function fail(message: string): never {
  throw new PrewalkRecordError(message);
}

function gitSha(value: unknown, path: string): void {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))
    fail(`${path} must be a Git object ID`);
}
