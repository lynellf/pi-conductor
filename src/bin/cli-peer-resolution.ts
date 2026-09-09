/** Impure CLI-only resolution of Pi's host-provided peers; spec §12 host boundary. */
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { findPackageJSON, type ModuleHooks, registerHooks } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SDK = "@earendil-works/pi-coding-agent";
const PEERS = [SDK, "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"];
const REPAIR = "Install Pi with an on-disk SDK or set PI_PACKAGE_DIR to its package directory.";

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function validatePackage(packageJson: string): string {
  const canonical = realpathSync(packageJson);
  const metadata: unknown = JSON.parse(readFileSync(canonical, "utf8"));
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("name" in metadata) ||
    metadata.name !== SDK
  ) {
    throw new Error(`Expected ${SDK} at ${canonical}. ${REPAIR}`);
  }
  return canonical;
}

function sdkPackageJson(): string {
  const explicit = process.env.PI_PACKAGE_DIR;
  if (explicit !== undefined) {
    try {
      if (explicit.length === 0) throw new Error("directory is empty");
      return validatePackage(join(explicit, "package.json"));
    } catch (error) {
      throw new Error(
        `Invalid PI_PACKAGE_DIR: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // A normal package-manager install or checkout may already have a local SDK.
  let local: string | undefined;
  try {
    local = findPackageJSON(SDK, import.meta.url);
  } catch (error) {
    if (!hasCode(error, "ERR_MODULE_NOT_FOUND")) throw error;
  }
  if (local !== undefined) return validatePackage(local);

  // Managed Pi packages omit peers. Follow the first executable pi on PATH,
  // never execute it, and find its owning package (supports npm bin symlinks).
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const executable = join(directory, "pi");
    try {
      accessSync(executable, constants.X_OK);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].some((code) => hasCode(error, code))) continue;
      throw error;
    }
    let root = dirname(realpathSync(executable));
    while (true) {
      const candidate = join(root, "package.json");
      if (existsSync(candidate)) return validatePackage(candidate);
      const parent = dirname(root);
      if (parent === root) break;
      root = parent;
    }
    throw new Error(`Cannot locate the SDK for Pi at ${executable}. ${REPAIR}`);
  }
  throw new Error(`Cannot find ${SDK} locally or Pi on PATH. ${REPAIR}`);
}

/** Bind conductor's peer imports to one SDK tree before dynamically loading the CLI. */
export function registerCliPeerResolution(): ModuleHooks {
  const sdkAnchor = pathToFileURL(sdkPackageJson()).href;
  const runtimeRoot = new URL("../", import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        context.parentURL?.startsWith(runtimeRoot) &&
        PEERS.some((peer) => specifier === peer || specifier.startsWith(`${peer}/`))
      ) {
        // Resolve via Pi's package exports with the original import conditions.
        return nextResolve(specifier, { ...context, parentURL: sdkAnchor });
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    const entry = fileURLToPath(import.meta.resolve(SDK));
    if (!statSync(entry).isFile()) throw new Error(`SDK entrypoint is not a file: ${entry}`);
  } catch (error) {
    hooks.deregister();
    throw new Error(
      `Cannot load Pi SDK from ${fileURLToPath(sdkAnchor)}: ${error instanceof Error ? error.message : String(error)}. ${REPAIR}`,
      { cause: error },
    );
  }
  return hooks;
}
