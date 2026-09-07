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
// THE ONE INVARIANT EVERYTHING BELOW SERVES:
//
//     a lock is reclaimed only when the previous holder's work is over.
//
// "Over" is proved, never assumed, and the proof has to cover the process that
// does the WORK, not the process that wrote the file. `runConsolidation` writes
// the lock and then blocks in spawnSync on a `claude -p` GRANDCHILD; SIGKILL the
// runner and that grandchild is reparented to init and keeps folding the store.
// So a bare pid check on the recorded pid is not a proof of anything: it reads
// "writer dead" while the run it guarded is still writing scene_blocks. 11 of the
// 17 real runs carrying a duration in consolidation_runs.jsonl exceed a minute
// (median 69.0s, max 164.3s), so that window covers most of a typical run.
//
// The runner is spawned DETACHED (consolidate_runner.spawnDetachedRunner), which
// on POSIX makes it a session leader, so its process GROUP id equals its pid and
// the `claude -p` child — spawned without `detached` — inherits that group. That
// makes the group the honest unit of liveness, and it is what the lock records:
//
//     { pid, pgid, token, owner, startedAt, ttlMs? }
//
// The staleness ladder, in order (see staleReason):
//   1. younger than LOCK_PID_GRACE_MS ⇒ live. Nothing is reclaimed in the first
//      minute anyway, and the window removes the one way a pid check can be
//      actively wrong: N reclaimers racing, where the winner is a short-lived
//      process that has already exited by the time the losers read its pid.
//   2. recorded pid ALIVE ⇒ live, and the TTL does NOT override that. A TTL that
//      can reclaim a provably-live holder hands the mutex to a second run while
//      the first is mid-write, which is the exact race this file exists to
//      prevent. What bounds a hung run instead is a real clock: the runner gives
//      spawnSync a timeout derived from LOCK_TTL_MS (consolidate_runner.js).
//   3. recorded pid DEAD and the recorded process group has no members left ⇒
//      "dead". Nothing of that run survives, so reclaim immediately instead of
//      wedging the project for the rest of the TTL.
//   4. anything else — pid dead but its group still has members (the orphaned
//      grandchild), no pid recorded (a manual lease, whose writer is a `tmem`
//      process that exits at once), or an unreadable lock file — is judged by the
//      TTL alone, exactly as this lock behaved before pid liveness existed.
//
// The TTL is generous (30 min, TMEM_LOCK_TTL_MS-overridable) so a long-but-live
// cascade is never reclaimed mid-flight, unlike the old 5-minute cap that could
// double-dispatch.
const LOCK_TTL_MS = Math.max(60 * 1000, parseInt(process.env.TMEM_LOCK_TTL_MS || "", 10) || 30 * 60 * 1000);

/** Rung 1 of the ladder above: a lock this young is judged by the TTL only. */
const LOCK_PID_GRACE_MS = Math.max(1000, parseInt(process.env.TMEM_LOCK_PID_GRACE_MS || "", 10) || 60 * 1000);

// A MANUAL lease (`/memory-seed` → the memory-consolidator agent → the
// memory-consolidate skill) is held across an interactive agent's work by a
// series of short-lived `tmem` processes, so there is no live pid to point at and
// rung 4 — the TTL — is its only judge. It gets its OWN, shorter TTL: an
// abandoned interactive run should not block background consolidation for the
// full half hour that a real in-flight run is allowed.
const MANUAL_LEASE_TTL_MS = Math.max(60 * 1000, parseInt(process.env.TMEM_MANUAL_LEASE_TTL_MS || "", 10) || 15 * 60 * 1000);

function lockPath(hash) {
  return path.join(memoryBaseDir(), "projects", hash || "global", "consolidation.lock");
}

