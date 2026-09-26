# Configuration

Blue Bird merges configuration from several places. Later sources win.

1. Built-in defaults
2. `~/.bluebird/config.json` — global
3. `<root>/.bluebird/config.json` — project (commit this)
4. `<root>/.bluebird/config.local.json` — private overrides (gitignored)
5. `<root>/.env`, then `~/.bluebird/.env` — keys and other variables (gitignored)
6. Environment variables
7. Command-line flags

`.env` files only fill variables the process does not already have, so a real environment variable
(or `MY_KEY=… bluebird …`) always wins. `bluebird init` writes there when you choose to store the key
in `.env`; `bluebird doctor` reports which files were loaded and which variables came from them.

## Updates

```jsonc
"update": { "auto": true, "checkIntervalHours": 24 }
```

The interactive CLI asks `registry.npmjs.org` for the newest version at most once per interval (the
answer is cached in `~/.bluebird/update.json`, so a session usually starts without a request). When a
newer release exists and npm itself installed this copy, it runs `npm install -g` detached in the
background and prints `✓ updated … restart to use it`; anything else — a linked checkout, a pnpm or
yarn install, a machine without write access to the prefix — prints the command to run instead.

Set `BLUEBIRD_NO_UPDATE=1` to disable the check for one environment, or `update.auto: false` to
disable it in the config. Non-interactive runs and CI are always skipped. `bluebird doctor` reports
the running version, the version the registry reported, and the reason when automatic updates are off.

`bluebird config list` prints the merged result, the sources and any validation problems.
`bluebird config path` prints every location. A `--config <path>` flag (or `BLUEBIRD_CONFIG`) pins a
single file instead.

## The shortcuts

For a single endpoint you never need the provider registry:

```jsonc
{
  "version": 1,
  "endpoint": "https://host/v1",
  "api": "openai-completions",
  "model": "model-id",
  "apiKey": "${MY_API_KEY}",
  "contextWindow": 1000000,
  "maxOutput": 64000
}
```

| Key | Notes |
| --- | --- |
| `endpoint` | Base URL, usually ending in `/v1`. A full `/chat/completions` URL also works. |
| `api` | `openai-completions` (default), `openai-responses`, `anthropic-messages`, `mock`. |
| `model` | Model or deployment id. May be `provider/model` when providers are defined. |
| `apiKey` | Literal, `${ENV_VAR}`, `${ENV_VAR:-fallback}`. Prefer the env form. |
| `apiKeyEnv` | Alternative: name of the environment variable holding the key. |
| `contextWindow` | Context window in tokens. **Defaults to 1,000,000.** |
| `maxOutput` | Output cap per response. Defaults to 64,000. |

Key resolution order: `apiKey` → `apiKeyEnv` → `BLUEBIRD_<PROVIDER>_API_KEY` →
`providers.<id>.apiKeyFile` → `~/.bluebird/credentials.json` (`providers.<id>`, then `hosts.<origin>`)
→ `BLUEBIRD_API_KEY` → `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` for matching dialects.

## Multiple providers

```jsonc
{
  "version": 1,
  "provider": "azure",
  "model": "gpt-5.6-terra",
  "fallbacks": ["openai/gpt-5.6-terra", "local/qwen3-coder"],
  "providers": {
    "azure": {
      "api": "openai-completions",
      "baseURL": "https://my-foundry.openai.azure.com/openai/v1",
      "apiKey": "${AZURE_OPENAI_API_KEY}",
      "compat": { "maxTokensParam": "max_completion_tokens", "effortParam": "reasoning_effort" },
      "models": [
        { "id": "gpt-5.6-terra", "contextWindow": 400000, "maxOutput": 128000,
          "pricing": { "input": 1.25, "output": 10 } }
      ]
    },
    "anthropic": {
      "api": "anthropic-messages",
      "baseURL": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "compat": { "promptCache": true },
      "models": [{ "id": "claude-sonnet-4-5", "contextWindow": 200000, "maxOutput": 64000 }]
    },
    "local": {
      "api": "openai-completions",
      "baseURL": "http://localhost:11434/v1",
      "models": [{ "id": "qwen3-coder", "contextWindow": 128000 }]
    }
  }
}
```

