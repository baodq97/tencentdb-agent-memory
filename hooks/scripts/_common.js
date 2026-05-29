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
    let settled = false;
    const parse = () => { try { return data.trim() ? JSON.parse(data) : {}; } catch { return {}; } };
    const done = (val) => { if (settled) return; settled = true; clearTimeout(timer); resolve(val); };
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => done(parse()));
    process.stdin.on("error", () => done({}));
    // Fallback if stdin never closes. Cleared on end/error; unref'd so it never
    // pins the event loop (the dangling, un-cleared timer here used to add ~3s/turn).
    const timer = setTimeout(() => done(parse()), 3000);
    timer.unref();
  });
}

function emit(out) {
  process.stdout.write(JSON.stringify(out));
}

module.exports = { addPluginScriptsToPath, readHookInputAsync, emit };
