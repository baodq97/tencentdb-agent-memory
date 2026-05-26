#!/usr/bin/env node
/**
 * SessionEnd hook — save session metadata as "pending" for later extraction.
 */
"use strict";

const { addPluginScriptsToPath, readHookInputAsync, emit } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();

async function savePendingSession(payload) {
  try {
    const { updateState } = require(require("node:path").join(scriptsDir, "memory_writer.js"));
    const { projectHashForCwd } = require(require("node:path").join(scriptsDir, "memory_reader.js"));

    const sid = payload.session_id || "";
    if (!sid) return;

    const cwd = payload.cwd || "";
    const projectHash = cwd ? projectHashForCwd(cwd) : "";

    updateState(sid, projectHash, "pending");
  } catch {}
}

async function main() {
  const payload = await readHookInputAsync();
  savePendingSession(payload);
  emit({});
}

main().catch(() => { emit({}); process.exit(0); });
