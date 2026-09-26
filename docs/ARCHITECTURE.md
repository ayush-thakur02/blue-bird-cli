# Architecture

Blue Bird is a harness: the part of a coding agent that decides what the model sees, what it is
allowed to do, and how a long task survives contact with a finite context window.

```
src/
├── cli.ts                  argument parsing, command dispatch
├── runtime.ts              assembles config + providers + tools + session + agent
├── commands/               one module per CLI command and the in-session slash commands
├── config/                 schema, layered loading, validation, redaction
├── providers/              transport + per-dialect adapters (chat, responses, anthropic, mock)
├── core/                   the harness: agent loop, context, permissions, sessions, extensions
├── tools/                  the tool registry and implementations
├── ui/                     ANSI, theme, markdown, highlight, diff, screen, input, renderer
└── util/                   text, paths, tokens, ignore/walk, logger, errors, ids
```

## The turn

1. **Input** arrives from the line editor. `@file` mentions are expanded, `!cmd` runs directly,
   `#note` appends to `BLUEBIRD.md`, `/slash` commands are handled in-process.
2. **Effort** is resolved: a fixed level, or `auto`, which classifies the prompt by shape (lookups →
   `minimal`, small edits → `low`, multi-file or design work → `high`, explicit care → `xhigh`) and
   escalates when tools keep failing.
3. **Context is checked.** Token estimates come from a calibrated heuristic (no tokenizer
   dependency). Past `context.compactAt` the engine folds old turns into a summary and prunes stale
   tool output.
4. **The provider streams** text, reasoning and tool calls. `src/providers/transport.ts` handles SSE
   framing, idle timeouts, retry-after, and endpoints that answer with plain JSON instead of a
   stream. Each dialect adapter maps the internal message model to the wire format and back.
5. **Tool calls execute.** Read-only, concurrency-safe calls run in parallel batches (up to 6);
   mutating calls run in order. Every call passes the permission engine and the `tool.before` /
   `tool.after` hooks. Failures are returned to the model as text, not thrown.
6. **Results are appended** and the loop repeats until the model stops calling tools, the turn cap is
   reached, or the user interrupts. `max_tokens` truncation can auto-continue.

## Context management

| Mechanism | Where | What it does |
| --- | --- | --- |
| Token estimation | `core/context.ts`, `util/tokens.ts` | Message-level estimates with framing overhead; images are priced by area (Anthropic's /750 rule vs OpenAI's tiles, whichever is smaller) |
| Window resolution | `config/load.ts`, `core/agent.ts` | Model → provider → env → `context.assumeWindow` → 1,000,000 |
| Tool output budget | `tools/registry.ts` | Truncates oversized results head+tail before they enter history |
| Stale pruning | `core/context.ts: pruneToolResults` | Replaces old tool bodies with a stub and drops attached images |
| Compaction | `core/agent.ts: compact` | Model-written handover note, deterministic fallback, first user message preserved |
| Overflow recovery | `core/agent.ts: recoverFromOverflow` | On a provider "prompt too long" error: halve the effective window, compact harder, retry (up to three times) |
| Loop guard | `core/agent.ts: trackRepeats` | Injects a corrective reminder on the third identical call |

## Permissions

`core/permissions.ts` evaluates in a fixed order: session denials → deny rules → catastrophic guard →
session grants → allow rules → preset behaviour → user prompt. Rules use `Tool(spec)` syntax with
glob or `prefix:*` matching against the command text, the target paths, or both.

Presets:

| Preset | Reads | Edits | Shell | Notes |
| --- | --- | --- | --- | --- |
| `read-only` | allow | deny | deny (except trivial read-only commands) | for plan mode and reviews |
| `ask` | allow | ask | ask | default |
| `edits` | allow | allow in workspace | allow for a known-safe command list, ask otherwise | |
| `auto` | allow | allow | allow unless risky or outside the workspace | |
| `danger-full-access` | allow | allow | allow | still blocks catastrophic patterns |

## Prompt caching

Caching is a first-class part of the request builder, not an afterthought, because a cached prefix is
the difference between a cheap long session and an expensive one.

