import path from "node:path";
import { spawnSync } from "node:child_process";

/** `npm` on POSIX, `npm.cmd` on Windows — spawn without a shell needs the extension. */
export function npmCommand(platform: string = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * The npm global prefix (`npm prefix -g`), or undefined when npm cannot answer.
 * Spawning npm costs a moment, so callers use it only when they are about to
 * touch the global install.
 */
export function npmGlobalPrefix(): string | undefined {
  const result = spawnSync(npmCommand(), ["prefix", "-g"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 30_000,
  });
  if (result.status !== 0) return undefined;
  const output = (result.stdout ?? "").toString().trim();
  return output ? output.split("\n").pop()!.trim() : undefined;
}

/** Where a global install of `name` can live under an npm prefix. */
export function npmGlobalPackageDirs(prefix: string, name: string): string[] {
  const parts = name.split("/");
  return [path.join(prefix, "lib", "node_modules", ...parts), path.join(prefix, "node_modules", ...parts)];
}
