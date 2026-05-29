#!/usr/bin/env node
/**
 * UserPromptSubmit hook — hybrid recall (FTS5 + vector), inject via additionalContext.
 */
"use strict";

const nodePath = require("node:path");
const { addPluginScriptsToPath, readHookInputAsync, emit } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();

async function doRecall(prompt, cwd) {
  try {
    try {
      const { ensureDaemon } = require(nodePath.join(scriptsDir, "embed_client.js"));
      ensureDaemon();
    } catch {}

    const { projectHashForCwd } = require(nodePath.join(scriptsDir, "memory_reader.js"));
    const projectHash = cwd ? projectHashForCwd(cwd) : "";

    try {
      const { recallAsync } = require(nodePath.join(scriptsDir, "memory_recall.js"));
      return await recallAsync(prompt, projectHash);
    } catch {}

    const { recall } = require(nodePath.join(scriptsDir, "memory_recall.js"));
    return recall(prompt, projectHash);
  } catch {
    return "";
  }
}

async function main() {
  const payload = await readHookInputAsync();
  const prompt = payload.prompt || payload.user_prompt || "";
  if (!prompt.trim()) { emit({}); return; }

  const cwd = payload.cwd || "";
  const ctx = await doRecall(prompt, cwd);

  if (!ctx) { emit({}); return; }

  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } });
}

main().catch(() => { emit({}); process.exit(0); });
