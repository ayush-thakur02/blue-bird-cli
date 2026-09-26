import fs from "node:fs";
import path from "node:path";
import {
  IMPLICIT_PROVIDER_ID,
  credentialsPath,
  globalConfigPath,
  loadRawConfig,
  mergeConfig,
  projectConfigPath,
  redactConfig,
  resolveModel,
  saveConfigFile,
  validateConfig,
} from "../config/load.ts";
import type { BlueBirdConfig, PermissionConfig } from "../config/schema.ts";
import { EFFORT_DESCRIPTIONS, EFFORT_LEVELS } from "../config/schema.ts";
import { globalEnvFile, projectEnvFile } from "../config/env-file.ts";
import { PERMISSION_PRESETS } from "../core/contracts.ts";
import { findWorkspaceRoot, readJsonSync } from "../util/paths.ts";
import { dim, accent, bold } from "../cli/prompt.ts";

export interface ConfigCommandOptions {
  cwd: string;
  action: string;
  key?: string;
  value?: string;
  global?: boolean;
  json?: boolean;
  configPath?: string;
}

export async function runConfigCommand(options: ConfigCommandOptions): Promise<number> {
  const root = findWorkspaceRoot(options.cwd);
  const useGlobal = Boolean(options.global);
  const file = options.configPath ?? (useGlobal ? globalConfigPath() : projectConfigPath(root));

  switch (options.action) {
    case "path": {
      const paths = [
        `global   ${globalConfigPath()}`,
        `project  ${projectConfigPath(root)}`,
        `local    ${path.join(root, ".bluebird", "config.local.json")}`,
        `keys     ${credentialsPath()}`,
        `env      ${projectEnvFile(root)}  (also ${globalEnvFile()})`,
        `sessions ${path.join(root, ".bluebird", "sessions")}`,
      ];
      process.stdout.write(options.json ? `${JSON.stringify({ file, paths }, null, 2)}\n` : `${paths.join("\n")}\n`);
      return 0;
    }

    case "list":
    case "show": {
      const { raw, sources, warnings } = loadRawConfig({ cwd: options.cwd, ...(options.configPath ? { configPath: options.configPath } : {}) });
      const redacted = redactConfig(raw);
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ config: redacted, sources, warnings }, null, 2)}\n`);
        return 0;
      }
      process.stdout.write(`${bold("Sources")} (lowest to highest precedence):\n`);
      for (const source of sources.length ? sources : ["(built-in defaults only)"]) process.stdout.write(`  ${source}\n`);
      process.stdout.write(`\n${bold("Effective configuration")}\n`);
      process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
      const validation = validateConfig(raw);
      for (const warning of [...warnings, ...validation.warnings]) process.stdout.write(`${dim(`warning: ${warning}`)}\n`);
      for (const error of validation.errors) process.stdout.write(`error: ${error}\n`);
      return validation.errors.length ? 1 : 0;
    }

    case "get": {
      const { raw } = loadRawConfig({ cwd: options.cwd, ...(options.configPath ? { configPath: options.configPath } : {}) });
      if (!options.key) {
        printUsage();
        return 1;
      }
      const value = getPath(raw as unknown as Record<string, unknown>, options.key);
      if (value === undefined) {
        process.stderr.write(`bluebird: "${options.key}" is not set\n`);
        return 1;
      }
      process.stdout.write(options.json ? `${JSON.stringify(value, null, 2)}\n` : `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
      return 0;
    }

    case "set": {
      if (!options.key || options.value === undefined) {
        printUsage();
        return 1;
      }
      const existing = readJsonSync<BlueBirdConfig>(file) ?? { version: 1 };
      const parsed = parseValue(options.value);
      const patch = buildPatch(options.key, parsed);
      const merged = mergeConfig(existing, patch) as BlueBirdConfig;
      const validation = validateConfig(merged);
      if (validation.errors.length) {
        for (const error of validation.errors) process.stderr.write(`bluebird: ${error}\n`);
        return 1;
      }
      saveConfigFile(file, merged);
      process.stdout.write(`${accent("✓")} ${options.key} = ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}  ${dim(`(${file})`)}\n`);
      if (options.key.toLowerCase().includes("apikey") && typeof parsed === "string" && !parsed.startsWith("${")) {
        process.stdout.write(`${dim("note: the key is stored in plain text here — prefer \"${ENV_VAR}\" or ~/.bluebird/credentials.json for shared repos")}\n`);
      }
      return 0;
    }

    case "unset": {
      if (!options.key) {
        printUsage();
        return 1;
      }
      const existing = readJsonSync<BlueBirdConfig>(file);
      if (!existing) {
        process.stderr.write(`bluebird: no config at ${file}\n`);
        return 1;
      }
      const patch = buildPatch(options.key, null);
      saveConfigFile(file, mergeConfig(existing, patch));
      process.stdout.write(`${accent("✓")} removed ${options.key}\n`);
      return 0;
    }

    case "edit": {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        saveConfigFile(file, { version: 1 });
      }
      const editor = process.env.EDITOR ?? process.env.VISUAL;
      if (!editor) {
        process.stdout.write(`${file}\n`);
        return 0;
      }
      const { spawnSync } = await import("node:child_process");
      spawnSync(editor, [file], { stdio: "inherit", shell: true });
      return 0;
    }

    case "effort": {
      const existing = readJsonSync<BlueBirdConfig>(file) ?? { version: 1 };
      if (!options.value) {
        process.stdout.write(`${existing.effort ?? "auto"}\n`);
        for (const level of EFFORT_LEVELS) process.stdout.write(`  ${level.padEnd(8)} ${EFFORT_DESCRIPTIONS[level]}\n`);
        process.stdout.write(`  ${"auto".padEnd(8)} decide per request\n`);
        return 0;
      }
      const value = options.value.toLowerCase();
      if (value !== "auto" && !EFFORT_LEVELS.includes(value as never)) {
        process.stderr.write(`bluebird: effort must be auto or one of ${EFFORT_LEVELS.join(", ")}\n`);
        return 1;
      }
      saveConfigFile(file, { ...existing, effort: value as BlueBirdConfig["effort"] });
      process.stdout.write(`${accent("✓")} default effort set to ${value} ${dim(`(${file})`)}\n`);
      return 0;
    }

    case "permissions": {
      const existing = readJsonSync<BlueBirdConfig>(file) ?? { version: 1 };
      if (!options.value) {
        const current: PermissionConfig = existing.permissions ?? { preset: "ask" };
        process.stdout.write(`${bold("preset")}      ${current.preset ?? "ask"}\n`);
        process.stdout.write(`${bold("allow")}       ${(current.allow ?? []).join(", ") || dim("(none)")}\n`);
        process.stdout.write(`${bold("deny")}        ${(current.deny ?? []).join(", ") || dim("(none)")}\n`);
        process.stdout.write(`${bold("network")}     ${current.network === false ? "off" : "on"}\n`);
        process.stdout.write(`\nPresets: ${PERMISSION_PRESETS.join(", ")}\n`);
        return 0;
      }
      const [maybePreset, ...rest] = options.value.split(/\s+/).filter(Boolean);
      if (maybePreset === "allow" || maybePreset === "deny") {
        const rule = rest.join(" ");
        if (!rule) {
          process.stderr.write("bluebird: usage: bluebird permissions allow <Tool(pattern)>\n");
          return 1;
        }
        const list = new Set([...(existing.permissions?.[maybePreset] ?? []), rule]);
        saveConfigFile(file, {
          ...existing,
          permissions: { ...(existing.permissions ?? { preset: "ask" }), [maybePreset]: [...list] },
        });
        process.stdout.write(`${accent("✓")} ${maybePreset} rule added: ${rule}\n`);
        return 0;
      }
      if (!PERMISSION_PRESETS.includes(maybePreset as never)) {
        process.stderr.write(`bluebird: preset must be one of ${PERMISSION_PRESETS.join(", ")}\n`);
        return 1;
      }
      saveConfigFile(file, { ...existing, permissions: { ...(existing.permissions ?? {}), preset: maybePreset as never } });
      process.stdout.write(`${accent("✓")} permission preset set to ${maybePreset}\n`);
      return 0;
    }

    case "providers": {
      const { raw } = loadRawConfig({ cwd: options.cwd });
      for (const [id, def] of Object.entries(raw.providers ?? {})) {
        process.stdout.write(`${bold(id)} ${dim(`(${def.api})`)}\n  ${def.baseURL}\n`);
        for (const model of def.models ?? []) {
          process.stdout.write(`  · ${model.id}${model.contextWindow ? dim(` (${model.contextWindow} ctx)`) : ""}\n`);
        }
      }
      if (raw.endpoint && !raw.providers?.[IMPLICIT_PROVIDER_ID]) {
        process.stdout.write(`${bold("default")} ${dim(`(${raw.api ?? "openai-completions"})`)}\n  ${raw.endpoint}\n  · ${raw.model ?? "(no model set)"}\n`);
      }
      const warnings: string[] = [];
      try {
        const model = resolveModel(raw, { cwd: options.cwd }, warnings);
        process.stdout.write(`\n${dim(`active: ${model.label} · key source: ${model.apiKeySource}`)}\n`);
      } catch (error) {
        process.stdout.write(`\n${dim((error as Error).message)}\n`);
      }
      return 0;
    }

    default:
      // An unknown action is a mistake, not a successful no-op.
      process.stderr.write(`bluebird: unknown config action "${options.action}"\n\n`);
      printUsage();
      return 1;
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: bluebird config <action> [key] [value]",
      "",
      "  list                       show merged configuration with sources (alias: show)",
      "  get <key>                  read one value",
      "  set <key> <value>          write a value (creates .bluebird/config.json)",
      "  unset <key>                remove a value",
      "  edit                       open the config in $EDITOR",
      "  path                       print config, credential and session paths",
      "  effort [level]             show or set the default effort",
      "  permissions [preset]       show or set the permission preset",
      "  providers                  list providers and models",
      "",
      "Keys accept dot paths, e.g. providers.azure.baseURL, ui.diff, context.compactAt, permissions.preset.",
      "Add --global to target ~/.bluebird/config.json instead of the project file.",
    ].join("\n") + "\n",
  );
}

function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function buildPatch(key: string, value: unknown): BlueBirdConfig {
  const segments = key.split(".").filter(Boolean);
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      break;
    }
    cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  return root as unknown as BlueBirdConfig;
}

export function getPath(target: Record<string, unknown>, key: string): unknown {
  let cursor: unknown = target;
  for (const segment of key.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
