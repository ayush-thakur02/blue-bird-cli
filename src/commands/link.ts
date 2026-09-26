import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileExists, readJsonSync } from "../util/paths.ts";
import { npmGlobalPrefix } from "../util/npm.ts";
import { BlueBirdError } from "../util/errors.ts";
import { CLI_NAME, VERSION } from "../version.ts";
import { accent, bold, dim } from "../cli/prompt.ts";

export interface LinkCommandOptions {
  action: "link" | "unlink";
  json?: boolean;
  /** Where npm should resolve the package from. Defaults to this file's package. */
  packageRoot?: string;
}

/** The short command name, reported first when several are linked. */
export const PRIMARY_BIN = "bb";

export interface LinkResult {
  packageRoot: string;
  packageName: string;
  version: string;
  prefix?: string;
  binDir?: string;
  /** Bin names that resolve in the global bin directory after linking. */
  linked: string[];
  /** Version reported by running a linked binary, when one could be run. */
  reported?: string;
  ok: boolean;
  detail: string;
}

interface PackageManifest {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
}

/** Package root of the running copy: the nearest directory above this file with a package.json. */
export function packageRootFrom(moduleUrl: string): string {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  while (true) {
    if (fileExists(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

export function readManifest(root: string): PackageManifest {
  const manifest = readJsonSync<PackageManifest>(path.join(root, "package.json"));
  if (!manifest?.name) {
    throw new BlueBirdError("io", `No package.json with a name at ${root}`, {
      hint: "Run the link command from a checkout of blue-bird-cli, or install it globally with `npm install -g @not.ayushthakur/blue-bird-cli`.",
    });
  }
  return manifest;
}

export function binNames(manifest: PackageManifest): string[] {
  return Object.keys(manifest.bin ?? {});
}

/** npm's global bin directory: `<prefix>` on Windows, `<prefix>/bin` everywhere else. */
export function globalBinDir(prefix: string, platform: string = process.platform): string {
  return platform === "win32" ? prefix : path.join(prefix, "bin");
}

/** npm writes `.cmd` and `.ps1` shims on Windows, not extensionless files. */
export function binFileNames(name: string, platform: string = process.platform): string[] {
  return platform === "win32" ? [`${name}.cmd`, `${name}.ps1`, name] : [name];
}

function run(command: string, args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").toString().trim(),
    stderr: (result.stderr ?? "").toString().trim(),
  };
}

function resolveGlobalPrefix(): string | undefined {
  return npmGlobalPrefix();
}

/**
 * Links this checkout into the global npm prefix so `bb`, `bluebird` and
 * `blue-bird` work in any directory, then verifies the linked binary answers.
 */
export async function runLinkCommand(options: LinkCommandOptions): Promise<number> {
  const root = options.packageRoot ? path.resolve(options.packageRoot) : packageRootFrom(import.meta.url);
  const manifest = readManifest(root);
  const names = binNames(manifest);
  if (names.length === 0) {
    throw new BlueBirdError("io", `package.json at ${root} declares no "bin" entries`, {
      hint: "Add a bin entry so the package can provide a command.",
    });
  }

  const npmArgs = options.action === "link" ? ["link"] : ["unlink", "-g", manifest.name!];
  const npm = run("npm", npmArgs, root);
  const prefix = resolveGlobalPrefix();
  const binDir = prefix ? globalBinDir(prefix) : undefined;
  // `bb` is the short name worth verifying and reporting first.
  const preferred = names.includes(PRIMARY_BIN) ? [PRIMARY_BIN, ...names.filter((name) => name !== PRIMARY_BIN)] : names;
  const linked = binDir ? preferred.filter((name) => binFileNames(name).some((file) => fileExists(path.join(binDir, file)))) : [];

  let reported: string | undefined;
  if (options.action === "link" && binDir && linked.length > 0) {
    const probe = run(path.join(binDir, binFileNames(linked[0]!)[0]!), ["--version"]);
    if (probe.status === 0 && probe.stdout) reported = probe.stdout.split("\n").pop()!.trim();
  }

  const ok = npm.status === 0 && (options.action === "unlink" || linked.length > 0);
  const detail =
    npm.status !== 0
      ? `${npmArgs.join(" ")} exited ${npm.status ?? "with a signal"}: ${npm.stderr || npm.stdout || "no output"}`
      : options.action === "link"
        ? linked.length === 0
          ? binDir
            ? `npm link succeeded but none of ${names.join(", ")} appeared in ${binDir}`
            : "npm link succeeded but the global prefix could not be read"
          : `${manifest.name} v${manifest.version ?? VERSION} linked as ${linked.join(", ")}`
        : `${manifest.name} unlinked from the global prefix`;

  const result: LinkResult = {
    packageRoot: root,
    packageName: manifest.name!,
    version: manifest.version ?? VERSION,
    ...(prefix ? { prefix } : {}),
    ...(binDir ? { binDir } : {}),
    linked,
    ...(reported ? { reported } : {}),
    ok,
    detail,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return ok ? 0 : 1;
  }

  process.stdout.write(`\n${bold(`Blue Bird ${options.action === "link" ? "link" : "unlink"}`)}\n\n`);
  process.stdout.write(`  ${"package".padEnd(10)} ${result.packageName} ${dim(`v${result.version}`)}\n`);
  process.stdout.write(`  ${"location".padEnd(10)} ${dim(root)}\n`);
  if (binDir) process.stdout.write(`  ${"global bin".padEnd(10)} ${dim(binDir)}\n`);

  if (!ok) {
    process.stdout.write(`\n  ${dim("!")} ${result.detail}\n`);
    if (/EACCES|EPERM/i.test(result.detail)) {
      process.stdout.write(`      ${dim("→ the global prefix needs elevated permissions; a node version manager (nvm, fnm, volta) avoids that")}\n`);
    } else if (options.action === "link") {
      process.stdout.write(`      ${dim(`→ run \`npm link\` in ${root} manually to see the full output`)}\n`);
    }
    process.stdout.write("\n");
    return 1;
  }

  if (options.action === "link") {
    process.stdout.write(`  ${"commands".padEnd(10)} ${accent(linked.join(", "))}\n`);
    if (reported) {
      process.stdout.write(`  ${"verified".padEnd(10)} ${dim(`${linked[0]} --version → ${reported}`)}\n`);
    }
    if (reported && reported !== VERSION) {
      process.stdout.write(`  ${dim(`! the linked binary reports ${reported} while this checkout is ${VERSION} — another install may take precedence`)}\n`);
    }
    process.stdout.write(`\n  ${accent("✓")} ${CLI_NAME} now runs from any directory ${dim("(remove with `bluebird unlink`)")}\n\n`);
    return 0;
  }

  process.stdout.write(`\n  ${accent("✓")} ${linked.length ? `removed the global link for ${linked.join(", ")}` : "no global links were present"}\n\n`);
  return 0;
}

/** Whether the running copy is the one the shell would start. */
export function describeInstall(root: string): string {
  const binDir = resolveGlobalPrefix();
  if (!binDir) return `running from ${root} (global prefix unknown)`;
  const dir = globalBinDir(binDir);
  const exists = fs.existsSync(path.join(dir, "bb"));
  return exists ? `running from ${root}, linked into ${dir}` : `running from ${root} (not linked globally — \`${CLI_NAME} link\`)`;
}