`pricing` (USD per million tokens) enables the cost readout in `/cost` and the status line.
`contextWindow` drives compaction; declare it for accurate behaviour.

### compat flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `authStyle` | `auto` | `bearer`, `api-key` (Azure), or `x-api-key` |
| `effortParam` | `reasoning_effort` | Rename or disable (`null`) the reasoning field |
| `effortObject` | `false` | Send `reasoning: { effort }` instead of a flat field |
| `maxTokensParam` | `max_tokens` | Switch to `max_completion_tokens` |
| `streamUsage` | `true` | Send `stream_options.include_usage` |
| `parallelToolCalls` | `true` | Send `parallel_tool_calls` |
| `streaming` | `true` | Disable for gateways that cannot stream |
| `chatPath` / `messagesPath` / `responsesPath` / `modelsPath` | dialect defaults | Override endpoint paths |
| `promptCache` | `"auto"` | `auto` caches where the dialect supports it, `true` forces every hint, `false` disables |
| `promptCacheKey` | auto | Send `prompt_cache_key` (a stable per-session key) |
| `promptCacheRetention` | `24h` on OpenAI hosts | Send `prompt_cache_retention` |
| `promptCacheBeta` | `false` | Send the Anthropic `prompt-caching-2024-07-31` beta header |
| `context1m` | `false` | Anthropic beta header for 1M context |
| `store` | unset | Responses API server-side state |

### Prompt caching

Blue Bird caches by default and adapts to what the endpoint accepts:

- **Anthropic** (`anthropic-messages`): up to four `cache_control` breakpoints — the system prompt,
  the last tool definition, and the two most recent conversation turns. Each turn therefore extends
  the cached prefix instead of rewriting it.
- **OpenAI-compatible** (`openai-completions`, `openai-responses`): a stable `prompt_cache_key`
  derived from the session id, plus `prompt_cache_retention: "24h"` where it is supported. Cache
  reads come back in `prompt_tokens_details.cached_tokens` and are reported by `/cost`.
- **DeepSeek-style usage** (`prompt_cache_hit_tokens`) and Anthropic
  (`cache_read_input_tokens` / `cache_creation_input_tokens`) are accounted for per session.
- **Rejections are remembered.** If an endpoint answers 400 for a cache parameter, it is dropped for
  the rest of the process for that provider instead of being retried on every turn.

Cache hits need a stable prefix: the system prompt, tool list and message history are kept
byte-identical between turns for exactly this reason. `/cost` shows the hit ratio, and the status
line adds `cache NN%` once a session has read more than a token's worth of cached input.

## Sections

### `context`

```jsonc
"context": {
  "assumeWindow": 1000000,    // window used when a model declares none
  "maxTokens": null,          // hard ceiling; overrides the model's window
  "compactAt": 0.82,          // fraction of the budget that triggers compaction
  "compaction": "auto",       // auto | prune | off
  "keepRecentTurns": 6,       // turns preserved verbatim
  "maxToolOutputChars": 24000,
  "pruneStaleToolOutputs": true,
  "reserveOutputTokens": 16000,
  "recoverFromOverflow": true // halve the window and retry when a provider says "too long"
}
```

Resolution order for the effective window: `model.contextWindow` → `provider.contextWindow` →
`BLUEBIRD_CONTEXT_WINDOW` → `context.assumeWindow` → **1,000,000**.

### `images`

```jsonc
"images": {
  "enabled": true,              // offer view_image and accept @image attachments
  "maxBytes": 5000000,          // per image
  "maxPerMessage": 8,           // extras are dropped with a note
  "detail": "auto",             // auto | low | high (OpenAI-style providers)
  "allowOutsideWorkspace": false
}
```

Images can be attached by the user with `@path/to/shot.png` or pulled in by the agent with the
`view_image` tool. Both routes honour the same limits, and both are skipped for models that are
known or declared text-only (`supportsImages: false`) — with a warning rather than a failed request.
Set `supportsImages: true` on a model entry to force the tool on for a model the heuristic misses.

### `permissions`

