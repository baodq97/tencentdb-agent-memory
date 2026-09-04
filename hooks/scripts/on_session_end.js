#!/usr/bin/env node
/**
 * SessionEnd hook — save session metadata as "pending" for later extraction.
 * Must be fast — session is ending, process may be killed at any time.
 */
"use strict";

const nodePath = require("node:path");
const { addPluginScriptsToPath } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();

let data = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", chunk => { data += chunk; });
process.stdin.on("end", run);
process.stdin.on("error", run);
setTimeout(run, 1500);

/**
 * The SESSION-BOUNDARY arm of the consolidation trigger.
 *
 * A counter alone cannot serve this population: measured over 14 days of real
 * traffic the median session is 4 turns, so a project whose sessions are short
 * never accumulates enough to fire at any threshold — 33.5% of turns were never
 * consolidated under the counter that shipped before this. The session boundary
 * is the only predicate that reaches them, and it takes that figure to 1.9%.
 *
 * Everything here is fire-and-forget. The spawn is detached and unref'd, so this
 * returns in milliseconds and stays inside the SessionEnd budget; the work
 * outlives the session because a session that is ending cannot be asked to wait
 * for it. Any failure is swallowed: a session must never fail to end because
 * memory wanted to think.
 */
function maybeConsolidate(projectHash, cwd) {
  try {
    const cap = require(nodePath.join(scriptsDir, "memory_auto_capture.js"));
    if (!cap.getAutoConsolidate()) return;

    // The REAL slot, not one reconstructed from status()'s derived numbers: that
    // version had to invert arithmetic status() had already done and hardcoded
    // warmup_threshold, discarding the store's actual warmup state.
    const trigger = cap.consolidationTrigger(cap.getSlot(projectHash), { sessionEnding: true });
    if (!trigger) return;

    const { spawnDetachedRunner } = require(nodePath.join(scriptsDir, "consolidate_runner.js"));
    spawnDetachedRunner({ hash: projectHash, projectDir: cwd || process.cwd(), trigger });
  } catch { /* never block the end of a session */ }
}

let ran = false;
function run() {
  if (ran) return;
  ran = true;

  try {
    const payload = data.trim() ? JSON.parse(data) : {};
    const sid = payload.session_id || "";
    const cwd = payload.cwd || "";
    const { projectHashForCwd } = require(nodePath.join(scriptsDir, "memory_reader.js"));
    const projectHash = cwd ? projectHashForCwd(cwd) : "";
    if (sid) {
      const { updateState } = require(nodePath.join(scriptsDir, "memory_writer.js"));
      updateState(sid, projectHash, "pending");
    }
    maybeConsolidate(projectHash, cwd);
  } catch {}

  process.stdout.write("{}");
}
