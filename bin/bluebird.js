#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");

// A checkout runs the TypeScript sources directly, so editing them takes effect
// immediately and a stale dist/ can never be picked up. Installed packages have
// no sources — Node refuses to strip types inside node_modules — so they run the
// compiled output that `npm run build` (and prepack) produces.
const source = path.join(packageRoot, "src", "cli.ts");
const compiled = path.join(packageRoot, "dist", "cli.js");
const entry = fs.existsSync(source) ? source : compiled;

if (!fs.existsSync(entry)) {
  process.stderr.write(
    `\n  Blue Bird has no sources and no build at ${packageRoot}.\n` +
      `  From a checkout, run: npm install --include=dev && npm run build\n\n`,
  );
  process.exit(1);
}

if (entry === source && (major < 22 || (major === 22 && minor < 18))) {
  process.stderr.write(
    `\n  Running Blue Bird from source needs Node.js 22.18 or newer (found ${process.versions.node}).\n` +
      `  Build the compiled output instead with \`npm run build\`.\n\n` +
      `  Upgrade with: nvm install 22 && nvm use 22\n\n`,
  );
  process.exit(1);
}

process.title = "bluebird";

try {
  await import(entry);
} catch (error) {
  if (error && error.code === "ERR_UNKNOWN_FILE_EXTENSION") {
    process.stderr.write(
      `\n  This Node.js build cannot execute TypeScript (${process.versions.node}).\n` +
        `  Run \`npm run build\` and use the compiled entry point, or re-run with:\n` +
        `    node --experimental-strip-types ${entry}\n\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`\n  Blue Bird failed to start:\n  ${error?.stack ?? error}\n\n`);
  process.exit(1);
}
