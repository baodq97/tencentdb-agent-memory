"use strict";
// Per-project single-flight lock — the fix for two consolidator agents running in
// parallel on the same store.
//
//  - acquire is atomic (O_EXCL): two callers race, exactly one wins.
//  - a lock held by a live run is NOT stolen (no double-dispatch on the SAME store).
//  - two DIFFERENT projects each get their own lock (parallel across projects is OK).
//  - a lock older than the TTL backstop is reclaimed (a dead run self-heals).
//
// Isolation: primitives run in-process under a throwaway HOME; the dispatch cases
// run the real hook in a child process.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "memory_pipeline.js");
const { projectHashForCwd } = require("../scripts/memory_reader.js");
const lock = require("../scripts/memory_pipeline.js");

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-lock-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("Bar 4: acquire is atomic — second acquire of a held lock fails", () => {
  withHome(() => {
    assert.strictEqual(lock.acquireLock("h1"), true, "first acquire wins");
    assert.strictEqual(lock.acquireLock("h1"), false, "second acquire is refused");
    assert.strictEqual(lock.isLocked("h1"), true);
    lock.releaseLock("h1");
    assert.strictEqual(lock.isLocked("h1"), false);
    assert.strictEqual(lock.acquireLock("h1"), true, "re-acquire after release");
  });
});

test("Bar 4: a live lock is NOT stolen", () => {
  withHome(() => {
    lock.acquireLock("h1");
    assert.strictEqual(lock.acquireLock("h1"), false, "fresh lock is not stale, must not be stolen");
  });
});

test("Bar 3: two different projects each acquire their own lock", () => {
  withHome(() => {
    assert.strictEqual(lock.acquireLock("projA"), true);
    assert.strictEqual(lock.acquireLock("projB"), true, "a different project is not blocked");
    assert.notStrictEqual(lock.lockPath("projA"), lock.lockPath("projB"));
    assert.ok(fs.existsSync(lock.lockPath("projA")));
    assert.ok(fs.existsSync(lock.lockPath("projB")));
  });
});

test("Bar 4: a lock older than the TTL backstop is reclaimed", () => {
  withHome(() => {
    lock.acquireLock("h1");
    const p = lock.lockPath("h1");
    // Backdate the lock 31 minutes (default TTL is 30 min).
    const old = Date.now() - 31 * 60 * 1000;
    fs.utimesSync(p, new Date(old), new Date(old));
    assert.strictEqual(lock.isLocked("h1"), false, "stale lock reads unlocked");
    assert.strictEqual(lock.acquireLock("h1"), true, "stale lock is reclaimed");
    // The reclaim produced a FRESH lock; a second reclaimer must now be refused
    // (this is the stale-reclaim single-flight guarantee).
    assert.strictEqual(lock.acquireLock("h1"), false, "reclaimed lock is fresh — not stealable");
  });
});

test("reclaim leaves no stray .stale claim files", () => {
  withHome(() => {
    lock.acquireLock("h1");
    const p = lock.lockPath("h1");
    const old = Date.now() - 31 * 60 * 1000;
    fs.utimesSync(p, new Date(old), new Date(old));
    lock.acquireLock("h1"); // reclaims
    const dir = path.dirname(p);
    const strays = fs.readdirSync(dir).filter((f) => f.includes(".stale."));
    assert.deepStrictEqual(strays, [], "no leftover .stale.<pid> files");
  });
});

// ── dispatch-level single-flight (real hook, child process) ──

function seedDue(home, hash, { turnCount = 5, cascade = { stage: "idle", last_consolidated_l1: 0 } } = {}) {
  const base = path.join(home, ".memory-tencentdb");
  const cs = path.join(base, "capture_state.json");
  fs.mkdirSync(path.join(base, "projects", hash), { recursive: true });
  let state = { turn_count: 0, projects: {} };
  try { state = JSON.parse(fs.readFileSync(cs, "utf-8")); } catch {}
  if (!state.projects) state.projects = {};
  state.turn_count = Math.max(state.turn_count || 0, turnCount);
  state.projects[hash] = { turn_count: turnCount, last_consolidation_turn: 0, consolidation_due: true };
  fs.writeFileSync(cs, JSON.stringify(state));
  fs.writeFileSync(path.join(base, "projects", hash, "cascade_state.json"), JSON.stringify(cascade));
}

function runHook(home, projDir) {
  let code = 0;
  try {
    execFileSync("node", [SCRIPT], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: projDir },
      stdio: "pipe",
    });
  } catch (e) {
    code = e.status;
  }
  return code;
}