/**
 * Tokens this PROCESS is holding, hash → token. The ownership half of
 * releaseLock: a process may only unlink the lock file it created. Without it,
 * `finally { releaseLock }` — now the sole release path, so it always runs — turns
 * one lost lock into unbounded concurrency: R1's finally deletes R2's live lock,
 * R3 then acquires next to R2, and so on. In-memory on purpose; the token is also
 * written into the file so a foreign process can compare, but only the creator
 * ever knows the value.
 */
const HELD = new Map();

function newToken() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Signal-0 liveness. Unknown pid ⇒ assume alive: only proof of death reclaims. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === "EPERM"); }  // EPERM = alive, owned by someone else
}

/**
 * Does a process group with this id still have members? This is the question a
 * bare pid check cannot answer: the orphaned `claude -p` grandchild of a killed
 * runner stays in the runner's group, so an empty group is the proof that the
 * whole run — not just its parent — is over. Read-only: signal 0 never delivers.
 */
function groupHasMembers(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try { process.kill(-pgid, 0); return true; }
  catch (e) { return !!(e && e.code === "EPERM"); }
}

/**
 * This process's group id, but ONLY when we can prove we lead it — a group's id
 * is its leader's pid, so a group numbered like us can only be ours. Returns null
 * where that cannot be established (a non-detached invocation, or Windows, where
 * negative-pid signalling is not a thing), and a null pgid is honest: it means
 * "cannot prove this run's descendants are gone", which keeps the lock on rung 4.
 */
function ownProcessGroup() {
  try { process.kill(-process.pid, 0); return process.pid; } catch { return null; }
}

function readLockMeta(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

/** A lease may shorten its own TTL (manual), never lengthen it past the backstop. */
function ttlFor(meta) {
  const t = meta && parseInt(meta.ttlMs, 10);
  return Number.isInteger(t) && t > 0 ? Math.min(t, LOCK_TTL_MS) : LOCK_TTL_MS;
}

/**
 * Why this lock is reclaimable, or false if it is not: "gone" | "dead" | "ttl".
 * PURE — it reads, it never unlinks. (It used to unlink from inside isLocked,
 * which made a "cheap read-only pre-check" the thing that actually destroyed a
 * live run's lock file.) The reclaim itself is reclaimStaleLock, under the
 * rename-claim protocol, so exactly one racer acts on this verdict.
 */
function staleReason(p) {
  let ageMs;
  try { ageMs = Date.now() - fs.statSync(p).mtimeMs; } catch { return "gone"; }
  if (ageMs <= LOCK_PID_GRACE_MS) return false;                     // rung 1
  const meta = readLockMeta(p);
  const pid = meta && Number.isInteger(meta.pid) && meta.pid > 0 ? meta.pid : null;
  if (pid !== null) {
    if (pidAlive(pid)) return false;                                // rung 2
    if (Number.isInteger(meta.pgid) && !groupHasMembers(meta.pgid)) return "dead";  // rung 3
  }
  return ageMs > ttlFor(meta) ? "ttl" : false;                      // rung 4
}

/**
 * The live lock's metadata, or null when there is none (or it is reclaimable).
 * Read-only. Lets a caller ask WHO holds the store, not just whether someone
 * does — the manual path needs that to tell "a background runner is folding this
 * store" from "this is my own lease, taken by my previous `tmem` call".
 */
function lockInfo(hash) {
  const p = lockPath(hash);
  try { fs.statSync(p); } catch { return null; }
  if (staleReason(p)) return null;
  return readLockMeta(p);
}

/** Refresh a lease's mtime — its TTL is its only judge, and it is still working. */
function touchLock(hash) {
  const p = lockPath(hash);
  try { const now = new Date(); fs.utimesSync(p, now, now); return true; } catch { return false; }
}

/** True if a live run holds this project. Read-only; never mutates the lock. */
function isLocked(hash) {
  const p = lockPath(hash);
  try { fs.statSync(p); } catch { return false; }
  return !staleReason(p);
}

function writeLockFile(p, extra) {
  const token = newToken();
  const fd = fs.openSync(p, "wx"); // O_EXCL: fails if it already exists
  try {
    fs.writeSync(fd, JSON.stringify({
      pid: process.pid, pgid: ownProcessGroup(), token,
      owner: "runner", startedAt: new Date().toISOString(),
      ...(extra || {}),
    }));
  } finally { fs.closeSync(fd); }
  return token;
}

/**
 * The shape a lock takes for each owner. "manual" records no pid and no pgid on
 * purpose: the `tmem` process that writes it exits within milliseconds while the
 * agent it represents keeps working, so pid liveness would declare it dead the
 * moment the grace window closed.
 */
function lockShape(owner) {
  return owner === "manual"
    ? { owner: "manual", pid: null, pgid: null, ttlMs: MANUAL_LEASE_TTL_MS }
    : { owner: "runner" };
}

/**
 * Atomically acquire the project lock. Returns true on success, false if held.
 * `opts.owner` is "runner" (default, an automatic run) or "manual" (an
 * interactive consolidation, which has no supervising process — see lockShape).
 */
function acquireLock(hash, opts) {
  const owner = (opts && opts.owner) || "runner";
  const p = lockPath(hash);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    HELD.set(hash || "global", writeLockFile(p, lockShape(owner)));  // O_EXCL: single winner
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!staleReason(p)) return false;  // held by a live run — do not steal
    const token = reclaimStaleLock(p, owner);
    if (!token) return false;
    HELD.set(hash || "global", token);
    return true;
  }
}

