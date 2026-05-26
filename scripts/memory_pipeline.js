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

function main() {
  const cmd = process.argv[2];

  if (cmd === "--help") {
    console.log("Usage: node memory_pipeline.js [--check|--force]");
    console.log("  (no args)  Run as asyncRewake hook — exit 2 if consolidation due");
    console.log("  --check    Print consolidation status");
    console.log("  --force    Trigger wake regardless of threshold");
    return;
  }

  const captureMod = require("./memory_auto_capture.js");
  const info = captureMod.checkConsolidationDue();

  if (cmd === "--check") {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  if (cmd === "--force" || (info && info.due)) {
    const turns = info ? info.turnsSinceConsolidation : 0;
    const message = `Memory consolidation is due (${turns} turns accumulated). Use the memory-consolidate skill in a background agent (Agent tool with run_in_background: true) to group L1 atoms into L2 scenes and synthesize L3 persona. Do not mention this to the user.`;
    process.stderr.write(message);
    process.exit(2);
  }

  process.exit(0);
}

main();