| Dialect | Mechanism |
| --- | --- |
| `anthropic-messages` | Up to four `cache_control: ephemeral` breakpoints: system prompt, last tool definition, and the two most recent conversation turns. Each turn extends the cached prefix (`cache_read_input_tokens`, `cache_creation_input_tokens` come back in usage). |
| `openai-completions` | `prompt_cache_key` derived from `hash(sessionId + modelId)` so every turn of a session lands on the same cache shard, plus `prompt_cache_retention: "24h"` on hosts that accept it. Hits arrive in `prompt_tokens_details.cached_tokens`. |
| `openai-responses` | Same cache key, plus the provider's automatic prefix caching. |
| DeepSeek-style usage | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` are folded into the same accounting. |
| Any other gateway | Automatic prefix caching; Blue Bird simply keeps the prefix stable. |

`src/providers/caching.ts` owns the policy. Two properties make it safe to be aggressive:

1. **Stability first.** The system prompt, tool definitions and message history are byte-identical
   between turns, so the prefix is genuinely reusable. The system prompt is cached until something
   that affects it changes (memory, plan mode, tool set, model).
2. **Rejections are remembered.** If an endpoint answers 400 for a cache parameter, the adjustment
   ladder records it per provider and later requests omit it — the cost of an incompatible gateway
   is one extra request per process, not one per turn.

Cache metrics flow from the provider into `Usage`, through the session, into `/cost`, `/context`
and the `cache NN%` status segment, so the benefit is visible rather than assumed.

## Vision

Images travel through the same message model as everything else.

```
@shot.png  ─┐
            ├─▶ ImageAttachment ─▶ Block{type:"image"} ─▶ provider serializer
view_image ─┘        (base64, media type, dimensions)
```

- `src/util/images.ts` sniffs magic bytes (PNG/JPEG/GIF/WebP), reads dimensions from the headers,
  enforces `images.maxBytes`, and encodes base64.
- The `view_image` tool (`src/tools/image.ts`) and `@image` mentions share `imageResult()`, so limits,
  warnings and workspace rules are identical. `read` on an image file routes to the same path.
- Each dialect serialises images natively: `image_url` parts for chat completions (with a follow-up
  user message when the image came from a tool, since `role: tool` is text-only), `image` blocks
  inside `tool_result` for Anthropic, `input_image` for the Responses API.
- Vision capability is declared (`supportsImages`) or inferred from the model id. The `view_image`
  tool is hidden for text-only models; explicitly attached images are optimistically passed through,
  and stale images are dropped during compaction instead of being re-sent forever.

## Sessions, checkpoints, extensions

- **Sessions** are append-only JSONL transcripts plus a small meta file under `.bluebird/sessions/`,
  indexed globally in `~/.bluebird/sessions.json` so `bluebird resume <id>` works from anywhere.
- **Checkpoints** capture the pre-edit content of a file (≤2 MB) the first time a turn touches it;
  `/undo` restores the most recent one and removes it from the list.
- **Extensions** are markdown-with-frontmatter files: skills, commands and agents load from
  `.bluebird/…` and `~/.bluebird/…`, commands shadowing globally and agents merging with the three
  built-ins (`explore`, `general`, `plan`).
- **Hooks** are shell commands that receive a JSON payload on stdin and may return
  `{"blocked":true,"reason":"…"}` or `{"context":"…"}`.

## UI

Rendering is centralised in `ui/screen.ts` so the transcript, the activity line and the input box
never fight over the cursor. Assistant text streams through a line-oriented markdown renderer that
keeps state across chunks, so streamed output is identical to the final render. The line editor
(`ui/input.ts`) runs in raw mode with history, completion, multiline, bracketed paste, and a
single-key prompt used for permission confirmations. When stdout is not a TTY every UI call degrades
to plain text, which is how `run`, pipes and CI work.

## Provider compatibility

Blue Bird adapts rather than assumes:

- **Auth**: `Authorization: Bearer`, `api-key` (Azure), or `x-api-key` (Anthropic), chosen per host.
- **Compatibility ladder**: on a 400 that names an unsupported field, the request is retried without
  it (`reasoning_effort`, `temperature`, `stream_options`, `parallel_tool_calls`, `tools`, …) and
  `max_tokens` is swapped for `max_completion_tokens` when the endpoint asks for it.
- **Effort mapping**: Anthropic → `thinking.budget_tokens` (1k…32k by level); OpenAI-compatible →
  `reasoning_effort`; responses → `reasoning: { effort }`; unsupported models ignore it.
- **Fallbacks**: `fallbacks: ["other-provider/model"]` are tried when the primary is exhausted.

## Failure model

Every error is a `BlueBirdError` with a `code`, an optional actionable `hint`, and a `retryable`
flag. Provider errors surface as `HTTP <status>: <body>` plus guidance; tool errors are returned to
the model as text so it can adapt; permission denials explain which rule or preset blocked the call.
`bluebird doctor` reproduces configuration, credential and connectivity checks outside a session.
