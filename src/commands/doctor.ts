import path from "node:path";
import os from "node:os";
import { loadRawConfig, listProviders, resolveModel, validateConfig, credentialsPath, globalConfigPath, projectConfigPath } from "../config/load.ts";
import type { ResolvedModel } from "../config/schema.ts";
import { createProvider } from "../providers/index.ts";
import { cachePlan, MAX_ANTHROPIC_BREAKPOINTS, type CachePlan } from "../providers/caching.ts";
import { modelSupportsImages, shouldAttachImages } from "../core/vision.ts";
import { formatCount } from "../util/text.ts";
import { findWorkspaceRoot, isDirectory, fileExists, bluebirdHome } from "../util/paths.ts";
import { extensionDirs, loadAgents, loadCommands, loadSkills, mergeAgents } from "../core/extensions.ts";
import { discoverMemory } from "../core/memory.ts";
import { defaultTools } from "../tools/index.ts";
import { describeInstall, packageRootFrom } from "./link.ts";
import { readUpdateState, skipReason } from "../core/update.ts";
import { dim, accent, bold } from "../cli/prompt.ts";
import { VERSION } from "../version.ts";

export interface DoctorOptions {
  cwd: string;
  json?: boolean;
  /** Skip the network probe. */
  offline?: boolean;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const checks: Check[] = [];
  const warnings: string[] = [];

  checks.push({
    name: "node",
    ok: Number(process.versions.node.split(".")[0]) >= 22,
    detail: `v${process.versions.node} on ${os.platform()} ${os.arch()}`,
    hint: "Blue Bird needs Node 22.18+ to execute TypeScript directly.",
  });

  const root = findWorkspaceRoot(options.cwd);
  checks.push({
    name: "workspace",
    ok: isDirectory(options.cwd),
    detail: `${options.cwd}${root !== options.cwd ? ` (root ${root})` : ""}`,
  });

  let raw;
  try {
    const loaded = loadRawConfig({ cwd: options.cwd });
    raw = loaded.raw;
    checks.push({
      name: "config",
      ok: true,
      detail: loaded.sources.length ? loaded.sources.map((source) => path.relative(options.cwd, source) || source).join(", ") : "built-in defaults only",
      ...(loaded.sources.length ? {} : { hint: "Run `bluebird init` to point Blue Bird at a model endpoint." }),
    });
    warnings.push(...loaded.warnings);
    checks.push({
      name: "env files",
      ok: true,
      detail: loaded.envFiles.length
        ? `${loaded.envFiles.map((file) => path.relative(options.cwd, file) || file).join(", ")} · ${
            loaded.envKeys.length ? `${loaded.envKeys.length} variable(s) from file: ${loaded.envKeys.join(", ")}` : "no variables taken from file"
          }`
        : "none (run `bluebird init` to keep a key in .env)",
    });
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: (error as Error).message });
    return report(checks, warnings, options);
  }

  const validation = validateConfig(raw);
  checks.push({
    name: "config:validate",
    ok: validation.errors.length === 0,
    detail: validation.errors.length ? validation.errors.join("; ") : "no schema errors",
  });
  warnings.push(...validation.warnings);

  const providers = listProviders(raw);
  checks.push({
    name: "providers",
    ok: Object.keys(providers).length > 0,
    detail: Object.entries(providers)
      .map(([id, def]) => `${id} (${def.api})`)
      .join(", ") || "none configured",
    ...(Object.keys(providers).length ? {} : { hint: "Add `endpoint`, `model` and `apiKey` to .bluebird/config.json (or run `bluebird init`)." }),
  });

  const resolveWarnings: string[] = [];
  try {
    const model = resolveModel(raw, { cwd: options.cwd }, resolveWarnings);
    warnings.push(...resolveWarnings);
    checks.push({
      name: "model",
      ok: true,
      detail: `${model.label} · ${model.api} · ${model.contextWindow.toLocaleString()} ctx · key: ${model.apiKeySource}`,
    });
    checks.push({
      name: "credentials",
      ok: Boolean(model.apiKey) || model.api === "mock",
      detail: model.apiKey
        ? `resolved from ${model.apiKeySource}${model.apiKey ? ` (${model.apiKey.slice(0, 3)}…${model.apiKey.slice(-4)})` : ""}`
        : "no API key found",
      ...(model.apiKey || model.api === "mock"
        ? {}
        : {
            hint: `Set the env var named in your config, or store a key in ${credentialsPath()} with \`bluebird init\`.`,
          }),
    });

    if (!options.offline && model.api !== "mock") {
      const provider = createProvider({ id: model.providerId, def: model.provider, ...(model.apiKey ? { apiKey: model.apiKey } : {}) });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      try {
        const probe = await provider.probe(controller.signal);
        checks.push({
          name: "endpoint",
          ok: probe.ok,
          detail: probe.detail + (probe.latencyMs !== undefined ? ` (${probe.latencyMs}ms)` : ""),
          ...(probe.ok ? {} : { hint: "Verify baseURL (usually ends in /v1), the API dialect, and that outbound network access is allowed." }),
        });
        if (probe.models?.length) {
          checks.push({
            name: "models",
            ok: probe.models.includes(model.model.id) || probe.models.length === 0,
            detail: probe.models.slice(0, 8).join(", ") + (probe.models.length > 8 ? ` … +${probe.models.length - 8}` : ""),
            ...(probe.models.includes(model.model.id)
              ? {}
              : { hint: `"${model.model.id}" was not in the provider's model list — it may still work for Azure deployments.` }),
          });
        }
      } catch (error) {
        checks.push({ name: "endpoint", ok: false, detail: (error as Error).message });
      } finally {
        clearTimeout(timer);
      }
    } else if (options.offline) {
      checks.push({ name: "endpoint", ok: true, detail: "skipped (--offline)" });
    }

    const window = raw.context?.maxTokens ?? model.contextWindow;
    checks.push({
      name: "context window",
      ok: window > 0,
      detail:
        `${formatCount(window)} tokens` +
        (model.model.assumedWindow ? " (assumed)" : " (declared)") +
        ` · compaction at ${((raw.context?.compactAt ?? 0.82) * 100).toFixed(0)}% · reserve ${formatCount(raw.context?.reserveOutputTokens ?? 16_000)}`,
      ...(model.model.assumedWindow
        ? {
            hint:
              `Blue Bird assumes ${formatCount(window)} when a model declares nothing. ` +
              `Set contextWindow on the model (or context.assumeWindow) to match your deployment — ` +
              `if the provider rejects an oversized prompt, Blue Bird halves the window and retries automatically.`,
          }
        : {}),
    });

    const plan = cachePlan(model);
    checks.push({
      name: "prompt caching",
      ok: true,
      detail: describeCachePlan(model, plan),
    });

    checks.push({
      name: "vision",
      ok: true,
      detail: describeVision(model, raw.images?.enabled !== false),
    });
  } catch (error) {
    checks.push({ name: "model", ok: false, detail: (error as Error).message });
  }

  const home = bluebirdHome();
  const dirs = extensionDirs({ root, home });
  const skills = loadSkills(dirs.skills);
  const agents = mergeAgents(loadAgents(dirs.agents));
  const commands = loadCommands(dirs.commands);
  const memory = discoverMemory({ cwd: options.cwd, root, home });
  checks.push({
    name: "extensions",
    ok: true,
    detail: `${skills.length} skills · ${agents.length} subagents · ${commands.length} commands · ${memory.entries.length} instruction file(s)`,
  });

  checks.push({
    name: "tools",
    ok: true,
    detail: `${defaultTools().length} built-in tools`,
  });

  const gitDir = path.join(root, ".git");
  checks.push({
    name: "git",
    ok: true,
    detail: fileExists(gitDir) ? `repository at ${root}` : "not a git repository (checkpoints still work)",
  });

  checks.push({
    name: "paths",
    ok: true,
    detail: `home ${bluebirdHome()} · project ${projectConfigPath(root)} · global ${globalConfigPath()}`,
  });

  checks.push({
    name: "install",
    ok: true,
    detail: describeInstall(packageRootFrom(import.meta.url)),
  });

  const updateState = readUpdateState();
  const updateSkip = skipReason({
    config: raw,
    tty: Boolean(process.stdin.isTTY),
    packageRoot: packageRootFrom(import.meta.url),
  });
  checks.push({
    name: "update",
    ok: true,
    detail: [
      `running v${VERSION}`,
      updateState.latest ? `registry has ${updateState.latest}` : "registry not checked yet",
      updateState.installed ? `installed ${updateState.installed} — restart to use it` : undefined,
      updateSkip ? `automatic updates off: ${updateSkip}` : "automatic updates on",
      updateState.installError ? `last install failed: ${updateState.installError}` : undefined,
      updateState.error ? `last check failed: ${updateState.error}` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  });

  return report(checks, warnings, options);
}

