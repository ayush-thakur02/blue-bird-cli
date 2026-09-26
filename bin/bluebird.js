#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(
    `\n  Blue Bird requires Node.js 22.18 or newer (found ${process.versions.node}).\n` +
      `  It runs TypeScript natively through Node's type stripping — no build step required.\n\n` +
      `  Upgrade with: nvm install 22 && nvm use 22\n\n`,
  );
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "cli.ts");

process.title = "bluebird";

try {
  await import(entry);
} catch (error) {
  if (error && error.code === "ERR_UNKNOWN_FILE_EXTENSION") {
    process.stderr.write(
      `\n  This Node.js build cannot execute TypeScript (${process.versions.node}).\n` +
        `  Re-run with: node --experimental-strip-types ${entry}\n\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`\n  Blue Bird failed to start:\n  ${error?.stack ?? error}\n\n`);
  process.exit(1);
}
