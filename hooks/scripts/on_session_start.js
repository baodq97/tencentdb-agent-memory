#!/usr/bin/env node
/**
 * SessionStart hook — keep the global `tmem` shim in sync with the loaded plugin.
 *
 * Runs once per session with $CLAUDE_PLUGIN_ROOT set to the version Claude Code
 * loaded. Idempotent + safe: installs the launcher when missing, refreshes a stale
 * shim of ours, and NEVER clobbers a foreign file the user owns. Fully best-effort:
 * any failure is swallowed so it can never disrupt a session.
 */
"use strict";

try {
  const path = require("node:path");
  const { ensureLauncherInstalled } = require(path.join(__dirname, "..", "..", "scripts", "tmem.js"));
  ensureLauncherInstalled(); // silent on success; result intentionally unused
} catch { /* never break the session */ }
