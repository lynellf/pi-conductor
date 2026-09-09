import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Run outside Vitest's module resolver: ordinary imports do not exercise Pi's
// Jiti aliases, which broke all command registration in 0.21.0 (issue #94).
it("registers conductor through Pi's real extension loader without credentials", () => {
  const temporary = mkdtempSync(join(tmpdir(), "conductor-extension-load-"));
  const extension = fileURLToPath(new URL("../extensions/conduct.ts", import.meta.url));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const loader = new URL("core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
      const { loadExtensions } = await import(loader.href);
      const result = await loadExtensions([${JSON.stringify(extension)}], ${JSON.stringify(temporary)});
      if (result.errors.length) throw new Error(JSON.stringify(result.errors));
      console.log(JSON.stringify(result.extensions.flatMap(extension => [...extension.commands.keys()])));
    `,
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, PI_CODING_AGENT_DIR: temporary },
      },
    );
    expect(JSON.parse(output)).toEqual(
      expect.arrayContaining([
        "conduct",
        "conduct:resume",
        "conduct:list",
        "conduct:abort",
        "conduct:steer",
        "conduct:followup",
        "conduct:copy",
      ]),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 35_000);