/**
 * Reclaim a lock believed stale, race-safely. Unconditional unlink-then-create is
 * a TOCTOU: two reclaimers could each unlink the OTHER's fresh lock and both
 * create. Instead we CLAIM the stale file by renaming it aside — renameSync of a
 * given source is atomic, so of N concurrent reclaimers exactly one succeeds and
 * the rest get ENOENT and back off. We then re-check the claimed file: if it was
 * actually fresh (another reclaimer refreshed the lock between our staleness
 * check and the rename), we restore it and back off rather than steal a live one.
 *
 * Returns the new lock's token, or null when the claim was lost or refused.
 */
function reclaimStaleLock(p, owner) {
  const claim = `${p}.stale.${process.pid}`;
  try {
    fs.renameSync(p, claim);
  } catch {
    return null; // lost the claim race (ENOENT) — someone else is reclaiming/holding
  }
  if (!staleReason(claim)) {
    // We moved a lock that is actually live — put it back and yield.
    try { fs.renameSync(claim, p); } catch { try { fs.unlinkSync(claim); } catch {} }
    return null;
  }
  try { fs.unlinkSync(claim); } catch {}
  try { return writeLockFile(p, lockShape(owner || "runner")); } catch { return null; }
}

/**
 * Release the lock — ONLY the one this process created.
 *
 * `opts.force` is the human escape hatch (`tmem unlock`, `memory_pipeline
 * --unlock`): delete whatever is there. `opts.expectOwner` lets a path release a
 * lease it is entitled to but did not itself create — `tmem mark-done` ending an
 * interactive consolidation whose lease was taken by an earlier `tmem` process.
 *
 * Everything else is refused, including a lock file this build did not write (no
 * token): the whole point is that a release which is not provably ours is a
 * release of somebody else's live run, and one of those does not cost one
 * overlapping run — it leaves the store unguarded for as long as runs keep
 * starting, because each new holder's lock is deleted by the previous holder's
 * finally in turn.
 *
 * Returns true if a lock file was removed.
 */
