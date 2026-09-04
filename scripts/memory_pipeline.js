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

const { memoryBaseDir } = require("./memory_writer.js");

// ── per-project single-flight lock ──
//
// Lock is PER-PROJECT: `projects/<hash>/consolidation.lock`. Two DIFFERENT
// projects consolidate in parallel safely (their stores are disjoint); the lock
// only ever serializes runs on the SAME store.
//
// Acquire is ATOMIC (O_EXCL create), so there is no check-then-write TOCTOU — the
// create itself arbitrates the race between two Stop hooks firing at once.
//
// Staleness is TIME-based, deliberately NOT PID-based: the process that WRITES the
// lock is the Stop hook, which exits(2) immediately; the run it guards is a
// separate background agent whose pid the hook never knows. So the lock always
// outlives its writer — a PID-liveness check would read it as stale instantly. The
// TTL is the backstop for a run that dies without unlocking; it is generous (30
// min, TMEM_LOCK_TTL_MS-overridable) so a long-but-live cascade is never reclaimed
// mid-flight, unlike the old 5-minute cap that could double-dispatch.
const LOCK_TTL_MS = Math.max(60 * 1000, parseInt(process.env.TMEM_LOCK_TTL_MS || "", 10) || 30 * 60 * 1000);

function lockPath(hash) {
  return path.join(memoryBaseDir(), "projects", hash || "global", "consolidation.lock");
}

/** True if the lock file is older than the TTL backstop (or unreadable). */
function isStale(p) {
  try { return Date.now() - fs.statSync(p).mtimeMs > LOCK_TTL_MS; } catch { return true; }
}

function isLocked(hash) {
  const p = lockPath(hash);
  try { fs.statSync(p); } catch { return false; }
  if (isStale(p)) { try { fs.unlinkSync(p); } catch {} return false; }
  return true;
}

function writeLockFile(p) {
  const fd = fs.openSync(p, "wx"); // O_EXCL: fails if it already exists
  try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
  finally { fs.closeSync(fd); }
}

/** Atomically acquire the project lock. Returns true on success, false if held. */
function acquireLock(hash) {
  const p = lockPath(hash);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    writeLockFile(p);                   // O_EXCL: single winner on a fresh path
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!isStale(p)) return false;      // held by a live run — do not steal
    return reclaimStaleLock(p);
  }
}

/**
 * Reclaim a lock believed stale, race-safely. Unconditional unlink-then-create is
 * a TOCTOU: two reclaimers could each unlink the OTHER's fresh lock and both
 * create. Instead we CLAIM the stale file by renaming it aside — renameSync of a
 * given source is atomic, so of N concurrent reclaimers exactly one succeeds and
 * the rest get ENOENT and back off. We then re-check the claimed file: if it was
 * actually fresh (another reclaimer refreshed the lock between our isStale check
 * and the rename), we restore it and back off rather than steal a live lock.
 */
function reclaimStaleLock(p) {
  const claim = `${p}.stale.${process.pid}`;
  try {
    fs.renameSync(p, claim);
  } catch {
    return false; // lost the claim race (ENOENT) — someone else is reclaiming/holding
  }
  if (!isStale(claim)) {
    // We moved a lock that is actually live — put it back and yield.
    try { fs.renameSync(claim, p); } catch { try { fs.unlinkSync(claim); } catch {} }
    return false;
  }
  try { fs.unlinkSync(claim); } catch {}
  try { writeLockFile(p); return true; } catch { return false; }
}

