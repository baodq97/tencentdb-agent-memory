/**
 * Shared helpers for the three hook entrypoints.
 *
 * Keeps each hook script tiny — they only orchestrate; HTTP + circuit breaker
 * live in scripts/gateway_client.js.
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

function readHookInput() {
  try {
    const chunks = [];
    const fd = require("node:fs").openSync("/dev/stdin", "r");
    const buf = Buffer.alloc(65536);
    let n;
    while ((n = require("node:fs").readSync(fd, buf)) > 0) chunks.push(buf.slice(0, n));
    require("node:fs").closeSync(fd);
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
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

function sessionKey(hookPayload) {
  const sid = hookPayload.session_id || process.env.CLAUDE_SESSION_ID || "default";
  return `claude-code:${sid}`;
}

function emit(out) {
  process.stdout.write(JSON.stringify(out));
}

module.exports = { addPluginScriptsToPath, readHookInput, readHookInputAsync, sessionKey, emit };
