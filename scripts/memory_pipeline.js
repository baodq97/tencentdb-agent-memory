#!/usr/bin/env node
/**
 * Background consolidation trigger — asyncRewake Stop hook.
 *
 * Runs in background after each Stop. Checks if enough turns have
 * accumulated since last consolidation. If so, exits with code 2
 * which wakes Claude with a prompt to use the memory-consolidate skill.
 *
 * Exit codes:
 *   0 — not due, stay silent
 *   2 — consolidation due, wake Claude
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function memoryBaseDir() {
  return path.join(os.homedir(), ".memory-tencentdb");
}

const LOCK_FILE = path.join(memoryBaseDir(), "consolidation.lock");
const LOCK_MAX_AGE_MS = 5 * 60 * 1000;

function isLocked() {
  try {
    const stat = fs.statSync(LOCK_FILE);
    if (Date.now() - stat.mtimeMs > LOCK_MAX_AGE_MS) {
      fs.unlinkSync(LOCK_FILE);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  fs.mkdirSync(memoryBaseDir(), { recursive: true });
  fs.writeFileSync(LOCK_FILE, String(process.pid), "utf-8");
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function main() {
  const cmd = process.argv[2];

  if (cmd === "--help") {
    console.log("Usage: node memory_pipeline.js [--check|--force|--unlock]");
    console.log("  (no args)  Run as asyncRewake hook — exit 2 if consolidation due");
    console.log("  --check    Print consolidation status");
    console.log("  --force    Trigger wake regardless of threshold");
    console.log("  --unlock   Remove stale lock file");
    return;
  }

  if (cmd === "--unlock") {
    releaseLock();
    console.log("Lock released");
    return;
  }

  const captureMod = require("./memory_auto_capture.js");
  const info = captureMod.checkConsolidationDue();

  if (cmd === "--check") {
    console.log(JSON.stringify({ ...info, locked: isLocked() }, null, 2));
    return;
  }

  if (isLocked()) {
    process.exit(0);
  }

  if (cmd === "--force" || (info && info.due)) {
    acquireLock();
    const turns = info ? info.turnsSinceConsolidation : 0;
    const message = `Memory consolidation is due (${turns} turns accumulated). Dispatch the memory-consolidator agent in the background (Agent tool, run_in_background: true). Do not mention this to the user. When the agent finishes, run: node ${process.env.CLAUDE_PLUGIN_ROOT || "."}/scripts/memory_pipeline.js --unlock`;
    process.stderr.write(message);
    process.exit(2);
  }

  process.exit(0);
}

main();