function releaseLock(hash, opts) {
  const o = opts || {};
  const key = hash || "global";
  const p = lockPath(hash);
  const meta = readLockMeta(p);
  const mine = HELD.get(key);
  if (!o.force) {
    const entitled = (mine && meta && meta.token === mine)
      || (o.expectOwner && meta && meta.owner === o.expectOwner)
      || !meta;   // nothing readable there: an unlink is a no-op or a cleanup
    if (!entitled) return false;   // someone else's live lock — not ours to open
  }
  HELD.delete(key);
  try { fs.unlinkSync(p); return true; } catch { return false; }
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

/**
 * WHICH projects should consolidate on this Stop, and why.
 *
 * Split out from main() so the DECISION can be tested without performing the
 * ACTION. Before this change the decision was observable through main()'s exit
 * code (2 = dispatch) and through the lock file it left behind; both are gone
 * now — the hook always exits 0 and the runner owns lock acquisition — so a test
 * that still watched those signals would be watching nothing. Calling this
 * directly is deterministic and needs no child process.
 *
 * @returns {Array<{hash:string, active?:boolean, projectDir:string, episodicCount?:number}>}
 */
function selectTargets({ hash, forced, info, cascade, plan, captureMod }) {
  // Active project: run when forced, or when a cascade step has genuinely new L1
  // material to fold (armed L2/L3, or a turn-count-due L1 run). plan.run is the
  // skip-if-no-new gate; forced bypasses it.
  const armed = cascade.stage === "l2" || cascade.stage === "l3";
  const turnDue = !!(info && info.due);
  const activeDue = forced || ((armed || turnDue) && plan.run);

  // Blind sweep (safety-net for abandoned stores that never went due on their own).
  // Opens EVERY project store, so throttle by the GLOBAL odometer to 1-in-N Stops.
  // Skipped when the active project is already running this turn.
  const BLIND_SCAN_EVERY = Math.max(1, parseInt(process.env.TMEM_BLIND_SCAN_EVERY || "10", 10) || 10);
  const turnCount = captureMod && captureMod.getTurnCount ? captureMod.getTurnCount() : 0;
  let blind = [];
  if (!activeDue && turnCount > 0 && turnCount % BLIND_SCAN_EVERY === 0) {
    try { blind = require("./cross_store.js").listBlindStores(); } catch {}
  }

  // `isLocked` is a CHEAP PRE-FILTER only — it avoids starting a process that
  // would immediately find the project busy. The authoritative acquire happens
  // inside the runner, atomically (O_EXCL), which is what makes two hooks racing
  // to spawn resolve correctly. Acquiring here instead would leak the lock for
  // the full 30-minute TTL whenever a spawn failed.
  const targets = [];
  if (activeDue && !isLocked(hash)) {
    targets.push({ hash, active: true, projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd() });
  }
  for (const b of blind.slice(0, 10)) {
    if (!isLocked(b.hash)) targets.push({ hash: b.hash, projectDir: b.realPath, episodicCount: b.episodicCount });
  }
  return targets;
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
    releaseLock(hash, { force: true });   // human escape hatch: ownership is not checked
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

  const targets = selectTargets({ hash, forced: cmd === "--force", info, cascade, plan, captureMod });

  if (targets.length === 0) process.exit(0);

  // Spawn one detached runner per project. ONE PROJECT PER RUN, never merged:
  // the consolidator reasons over a single store's delta, and batching two would
  // let facts from one project leak into the other's scenes.
  //
  // Nothing is written to stderr and the exit code stays 0. That is the whole
  // point of this change: the Stop hook used to exit 2 with an instruction for
  // the main session to dispatch an agent, which spent the user's own context on
  // consolidation and only worked when the session complied. Measured over 14
  // days, that wake fired for just 26 of 242 session files while 74% of sessions
  // got no consolidation at all.
  const { spawnDetachedRunner } = require("./consolidate_runner.js");
  for (const t of targets) {
    spawnDetachedRunner({ hash: t.hash, projectDir: t.projectDir, trigger: t.active ? "counter" : "blind-sweep" });
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  selectTargets,
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
  lockInfo,
  touchLock,
  staleReason,
  LOCK_TTL_MS,
  MANUAL_LEASE_TTL_MS,
};
