#!/usr/bin/env node
/**
 * UserPromptSubmit hook — recall from local FTS5, inject via additionalContext.
 */
"use strict";

const nodePath = require("node:path");
const { addPluginScriptsToPath, readHookInputAsync, emit } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();

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

  const cwd = payload.cwd || "";
  const ctx = localRecall(prompt, cwd);

  if (!ctx) { emit({}); return; }

  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } });
}

main().catch(() => { emit({}); process.exit(0); });
