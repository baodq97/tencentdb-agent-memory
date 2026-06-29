#!/usr/bin/env node
/**
 * SessionStart hook — two best-effort jobs, neither of which may ever break a session:
 *
 *  1. Keep the global `tmem` shim in sync with the loaded plugin (idempotent + safe:
 *     installs when missing, refreshes a stale shim of ours, NEVER clobbers a foreign
 *     file the user owns).
 *  2. Detect legacy cwd-keyed fragment stores for the CURRENT project and surface a
 *     one-line hint so the user can consolidate them with `tmem migrate-fragments`.
 *     We deliberately DO NOT auto-merge here — that mutates the user's memory, so the
 *     destructive step stays user-triggered. Detection is cheap (slug prefix compare,
 *     no filesystem probing) and runs once per session.
 */
"use strict";

const path = require("node:path");
const { emit } = require(path.join(__dirname, "_common.js"));

// 1) Shim self-heal — most important; runs regardless of detection below.
try {
  const { ensureLauncherInstalled } = require(path.join(__dirname, "..", "..", "scripts", "tmem.js"));
  ensureLauncherInstalled(); // silent on success; result intentionally unused
} catch { /* never break the session */ }

// 2) Fragmentation hint for the current project.
function fragmentHint() {
  try {
    const scriptsDir = path.join(process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..", ".."), "scripts");
    const { projectHashForCwd } = require(path.join(scriptsDir, "memory_reader.js"));
    const { listProjectHashes } = require(path.join(scriptsDir, "memory_writer.js"));
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const root = projectHashForCwd(cwd);
    if (!root) return "";
    // A fragment of this project is a store whose slug extends the root slug.
    const frags = listProjectHashes().filter((h) => h !== root && h.startsWith(root + "-"));
    if (!frags.length) return "";
    return `This project has ${frags.length} legacy cwd-keyed memory fragment store(s) (created before project-root keying) whose memories won't surface in recall. Suggest the user run \`tmem migrate-fragments\` (dry-run) then \`--apply\` to consolidate them into this project's store.`;
  } catch { return ""; }
}

const hint = fragmentHint();
if (hint) emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: hint } });
else emit({});
