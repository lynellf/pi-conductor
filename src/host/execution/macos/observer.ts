/** Bounded asynchronous Darwin observation, including packed peer-only layouts (#165). */
import { execFile } from "node:child_process";
import {
  type MacObservation,
  nativeObservationFailure,
  parseMacObservation,
} from "./observer-protocol.js";
import { prepareMacObserver } from "./observer-runtime.js";

export type { MacObservation, MacProcessObservation } from "./observer-protocol.js";
export { parseMacObservation } from "./observer-protocol.js";

type Mode = "snapshot" | "scan" | "observe";
function invoke(file: string, mode: Mode, token: string, pid?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [mode, ...(pid === undefined ? [] : [String(pid)])],
      {
        timeout: 2_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
      },
      (error, stdout, stderr) => {
        if (error !== null) reject(nativeObservationFailure(stderr));
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(token);
  });
}

/** Observe without signaling or argv markers; retry one explicit native identity race, never unknown ownership. */
export async function observeMacProcesses(
  mode: Mode,
  token = "",
  pid?: number,
): Promise<MacObservation> {
  if (
    Buffer.byteLength(token) > 1024 ||
    token.includes("\0") ||
    (mode === "observe" &&
      (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647))
  )
    throw Object.assign(new Error("invalid native observation request"), { code: "EINVAL" });
  const file = prepareMacObserver();
  for (let attempt = 0; ; attempt++) {
    try {
      const output = await invoke(file, mode, token, pid);
      const value: unknown = JSON.parse(output);
      return parseMacObservation(value);
    } catch (error) {
      if (attempt === 0 && (error as NodeJS.ErrnoException).code === "EAGAIN") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      if (error instanceof SyntaxError) throw nativeObservationFailure(undefined);
      throw error;
    }
  }
}
