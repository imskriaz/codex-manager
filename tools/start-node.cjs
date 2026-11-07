#!/usr/bin/env node
const path = require("node:path");
const Module = require("node:module");

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === "--data-dir" && args[index + 1]) process.env.CODEX_MANAGER_STORAGE_ROOT = path.resolve(args[++index]);
  else if (value === "--port" && args[index + 1]) process.env.CODEX_MANAGER_PORT = args[++index];
  else if (value === "--host" && args[index + 1]) process.env.CODEX_MANAGER_HOST = args[++index];
}

const shim = path.join(__dirname, "node-vscode-shim");
process.env.NODE_PATH = [shim, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const entry = path.join(__dirname, "..", "out", "node.js");
try {
  const host = require(entry);
  if (typeof host.startNodeHost !== "function") throw new Error("The compiled Node host does not export startNodeHost().");
  void host.startNodeHost().catch(error => {
    console.error(`[codexManager] Node host failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
} catch (error) {
  console.error("Codex Manager Node host is not built. Run `npm run compile` first.");
  throw error;
}
