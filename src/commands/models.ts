import { listProviders, loadRawConfig, resolveModel, splitModelRef } from "../config/load.ts";
import { createProvider } from "../providers/index.ts";
import { dim, accent, bold } from "../cli/prompt.ts";
import { formatCount } from "../util/text.ts";

export interface ModelsOptions {
  cwd: string;
  refresh?: boolean;
  json?: boolean;
  provider?: string;
}

export async function runModelsCommand(options: ModelsOptions): Promise<number> {
  const { raw } = loadRawConfig({ cwd: options.cwd });
  const providers = listProviders(raw);
  const warnings: string[] = [];

  if (options.refresh) {
    const entries: { provider: string; models: string[]; error?: string }[] = [];
    for (const [id, def] of Object.entries(providers)) {
      if (options.provider && options.provider !== id) continue;
      try {
        const model = resolveModel(raw, { cwd: options.cwd, provider: id }, []);
        const provider = createProvider({ id, def, ...(model.apiKey ? { apiKey: model.apiKey } : {}) });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        try {
          const models = await provider.listModels(controller.signal);
          entries.push({ provider: id, models: models.map((entry) => entry.id) });
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        entries.push({ provider: id, models: [], error: (error as Error).message });
      }
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
      return 0;
    }
    for (const entry of entries) {
      process.stdout.write(`${bold(entry.provider)}\n`);
      if (entry.error) process.stdout.write(`  ${dim(`could not list models: ${entry.error}`)}\n`);
      for (const id of entry.models) process.stdout.write(`  ${id}\n`);
      if (!entry.models.length && !entry.error) process.stdout.write(`  ${dim("no models reported")}\n`);
    }
    return 0;
  }

  let active: string | undefined;
  try {
    active = resolveModel(raw, { cwd: options.cwd }, warnings).label;
  } catch {
    active = undefined;
  }

  if (options.json) {
    const payload = Object.entries(providers).map(([id, def]) => ({
      id,
      api: def.api,
      baseURL: def.baseURL,
      models: (def.models ?? []).map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
        pricing: model.pricing,
      })),
    }));
    process.stdout.write(`${JSON.stringify({ active, providers: payload }, null, 2)}\n`);
    return 0;
  }

  if (Object.keys(providers).length === 0) {
    process.stdout.write(`${dim("No providers configured. Run `bluebird init`.")}\n`);
    return 1;
  }

  for (const [id, def] of Object.entries(providers)) {
    process.stdout.write(`${bold(id)} ${dim(`(${def.api})`)} ${dim(def.baseURL)}\n`);
    if (!def.models?.length) {
      process.stdout.write(`  ${dim("no models declared — add them under providers." + id + ".models, or run with --refresh")}\n`);
      continue;
    }
    for (const model of def.models) {
      const label = id === "default" ? model.id : `${id}/${model.id}`;
      const marker = label === active ? accent("●") : dim("○");
      const meta = [
        model.contextWindow ? `${formatCount(model.contextWindow)} ctx` : undefined,
        model.maxOutput ? `${formatCount(model.maxOutput)} out` : undefined,
        model.pricing ? `$${model.pricing.input}/$${model.pricing.output} per M` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      process.stdout.write(`  ${marker} ${model.id}${meta ? `  ${dim(meta)}` : ""}\n`);
    }
  }
  for (const warning of warnings) process.stdout.write(`${dim(`warning: ${warning}`)}\n`);
  process.stdout.write(`\n${dim("Use --refresh to query the endpoint for its model list.")}\n`);
  return 0;
}

export interface ToolsCommandOptions {
  cwd: string;
  name?: string;
  json?: boolean;
  /** Omit tools the current flags switch off, so the inventory matches a session. */
  disableSubagents?: boolean;
}

export function runToolsCommand(options: ToolsCommandOptions): Promise<number> {
  return import("../tools/index.ts").then(({ defaultTools }) => {
    const tools = defaultTools().filter((tool) => !(options.disableSubagents && tool.name === "task"));
    if (options.name) {
      const tool = tools.find((entry) => entry.name === options.name);
      if (!tool) {
        process.stderr.write(`bluebird: no tool named ${options.name}\n`);
        return 1;
      }
      process.stdout.write(`${bold(tool.name)} ${dim(tool.readOnly ? "read-only" : "may write")}\n\n${tool.description}\n\n`);
      process.stdout.write(`${JSON.stringify(tool.parameters, null, 2)}\n`);
      return 0;
    }
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          tools.map((tool) => ({ name: tool.name, description: tool.description, readOnly: Boolean(tool.readOnly), risk: tool.risk })),
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    process.stdout.write(`${bold(`${tools.length} tools`)}\n\n`);
    for (const tool of tools) {
      process.stdout.write(`  ${accent(tool.name.padEnd(14))} ${dim((tool.readOnly ? "read-only" : tool.risk ?? "write").padEnd(9))} ${tool.description.split("\n")[0]}\n`);
    }
    return 0;
  });
}

export function describeModelRef(cwd: string, ref: string): string {
  const { raw } = loadRawConfig({ cwd });
  const parsed = splitModelRef(ref);
  const warnings: string[] = [];
  const model = resolveModel(raw, { cwd, provider: parsed.provider, model: parsed.model }, warnings);
  return `${model.label} (${model.api} · ${model.baseURL})`;
}
