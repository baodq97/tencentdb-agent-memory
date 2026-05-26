/**
 * Shared helpers for hook entrypoints.
 */
"use strict";

const path = require("node:path");

function addPluginScriptsToPath() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..", "..");
  const scriptsDir = path.join(pluginRoot, "scripts");
  if (!module.paths.includes(scriptsDir)) {
    module.paths.unshift(scriptsDir);
  }
  return scriptsDir;
}

function readHookInputAsync() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try { resolve(data.trim() ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    process.stdin.on("error", () => resolve({}));
    setTimeout(() => resolve(data.trim() ? JSON.parse(data) : {}), 3000);
  });
}

function emit(out) {
  process.stdout.write(JSON.stringify(out));
}

module.exports = { addPluginScriptsToPath, readHookInputAsync, emit };