function releaseLock(hash) {
  try { fs.unlinkSync(lockPath(hash)); } catch {}
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
 * Current L1 atom count for a PROJECT. Every substantive auto-captured turn
 * increments capture_state.projects[hash].turn_count, so the per-project counter
 * doubles as that project's running L1 count. Read-only here — the capture path
 * owns that file — and fail-open to 0 so a missing/unreadable state never blocks
 * the hook.
 */
function currentL1Count(hash) {
  try {
    const s = JSON.parse(fs.readFileSync(captureStatePath(), "utf-8"));
    const slot = s.projects && s.projects[hash || "global"];
    const n = parseInt(slot && slot.turn_count, 10);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function cascadeStatePath(hash) {
  return path.join(memoryBaseDir(), "projects", hash || "global", "cascade_state.json");
}

/**
 * Cascade state lives in its OWN file, not capture_state.json: the capture path
 * writes capture_state.json on every Stop, and this hook runs on the same Stop —
 * a shared file would race and clobber. Defaults to an idle cascade with a zero
 * marker (nothing folded yet), which makes a fresh install dispatch as before.
 */
function loadCascadeState(hash) {
  try {
    const s = JSON.parse(fs.readFileSync(cascadeStatePath(hash), "utf-8"));
    return {
      stage: typeof s.stage === "string" ? s.stage : "idle",
      last_consolidated_l1: Number.isInteger(s.last_consolidated_l1) ? s.last_consolidated_l1 : 0,
    };
  } catch {
    return { stage: "idle", last_consolidated_l1: 0 };
  }
}

function saveCascadeState(hash, state) {
  const p = cascadeStatePath(hash);
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
 * Collapse a project's cascade to idle with the marker at its current L1 count.
 * Called when a full consolidation run finishes (the --unlock path), so the next
 * Stop skips instead of re-dispatching over material already folded upward.
 */
function markCascadeConsolidated(hash, currentL1) {
  saveCascadeState(hash, { stage: "idle", last_consolidated_l1: Number.isInteger(currentL1) ? currentL1 : 0 });
}

/** The project this invocation targets: CLAUDE_PROJECT_DIR (a blind-store run) or the session cwd. */
function resolveHash() {
  try {
    const { projectHashForCwd } = require("./memory_reader.js");
    return projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  } catch {
    return "";
  }
}

function main() {
  const cmd = process.argv[2];

  if (cmd === "--help") {
    console.log("Usage: node memory_pipeline.js [--check|--force|--unlock|--advance <l1|l2|l3>]");
    console.log("  (no args)      Run as asyncRewake hook — exit 2 if consolidation due");
    console.log("  --check        Print consolidation + cascade status (current project)");
    console.log("  --force        Trigger wake regardless of threshold");
    console.log("  --unlock       Release this project's lock and record its cascade marker");
    console.log("  --advance T    Advance this project's cascade after tier T completes (l1|l2|l3)");
    console.log("  Project scope = CLAUDE_PROJECT_DIR or cwd. Lock/counter/cascade are per-project.");
    return;
  }

  const hash = resolveHash();

  if (cmd === "--unlock") {
    releaseLock(hash);
    // A completed consolidation run has folded every current L1 atom upward;
    // record the marker so the next Stop skips instead of re-dispatching over
    // unchanged material. Fail-open: bookkeeping must never block the unlock.
    try { markCascadeConsolidated(hash, currentL1Count(hash)); } catch {}
    console.log("Lock released");
    return;
  }

  const captureMod = require("./memory_auto_capture.js");
  const info = captureMod.checkConsolidationDue(hash);
  const cascade = loadCascadeState(hash);
  const currentL1 = currentL1Count(hash);
  const plan = planCascadeStep(cascade, currentL1);

  if (cmd === "--advance") {
    const tier = process.argv[3];
    const next = advanceCascade(cascade, tier, currentL1);
    saveCascadeState(hash, next);
    console.log(JSON.stringify(next, null, 2));
    return;
  }

  if (cmd === "--check") {
    console.log(JSON.stringify({ ...info, hash, locked: isLocked(hash), cascade, currentL1, plan }, null, 2));
    return;
  }

  // Active project: dispatch when forced, or when a cascade step has genuinely new
  // L1 material to fold (armed L2/L3, or a turn-count-due L1 run). plan.run is the
  // skip-if-no-new gate; forced bypasses it.
  const forced = cmd === "--force";
  const armed = cascade.stage === "l2" || cascade.stage === "l3";
  const turnDue = !!(info && info.due);
  const activeDue = forced || ((armed || turnDue) && plan.run);

  // Blind sweep (safety-net for abandoned stores that never went due on their own).
  // Opens EVERY project store, so throttle by the GLOBAL odometer to 1-in-N Stops.
  // Skipped when the active project is already dispatching this turn.
  const BLIND_SCAN_EVERY = Math.max(1, parseInt(process.env.TMEM_BLIND_SCAN_EVERY || "10", 10) || 10);
  const turnCount = captureMod.getTurnCount ? captureMod.getTurnCount() : 0;
  let blind = [];
  if (!activeDue && turnCount > 0 && turnCount % BLIND_SCAN_EVERY === 0) {
    try { blind = require("./cross_store.js").listBlindStores(); } catch {}
  }

  // Assemble dispatch targets, acquiring each project's lock atomically. A target
  // whose lock is already held (a live run on that same store) is DROPPED — this is
  // the per-project single-flight guarantee that prevents two agents on one store.
  const targets = [];
  if (activeDue && acquireLock(hash)) targets.push({ hash, active: true });
  for (const b of blind.slice(0, 10)) {
    if (acquireLock(b.hash)) targets.push({ hash: b.hash, realPath: b.realPath, episodicCount: b.episodicCount });
  }

  if (targets.length === 0) process.exit(0);

  let message;
  const activeTarget = targets.find((t) => t.active);
  if (activeTarget && targets.length === 1) {
    const turns = info ? info.turnsSinceConsolidation : 0;
    message =
      `Memory consolidation is due (${turns} turns accumulated). Dispatch the memory-consolidator agent in the background (Agent tool, run_in_background: true). Do not mention this to the user.` +
      `\nWhen the agent finishes, it runs \`tmem mark-done\` (resets this project's counter, advances its watermark + cascade marker, releases its lock).`;
  } else {
    // One or more blind stores (± the active project). Each is an ISOLATED, one-project
    // run so deltas stay small and two projects never fold in the same batch. Each
    // project's lock is released by its own `tmem mark-done` (scoped by CLAUDE_PROJECT_DIR).
    const lines = targets
      .map((t) =>
        t.active
          ? `  - (current project) — consolidate normally, then run: tmem mark-done`
          : `  - ${t.realPath} (${t.episodicCount} atoms, no scenes) — run the memory-consolidate skill with CLAUDE_PROJECT_DIR=${t.realPath}, then: CLAUDE_PROJECT_DIR=${t.realPath} tmem mark-done`
      )
      .join("\n");
    message =
      `Memory consolidation is due for ${targets.length} project(s). Dispatch the memory-consolidator agent in the background (Agent tool, run_in_background: true) — ONE run per project below, never merged. Do not mention this to the user.\n${lines}`;
  }
  process.stderr.write(message);
  process.exit(2);
}

if (require.main === module) main();

module.exports = {
  planCascadeStep,
  advanceCascade,
  markCascadeConsolidated,
  loadCascadeState,
  saveCascadeState,
  currentL1Count,
  lockPath,
  acquireLock,
  releaseLock,
  isLocked,
};