function describeVision(model: ResolvedModel, enabled: boolean): string {
  if (!enabled) return "disabled by images.enabled — view_image hidden, @image attachments skipped";
  if (!shouldAttachImages(model)) return `text only — view_image hidden for "${model.model.id}"`;
  const suffix = " · view_image tool available";
  if (model.model.supportsImages === true) return `images declared supported${suffix}`;
  if (modelSupportsImages(model)) return `images supported (recognised model family)${suffix}`;
  return `images assumed supported for the unknown model "${model.model.id}" — set supportsImages to be explicit${suffix}`;
}

function describeCachePlan(model: ResolvedModel, plan: CachePlan): string {
  if (model.provider.compat?.promptCache === false) return "disabled by compat.promptCache";
  const parts: string[] = [];
  if (plan.breakpoints) {
    parts.push(
      `Anthropic cache_control breakpoints: system + tools + ${plan.tailBreakpoints} conversation turn(s), ` +
        `up to ${MAX_ANTHROPIC_BREAKPOINTS} prefixes`,
    );
  } else {
    parts.push("automatic prefix caching on the provider side");
  }
  if (plan.cacheKey) parts.push(`prompt_cache_key per session${plan.retention ? ` (retention ${plan.retention})` : ""}`);
  else if (!plan.breakpoints) parts.push("no explicit cache hints needed for this host");
  return parts.join(" · ");
}

function report(checks: Check[], warnings: string[], options: DoctorOptions): number {
  const failures = checks.filter((check) => !check.ok);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ version: VERSION, checks, warnings, ok: failures.length === 0 }, null, 2)}\n`);
    return failures.length > 0 ? 1 : 0;
  }

  process.stdout.write(`\n${bold(`Blue Bird doctor`)} ${dim(`v${VERSION}`)}\n\n`);
  for (const check of checks) {
    const mark = check.ok ? accent("✓") : "\u001b[31m✗\u001b[0m";
    process.stdout.write(`  ${mark} ${check.name.padEnd(18)} ${dim(check.detail)}\n`);
    if (check.hint && !check.ok) process.stdout.write(`      ${dim(`→ ${check.hint}`)}\n`);
  }
  if (warnings.length) {
    process.stdout.write(`\n  ${bold("warnings")}\n`);
    for (const warning of warnings) process.stdout.write(`    ${dim(warning)}\n`);
  }
  process.stdout.write(
    failures.length === 0
      ? `\n  ${accent("All checks passed")} — ${dim("bluebird")} is ready.\n\n`
      : `\n  ${failures.length} check(s) failed.\n\n`,
  );
  return failures.length > 0 ? 1 : 0;
}
