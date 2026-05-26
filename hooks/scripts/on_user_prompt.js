#!/usr/bin/env node
/**
 * UserPromptSubmit hook — recall from Gateway + local FTS5, inject via additionalContext.
 *
 * Tries Gateway /recall first (if available). Falls back to local FTS5 search.
 * On any failure exits 0 with empty output so the user's turn is never blocked.
 */
"use strict";

const nodePath = require("node:path");
const { addPluginScriptsToPath, readHookInputAsync, sessionKey, emit } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();

async function gatewayRecall(prompt, sk) {
  try {
    const { GatewayClient, breakerOpen } = require(nodePath.join(scriptsDir, "gateway_client.js"));
    if (breakerOpen()) return "";
    const resp = await new GatewayClient(undefined, 5000).recall(prompt, sk);
    const ctx = resp?.context || resp?.prependContext || "";
    return String(ctx).trim();
  } catch {
    return "";
  }
}

function localRecall(prompt, cwd) {
  try {
    const { projectHashForCwd } = require(nodePath.join(scriptsDir, "memory_reader.js"));
    const { recall } = require(nodePath.join(scriptsDir, "memory_recall.js"));
    const projectHash = cwd ? projectHashForCwd(cwd) : "";
    return recall(prompt, projectHash);
  } catch {
    return "";
  }
}

async function main() {
  const payload = await readHookInputAsync();
  const prompt = payload.prompt || payload.user_prompt || "";
  if (!prompt.trim()) { emit({}); return; }

  const sk = sessionKey(payload);
  const cwd = payload.cwd || "";

  let ctx = await gatewayRecall(prompt, sk);
  if (!ctx) ctx = localRecall(prompt, cwd);

  if (!ctx) { emit({}); return; }

  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } });
}

main().catch(() => { emit({}); process.exit(0); });
