#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");

// Installed packages run the compiled output, because Node refuses to strip
// types from files inside node_modules. A checkout runs the TypeScript sources
// directly through native type stripping, so `bb link` needs no build.
const compiled = path.join(packageRoot, "dist", "cli.js");
const source = path.join(packageRoot, "src", "cli.ts");
const entry = fs.existsSync(compiled) ? compiled : source;

if (!fs.existsSync(entry)) {
  process.stderr.write(
    `\n  Blue Bird has no build and no sources at ${source}.\n` +
      `  From a checkout, run: npm install --include=dev && npm run build\n\n`,
  );
  process.exit(1);
}

if (entry === source && (major < 22 || (major === 22 && minor < 18))) {
  process.stderr.write(
    `\n  Running Blue Bird from source needs Node.js 22.18 or newer (found ${process.versions.node}).\n` +
      `  The published package ships compiled JavaScript; source checkouts run TypeScript natively.\n\n` +
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
