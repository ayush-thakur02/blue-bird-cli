import type { ProviderDef, ResolvedModel } from "../config/schema.ts";
import { ConfigError } from "../util/errors.ts";
import { hashShort } from "../util/paths.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import { createMockProvider } from "./mock.ts";
import { createOpenAiChatProvider } from "./openai-chat.ts";
import { createOpenAiResponsesProvider } from "./openai-responses.ts";
import type { Provider } from "./types.ts";

export function createProvider(args: { id: string; def: ProviderDef; apiKey?: string }): Provider {
  const api = args.def.api ?? "openai-completions";
  switch (api) {
    case "openai-completions":
      return createOpenAiChatProvider(args);
    case "openai-responses":
      return createOpenAiResponsesProvider(args);
    case "anthropic-messages":
      return createAnthropicProvider(args);
    case "mock":
      return createMockProvider(args);
    default:
      throw new ConfigError(`Unsupported api dialect "${String(api)}" for provider "${args.id}"`, {
        hint: "Use one of: openai-completions, openai-responses, anthropic-messages, mock",
      });
  }
}

export class ProviderCache {
  private readonly cache = new Map<string, Provider>();

  get(model: ResolvedModel): Provider {
    // Hash the whole key: a suffix collides across distinct keys that share
    // their last characters, which would serve one provider's credentials to
    // another. The hash keeps keys out of the map itself.
    const key = hashShort(`${model.providerId}\u0000${model.api}\u0000${model.apiKey ?? ""}`, 32);
    const existing = this.cache.get(key);
    if (existing) return existing;
    const provider = createProvider({ id: model.providerId, def: model.provider, ...(model.apiKey ? { apiKey: model.apiKey } : {}) });
    this.cache.set(key, provider);
    return provider;
  }

  clear(): void {
    this.cache.clear();
  }
}

export type { Provider } from "./types.ts";