test("Bar 2: same project — a due project is a target, a locked one is not", () => {
  // Ported. Single-flight moved DOWN a layer: the hook no longer acquires, so it
  // no longer exits 2 and no longer leaves a lock behind. The guarantee is
  // unchanged — one run per store — but it is now enforced where the run
  // actually starts. Two assertions replace the old one: the hook's decision
  // skips an already-locked project, and the runner refuses to start on one.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-lock-hook-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-lock-proj-"));
  const prev = { h: process.env.HOME, u: process.env.USERPROFILE, d: process.env.CLAUDE_PROJECT_DIR };
  try {
    const hash = projectHashForCwd(proj);
    seedDue(home, hash);
    process.env.HOME = home; process.env.USERPROFILE = home; process.env.CLAUDE_PROJECT_DIR = proj;

    const pipeline = require("../scripts/memory_pipeline.js");
    const select = () => pipeline.selectTargets({
      hash, forced: false, info: { due: true },
      cascade: { stage: "idle", last_consolidated_l1: 0 },
      plan: { run: true, tier: "l1", reason: "new-l1" },
      captureMod: { getTurnCount: () => 0 },
    });

    assert.strictEqual(select().length, 1, "an unlocked due project is a target");
    assert.strictEqual(lock.acquireLock(hash), true, "simulate a run in flight");
    assert.strictEqual(select().length, 0, "a locked project is not offered again");

    // And the runner itself refuses, which is the authoritative guarantee: the
    // check above is only a cheap filter that saves starting a doomed process.
    // The cap is pinned so the developer's own config cannot decide this test,
    // and spawnSyncFn is stubbed so no `claude -p` can ever start from a test.
    const runner = require("../scripts/consolidate_runner.js");
    process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY = "12";
    process.env.MEMORY_AUTO_CONSOLIDATE = "on";   // suite default is off; spawn is stubbed below
    const rec = runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter",
      spawnSyncFn: () => { throw new Error("a locked store must never reach spawn"); },
    });
    assert.strictEqual(rec.verdict, "skipped");
    assert.strictEqual(rec.reason, "locked", "the runner must not start on a locked store");

    assert.strictEqual(runHook(home, proj), 0, "and the hook never signals the session");
  } finally {
    process.env.HOME = prev.h; process.env.USERPROFILE = prev.u;
    delete process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY;
    delete process.env.MEMORY_AUTO_CONSOLIDATE;
    if (prev.d === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prev.d;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

const { execFile } = require("node:child_process");

test("stale-reclaim single-flight: N concurrent reclaimers, exactly one wins", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-lock-conc-"));
  try {
    const dir = path.join(home, ".memory-tencentdb", "projects", "hc");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "consolidation.lock");
    fs.writeFileSync(p, JSON.stringify({ pid: 999999, startedAt: "old" }));
    const old = Date.now() - 31 * 60 * 1000; // stale beyond the TTL
    fs.utimesSync(p, new Date(old), new Date(old));

    const oneLiner =
      "const l=require(" + JSON.stringify(SCRIPT) + ");process.stdout.write(String(l.acquireLock('hc')))";
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const runs = Array.from({ length: 20 }, () =>
      new Promise((resolve) => {
        execFile("node", ["-e", oneLiner], { env }, (_e, stdout) => resolve((stdout || "").trim()));
      })
    );
    const results = await Promise.all(runs);
    const wins = results.filter((r) => r === "true").length;
    assert.strictEqual(wins, 1, `exactly one reclaimer must win, got ${wins} (${results.join(",")})`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const CLI = path.join(__dirname, "..", "scripts", "cli.js");

test("completion loop: mark-done releases the lock, resets the counter, next Stop is quiet", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-done-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-done-proj-"));
  try {
    const hash = projectHashForCwd(proj);
    seedDue(home, hash);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: proj };

    // The lock is now taken by the runner, not the hook, so this stands in for a
    // run in flight. What mark-done must still guarantee is unchanged: it
    // releases the lock and resets the counter so the next Stop is quiet.
    assert.strictEqual(runHook(home, proj), 0, "due ⇒ the hook spawns and stays silent");
    const lockFile = path.join(home, ".memory-tencentdb", "projects", hash, "consolidation.lock");
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

    execFileSync("node", [CLI, "mark-done"], { env, stdio: "pipe" });
    assert.ok(!fs.existsSync(lockFile), "mark-done released the lock");

    const cs = JSON.parse(fs.readFileSync(path.join(home, ".memory-tencentdb", "capture_state.json"), "utf-8"));
    assert.strictEqual(cs.projects[hash].consolidation_due, false, "counter reset");

    assert.strictEqual(runHook(home, proj), 0, "next Stop is quiet (not due, cascade marker advanced)");
    assert.ok(!fs.existsSync(lockFile), "and no lock is left behind");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("Bar 3: two different projects both dispatch (parallel allowed)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-lock-hook2-"));
  const projA = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-lock-projA-"));
  const projB = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-lock-projB-"));
  try {
    const hashA = projectHashForCwd(projA);
    const hashB = projectHashForCwd(projB);
    seedDue(home, hashA);
    seedDue(home, hashB);
    // Ported from exit-2. Cross-project parallelism is the property; it is now
    // observed through the runner, which acquires per project. A holds a lock and
    // B must still be able to take its own.
    const runner = require("../scripts/consolidate_runner.js");
    const prev = { h: process.env.HOME, u: process.env.USERPROFILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY = "12";
      process.env.MEMORY_AUTO_CONSOLIDATE = "on";   // suite default is off; spawn is stubbed below
      assert.strictEqual(lock.acquireLock(hashA), true, "project A's run is in flight");
      let sawSpawn = false;
      const recB = runner.runConsolidation({
        hash: hashB, projectDir: projB, trigger: "counter",
        // Stubbed: this asserts B got PAST the lock, not that a model ran.
        spawnSyncFn: () => { sawSpawn = true; return { status: 0, stdout: "{}" }; },
      });
      assert.strictEqual(sawSpawn, true, "B must reach its run despite A's lock");
      assert.notStrictEqual(recB.reason, "locked");
      assert.strictEqual(lock.isLocked(hashA), true, "and A's lock is untouched");
      assert.strictEqual(lock.isLocked(hashB), false, "B released its own lock when it finished");
    } finally {
      process.env.HOME = prev.h; process.env.USERPROFILE = prev.u;
      delete process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY;
      delete process.env.MEMORY_AUTO_CONSOLIDATE;
    }
    assert.strictEqual(runHook(home, projA), 0, "neither hook signals the session");
    assert.strictEqual(runHook(home, projB), 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(projA, { recursive: true, force: true });
    fs.rmSync(projB, { recursive: true, force: true });
  }
});
