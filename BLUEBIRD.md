# blue-bird-cli

Blue Bird is a zero-dependency coding agent harness for the terminal. This file is read by the
agent at the start of every session.

## Commands

- `npm run typecheck` — `tsc --noEmit` (strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`)
- `npm test` — `node --test test/*.test.ts`
- `npm run verify` — both
- `npm run build` — `tsc -p tsconfig.build.json` → `dist/` (the published entry points)
- `node src/cli.ts --help` — run the CLI from source
- `npm run release -- patch|minor|major|<version> [--dry-run]` — bump, changelog, commit, tag
- `npm run pack:check` — the file list npm would publish
- `npm link` / `bb link` — make `bb` work in every directory

Note: `npm install` needs `--include=dev` in environments where `NODE_ENV=production`.

## Rules

- **Runtime dependencies are banned.** Node builtins only. TypeScript and @types/node are dev-only.
- **No build step for development, a build for publishing.** Node 22.18+ strips types from `.ts` files,
  so imports must end in `.ts` and the code must stay erasable: no enums, no namespaces, no parameter
  properties. `npm run build` (`tsconfig.build.json`) emits `dist/` with
  `rewriteRelativeImportExtensions`, which is what the published tarball ships — Node refuses to strip
  types inside `node_modules`, so an installed copy cannot run from source.
- `import type` for type-only imports (`verbatimModuleSyntax` is on; a value import of a type fails).
- Layering: `util` → `config`/`core`/`tools`/`providers` → `ui` → `commands` → `cli`. Nothing in
  `util` may import from `core`, and `config/schema.ts` must not import from `core`.
- Keep comments rare and useful. JSDoc on exported APIs, nothing that restates the code.
- Every user-visible failure needs an actionable hint: use `BlueBirdError` with a `hint`.

## Where things live

| Area | Path |
| --- | --- |
| Agent loop, context engine, prompts | `src/core/` |
| Tool registry and implementations | `src/tools/` |
| Provider adapters (openai/anthropic/responses) | `src/providers/` |
| Terminal rendering, markdown, diffs | `src/ui/` |
| Terminal restore + signal teardown | `src/ui/terminal.ts` |
| CLI commands and slash commands | `src/commands/` |
| Config schema and layered loading | `src/config/` |
| `.env` parsing, loading and writes | `src/config/env-file.ts` |
| Registry check and background self-update | `src/core/update.ts` |
| npm prefix / npm invocation helpers | `src/util/npm.ts` |
| Release driver (version, changelog, tag) | `scripts/release.mjs` |
| Image detection and encoding | `src/util/images.ts` |

## Invariants worth protecting

- **Cache-friendly prompts.** The system prompt and tool list must stay byte-identical between turns,
  otherwise provider prompt caching silently stops working. Cache hints live in `src/providers/caching.ts`.
- **1M default window.** `DEFAULT_CONTEXT_WINDOW` is 1,000,000; anything that reads it must also
  handle `model.assumedWindow` so the user can tell an assumption from a declaration.
- **Images never leak into text.** Base64 payloads stay out of tool output, transcripts and logs;
  only `ImageAttachment` carries them.
- **`.env` writes are surgical.** `upsertEnvVar` updates the existing line for a key instead of
  appending a duplicate and leaves an identical value untouched; `.env` values never override the
  process environment.
- **The version lives in three files.** `package.json`, `src/version.ts` and `package-lock.json` are
  bumped together (by `scripts/release.mjs`) and `test/release.test.ts` fails when they drift.
- **Nothing is drawn over the input box.** `Screen.drawInputBox` leaves the cursor on a known row inside
  the block and `clearInput` moves back by exactly that offset; anything printed out of band goes
  through `InputController.printAbove`. `test/ui-input.test.ts` replays the escape sequences and fails
  when a redraw moves the box.
- **Only npm's own install may self-update.** `update.skipReason` refuses checkouts, CI, non-terminals
  and opt-outs, and the background install runs only when the running copy sits in the npm global
  prefix (`src/core/update.ts`).

## Testing

Tests use `node:test` with no framework. Behaviour worth protecting: edit fuzzy matching (exact →
indentation → whitespace, and the strategy is reported), permission rule matching and workspace
containment (symlink-aware), context compaction planning, wire-format conversions, markdown
streaming parity with the one-shot renderer, and ANSI width/wrapping. `test/reliability.test.ts`
covers the failure paths: checkpoint arm/capture/commit ordering, cancellation, provider failover,
hook events, atomic writes that preserve file mode, and grapheme-safe editing.
