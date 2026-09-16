import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** Rejects controller-log writes whose durable ownership evidence is unsafe. */
export class ControllerLogAppendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ControllerLogAppendError";
  }
}

/** Append a controller record only after the full line and filesystem metadata are verified. */
export function appendControllerLogRecord(filePath: string, json: string): void {
  const existed = existsSync(filePath);
  const descriptor = openControllerLog(filePath);
  try {
    assertPrivateRegularFile(descriptor, filePath);
    const current = readFileSync(descriptor);
    if (current.length > 0 && current[current.length - 1] !== 10) {
      throw new ControllerLogAppendError(
        "controller log has a torn trailing record; repair is required before append",
      );
    }
    writeAll(descriptor, Buffer.from(`${json}\n`, "utf8"));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (!existed) syncParentDirectory(filePath);
}

function openControllerLog(filePath: string): number {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  try {
    return openSync(
      filePath,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | noFollow,
      0o600,
    );
  } catch (cause) {
    throw new ControllerLogAppendError("could not open controller log without following links", {
      cause,
    });
  }
}

function assertPrivateRegularFile(descriptor: number, filePath: string): void {
  const stat = fstatSync(descriptor);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid) {
    throw new ControllerLogAppendError(
      "controller log must be a single-link regular file owned by this user",
    );
  }
  try {
    fchmodSync(descriptor, 0o600);
  } catch (cause) {
    throw new ControllerLogAppendError("controller log permissions could not be made private", {
      cause,
    });
  }
  if ((fstatSync(descriptor).mode & 0o777) !== 0o600) {
    throw new ControllerLogAppendError(`controller log '${filePath}' is not private`);
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new ControllerLogAppendError("controller log append made no progress");
    offset += written;
  }
}

function syncParentDirectory(filePath: string): void {
  const descriptor = openSync(dirname(filePath), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