```jsonc
"permissions": {
  "preset": "ask",                       // read-only | ask | edits | auto | danger-full-access
  "allow": ["bash(npm test:*)", "edit(src/**)"],
  "deny": ["edit(.env*)", "bash(git push:*)"],
  "additionalDirectories": ["../shared-lib"],
  "network": true,
  "allowDangerous": false,
  "trusted": true                        // false: never auto-approve a mutating action here
}
```

Setting `trusted` to `false` is the setting to use when you run the agent inside a repository you do
not control: allow/deny rules and read-only inspection still work, but every edit or command has to
be confirmed even under the `auto` preset.

Rule syntax: `Tool` matches every call to that tool, `Tool(glob)` matches the command text or target
paths, `Tool(prefix:*)` matches a command prefix. `*` is a wildcard tool name.

### `ui`

```jsonc
"ui": {
  "theme": "auto",             // auto | dark | light | none
  "showThinking": true,
  "statusLine": true,
  "showUsage": true,
  "diff": "inline",            // inline | full | none
  "verboseToolOutput": false,
  "respectGitIgnore": true,
  "collapseLines": 14,
  "busyEnter": "queue",        // queue | ignore
  "spinner": true
}
```

### `agent`

```jsonc
"agent": {
  "maxTurns": 120,
  "maxToolCallsPerTurn": 24,
  "temperature": 0.2,
  "autoContinueOnTruncation": true,
  "parallelToolCalls": true,
  "loopGuard": true,
  "retries": 3,
  "subagents": { "enabled": true, "maxConcurrent": 4, "maxTurns": 40, "readOnly": false }
}
```

### `hooks`

```jsonc
"hooks": [
  { "event": "tool.after", "matcher": "^(edit|write)$",
    "command": "jq -r '.args.file_path' | xargs -r npx prettier --write" },
  { "event": "prompt.submit", "matcher": "deploy", "command": "./scripts/require-approval.sh" }
]
```

Events that fire: `session.start`, `prompt.submit`, `tool.before`, `tool.after`, `turn.end`,
`compact.before`. Hooks receive the payload as JSON on stdin and may reply
`{"blocked":true,"reason":"…"}` to veto (`prompt.submit` and `tool.before`), or `{"context":"…"}` to
inject text into the prompt or the tool result.

`matcher` is a regex tested against the tool name (`tool.before`, `tool.after`), the prompt text
(`prompt.submit`), the model id (`turn.end`), or the compaction reason (`compact.before`).

`session.end` and `notification` are accepted in config but no code path fires them yet; the
validator warns when you configure one.

### `memory`

```jsonc
"memory": {
  "autoLoad": true,
  "files": ["docs/CONVENTIONS.md"],
  "learnings": true,
  "instructions": "Always run `pnpm test` before reporting success."
}
```

### Other top-level keys

`fallbacks`, `includeDirectories` (extra sandbox paths), `mcpServers`, `sessions`
(`persist`, `retentionDays`, `dir`).

## Environment variables

| Variable | Effect |
| --- | --- |
| `BLUEBIRD_ENDPOINT`, `BLUEBIRD_MODEL`, `BLUEBIRD_PROVIDER`, `BLUEBIRD_API` | Override the endpoint form |
| `BLUEBIRD_API_KEY` | Fallback key |
| `BLUEBIRD_EFFORT` | `auto` or a level |
| `BLUEBIRD_PERMISSIONS` | Preset name |
| `BLUEBIRD_HOME` | Move `~/.bluebird` |
| `BLUEBIRD_CONTEXT_WINDOW` | Override the detected window |
| `BLUEBIRD_DEBUG` | Verbose logs and stack traces |
| `NO_COLOR`, `FORCE_COLOR`, `COLUMNS` | Terminal rendering |

## CLI

```bash
bluebird config set endpoint https://host/v1
bluebird config set model gpt-5.6-terra
bluebird config set apiKey '${MY_KEY}'          # quoted so the shell leaves it alone
bluebird config set permissions.preset auto
bluebird config set ui.diff full --global
bluebird config get providers.azure.baseURL
bluebird config unset fallbacks
bluebird permissions allow 'bash(npm test:*)'
bluebird effort high
```

Dot paths map onto the JSON structure. Values are parsed as JSON when they look like it, so
`ui.diff` accepts strings and `context.compactAt` accepts numbers. Secrets are redacted in
`config list` output.
