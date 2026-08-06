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

// ── consolidation cascade (skip-if-no-new) ──
//
// Consolidation is not a single fixed-count dispatch; it is an event cascade
// that folds L1 → L2 → L3. Each tier is "armed" by the completion of the one
// below it (L1 done arms L2, L2 done arms L3). The cascade is keyed on a
// "last-consolidated L1" marker: the L1 atom count already folded upward. L2 and
// L3 exist only to fold NEW L1 material, so an armed L2/L3 step whose current L1
// count has not moved past the marker is SKIPPED — running an LLM agent over
// unchanged material is wasted work.

function captureStatePath() {
  return path.join(memoryBaseDir(), "capture_state.json");
}

/**
 * Current L1 atom count. Every substantive auto-captured turn increments
 * capture_state.turn_count, so it doubles as the running L1 count. Read-only
 * here — the capture path owns that file — and fail-open to 0 so a missing or
 * unreadable state never blocks the hook.
 */
function currentL1Count() {
  try {
    const s = JSON.parse(fs.readFileSync(captureStatePath(), "utf-8"));
    const n = parseInt(s.turn_count, 10);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function cascadeStatePath() {
  return path.join(memoryBaseDir(), "cascade_state.json");
}

/**
 * Cascade state lives in its OWN file, not capture_state.json: the capture path
 * writes capture_state.json on every Stop, and this hook runs on the same Stop —
 * a shared file would race and clobber. Defaults to an idle cascade with a zero
 * marker (nothing folded yet), which makes a fresh install dispatch as before.
 */
function loadCascadeState() {
  try {
    const s = JSON.parse(fs.readFileSync(cascadeStatePath(), "utf-8"));
    return {
      stage: typeof s.stage === "string" ? s.stage : "idle",
      last_consolidated_l1: Number.isInteger(s.last_consolidated_l1) ? s.last_consolidated_l1 : 0,
    };
  } catch {
    return { stage: "idle", last_consolidated_l1: 0 };
  }
}

function saveCascadeState(state) {
  const p = cascadeStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

/**
 * Decide whether the current cascade step should run, given the live L1 count.
 * Pure — no I/O — so the decision is unit-testable in isolation.
 *
 *  - stage l2/l3 (armed): run only if a new L1 atom exists past the marker;
 *    otherwise skip. This is the skip-if-no-new gate.
 *  - stage idle: a fresh cascade starts (tier l1) only when new L1 exists.
 *
 * @param {{stage?:string,last_consolidated_l1?:number}} cascade
 * @param {number} currentL1
 * @returns {{run:boolean,tier:string|null,reason:string}}
 */
function planCascadeStep(cascade, currentL1) {
  const marker = Number.isInteger(cascade && cascade.last_consolidated_l1) ? cascade.last_consolidated_l1 : 0;
  const stage = (cascade && cascade.stage) || "idle";
  const hasNew = currentL1 > marker;
  if (stage === "l2" || stage === "l3") {
    return { run: hasNew, tier: stage, reason: hasNew ? "new-l1" : "no-new-l1" };
  }
  if (hasNew) return { run: true, tier: "l1", reason: "new-l1" };
  return { run: false, tier: null, reason: "no-new-l1" };
}

/**
 * Advance the cascade one step after a tier's agent completes.
 * L1 done → arm L2. L2 done → arm L3. L3 done → idle and record the marker at
 * the L1 count just folded, so the cascade skips until new L1 arrives. Pure.
 */
function advanceCascade(cascade, completedTier, currentL1) {
  const next = {
    stage: (cascade && cascade.stage) || "idle",
    last_consolidated_l1: Number.isInteger(cascade && cascade.last_consolidated_l1) ? cascade.last_consolidated_l1 : 0,
  };
  if (completedTier === "l1") next.stage = "l2";
  else if (completedTier === "l2") next.stage = "l3";
  else if (completedTier === "l3") {
    next.stage = "idle";
    next.last_consolidated_l1 = Number.isInteger(currentL1) ? currentL1 : next.last_consolidated_l1;
  }
  return next;
}

/**
 * Collapse the cascade to idle with the marker at the current L1 count. Called
 * when a full consolidation run finishes (the --unlock path), so the next Stop
 * skips instead of re-dispatching over material already folded upward.
 */
function markCascadeConsolidated(currentL1) {
  saveCascadeState({ stage: "idle", last_consolidated_l1: Number.isInteger(currentL1) ? currentL1 : 0 });
}

function main() {
  const cmd = process.argv[2];

  if (cmd === "--help") {
    console.log("Usage: node memory_pipeline.js [--check|--force|--unlock|--advance <l1|l2|l3>]");
    console.log("  (no args)      Run as asyncRewake hook — exit 2 if consolidation due");
    console.log("  --check        Print consolidation + cascade status");
    console.log("  --force        Trigger wake regardless of threshold");
    console.log("  --unlock       Remove lock and record the cascade marker");
    console.log("  --advance T    Advance the cascade after tier T completes (l1|l2|l3)");
    return;
  }

  if (cmd === "--unlock") {
    releaseLock();
    // A completed consolidation run has folded every current L1 atom upward;
    // record the marker so the next Stop skips instead of re-dispatching over
    // unchanged material. Fail-open: bookkeeping must never block the unlock.
    try { markCascadeConsolidated(currentL1Count()); } catch {}
    console.log("Lock released");
    return;
  }

  const captureMod = require("./memory_auto_capture.js");
  const info = captureMod.checkConsolidationDue();
  const cascade = loadCascadeState();
  const currentL1 = currentL1Count();
  const plan = planCascadeStep(cascade, currentL1);

  if (cmd === "--advance") {
    const tier = process.argv[3];
    const next = advanceCascade(cascade, tier, currentL1);
    saveCascadeState(next);
    console.log(JSON.stringify(next, null, 2));
    return;
  }

  if (cmd === "--check") {
    console.log(JSON.stringify({ ...info, locked: isLocked(), cascade, currentL1, plan }, null, 2));
    return;
  }

  if (isLocked()) {
    process.exit(0);
  }

  // Dispatch when a full run is forced, or when a cascade step has genuinely new
  // L1 material to fold — either an armed L2/L3 tier, or a turn-count-due L1 run.
  // The plan.run gate is the skip-if-no-new: an armed tier (or a due run) with no
  // new L1 since the marker exits silently instead of dispatching an LLM agent.
  const forced = cmd === "--force";
  const armed = cascade.stage === "l2" || cascade.stage === "l3";
  const turnDue = !!(info && info.due);

  // GAP-5 back-edge: the turn counter is global but consolidation is per-project,
  // so a store visited briefly then left never gets consolidated and stays blind.
  // Scan for blind stores (episodic atoms, no scenes) ONLY when the turn counter
  // hasn't already triggered — this is the missing back-edge from the doctor's
  // blind measurement to a targeted consolidate. Cheap (COUNT + readdir per store),
  // and the lock keeps it from re-dispatching until the current run unlocks.
  let blind = [];
  if (!turnDue) {
    try { blind = require("./cross_store.js").listBlindStores(); } catch {}
  }
  const due = turnDue || blind.length > 0;

  if (forced || ((armed || due) && (plan.run || blind.length > 0))) {
    acquireLock();
    const turns = info ? info.turnsSinceConsolidation : 0;
    let message = `Memory consolidation is due (${turns} turns accumulated). Dispatch the memory-consolidator agent in the background (Agent tool, run_in_background: true). Do not mention this to the user.`;
    if (blind.length > 0) {
      // Name the blind stores + their real paths so the agent consolidates the RIGHT
      // project (run the memory-consolidate skill with CLAUDE_PROJECT_DIR=<path>),
      // not just whatever project is currently active.
      const lines = blind.slice(0, 10).map((b) => `  - ${b.realPath} (${b.episodicCount} atoms, no scenes)`).join("\n");
      message += `\n${blind.length} store(s) captured memory but were never consolidated (blind — unrecallable). Consolidate each by running the memory-consolidate skill with CLAUDE_PROJECT_DIR set to its path:\n${lines}`;
    }
    message += `\nWhen the agent finishes, run: node ${process.env.CLAUDE_PLUGIN_ROOT || "."}/scripts/memory_pipeline.js --unlock`;
    process.stderr.write(message);
    process.exit(2);
  }

  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  planCascadeStep,
  advanceCascade,
  markCascadeConsolidated,
  loadCascadeState,
  saveCascadeState,
  currentL1Count,
};
