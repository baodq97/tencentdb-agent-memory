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
const { envWithClaude } = require("./_fake_claude.js");

/** withHome, for a body that awaits: the same setup, torn down after it resolves. */
async function withHomeAsync(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-lock-"));
  const prev = { home: process.env.HOME, profile: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return await fn(home); }
  finally {
    process.env.HOME = prev.home;
    process.env.USERPROFILE = prev.profile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Put an env var back exactly as it was, including "was not set". */
function restore(key, value) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

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

test("Bar 4: a lock nobody can vouch for is reclaimed after the TTL", () => {
  withHome(() => {
    // No readable pid ⇒ the TTL is the only judge, which is exactly the case it
    // exists for (a lock file this build did not write, or one it cannot parse).
    const p = lock.lockPath("h1");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not json");
    const old = Date.now() - 31 * 60 * 1000;   // default TTL is 30 min
    fs.utimesSync(p, new Date(old), new Date(old));
    assert.strictEqual(lock.isLocked("h1"), false, "stale lock reads unlocked");
    assert.strictEqual(lock.acquireLock("h1"), true, "stale lock is reclaimed");
    // The reclaim produced a FRESH lock; a second reclaimer must now be refused
    // (this is the stale-reclaim single-flight guarantee).
    assert.strictEqual(lock.acquireLock("h1"), false, "reclaimed lock is fresh — not stealable");
  });
});

// BEHAVIOUR CHANGE, deliberate. This used to assert that a lock aged past the TTL
// is reclaimed FULL STOP, including one whose writer is demonstrably still
// running — the case the pid check was added for, overridden by the very check it
// was added to beat. Reclaiming a live holder is not self-healing, it is a second
// concurrent consolidation on one store, which is the failure this file exists to
// prevent. What bounds a hung run instead is a real clock: consolidate_runner
// gives spawnSync a timeout derived from LOCK_TTL_MS, so a run cannot outlive its
// own lock in the first place.
test("a lock whose writer is ALIVE is never reclaimed, TTL or no TTL", () => {
  withHome(() => {
    lock.acquireLock("h1");
    const p = lock.lockPath("h1");
    assert.strictEqual(JSON.parse(fs.readFileSync(p, "utf-8")).pid, process.pid);
    const old = Date.now() - 31 * 60 * 1000;
    fs.utimesSync(p, new Date(old), new Date(old));
    assert.strictEqual(lock.isLocked("h1"), true, "our own pid is alive: the holder is still working");
    assert.strictEqual(lock.acquireLock("h1"), false, "so a second run must not start beside it");
  });
});

// The lock file has always carried {pid, startedAt}; nothing read the pid until
// now. Time-only staleness was correct when the lock's writer was the Stop hook
// (it exited immediately, so the lock always outlived its writer) — but the runner
// now acquires the lock itself and holds it across a synchronous spawnSync, so the
// recorded pid IS the guarded run. A SIGKILLed runner used to wedge its project
// for the full 30-minute TTL with the proof of death sitting inside the lock file.
test("a lock whose writer is dead, with nothing of its run left, is reclaimed early", () => {
  withHome(() => {
    lock.acquireLock("h1");
    const p = lock.lockPath("h1");
    // Past the pid grace (60 s) but nowhere near the 30-minute TTL: the TTL alone
    // cannot decide this case, so any reclaim here is the pid check's doing.
    const aged = () => { const t = Date.now() - 2 * 60 * 1000; fs.utimesSync(p, new Date(t), new Date(t)); };

    // A pid that is certainly dead: spawnSync has already reaped it, and it left
    // no process group behind either — that pair is the whole proof.
    const dead = require("node:child_process").spawnSync("node", ["-e", ""]).pid;
    fs.writeFileSync(p, JSON.stringify({ pid: dead, pgid: dead, startedAt: "whenever" }));
    aged();  // writeFileSync refreshed mtime
    assert.strictEqual(lock.isLocked("h1"), false, "a dead writer's lock reads unlocked");
    assert.strictEqual(lock.acquireLock("h1"), true, "and is reclaimed 28 minutes before the TTL");
  });
});

// THE REGRESSION THIS PINS. The lock records the RUNNER's pid, but the guarded
// work is the `claude -p` GRANDCHILD, which survives its parent: SIGKILL the
// detached runner and the child is reparented to init and keeps folding the
// store. A bare pid check reads "writer dead" and hands the mutex to a second
// consolidation while the first is still writing scene_blocks and persona — and
// 11 of the 17 real runs with a duration in consolidation_runs.jsonl run longer
// than the 60-second grace, so that window covers most of a typical run.
//
// The runner is spawned detached, so it leads its own process group and the child
// inherits it. An EMPTY group — not a dead pid — is the proof that a run is over.
test("a dead writer whose orphaned child is still running does NOT release the store", async () => {
  // withHome is synchronous — its finally would delete the store root (and put
  // HOME back) before an async body finished — so this case gets an awaiting twin.
  await withHomeAsync(async () => {
    const { spawn } = require("node:child_process");
    // A detached "runner" (its own process group, like spawnDetachedRunner's) that
    // starts a long-lived child in that group and then exits, exactly as a
    // SIGKILLed runner leaves things.
    const runner = spawn(process.execPath, ["-e",
      "const{spawn}=require('child_process');" +
      "const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});" +
      "c.unref();setTimeout(()=>process.exit(0),100);"],
      { detached: true, stdio: "ignore" });
    const pgid = runner.pid;
    runner.unref();

    const p = lock.lockPath("h1");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ pid: runner.pid, pgid, owner: "runner", startedAt: "then" }));
    const age = (ms) => { const t = Date.now() - ms; fs.utimesSync(p, new Date(t), new Date(t)); };

    const waitUntil = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

    try {
      assert.ok(await waitUntil(() => !alive(runner.pid)), "the runner must actually die");
      age(2 * 60 * 1000);   // past the grace, far short of the TTL
      assert.strictEqual(lock.isLocked("h1"), true, "the writer is dead but its run is not");
      assert.strictEqual(lock.acquireLock("h1"), false, "so no second consolidation may start");

      // Now end the orphan too: nothing of that run survives, and the lock is free.
      try { process.kill(-pgid, "SIGKILL"); } catch {}
      assert.ok(await waitUntil(() => { try { process.kill(-pgid, 0); return false; } catch { return true; } }),
        "the process group must actually drain");
      age(2 * 60 * 1000);
      assert.strictEqual(lock.acquireLock("h1"), true, "an empty group is the proof the run is over");
    } finally {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
  });
});

// releaseLock used to unlink whatever was at the path, with no check that it was
// the lock this process created. Now that `finally { releaseLock }` is the sole
// release path and always runs, that turns ONE lost lock into unbounded
// concurrency: R1 finishes and deletes R2's live lock, R3 starts beside R2, and
// so on for as long as runs keep starting.
test("a process cannot release a lock it did not take", () => {
  withHome(() => {
    assert.strictEqual(lock.acquireLock("h1"), true, "R1 acquires");
    const p = lock.lockPath("h1");
    // R1's lock is reclaimed or manually unlocked, and R2 takes its own.
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, pgid: null, token: "r2-token", owner: "runner", startedAt: "now" }));
    assert.strictEqual(lock.releaseLock("h1"), false, "R1's finally must not open R2's lock");
    assert.ok(fs.existsSync(p), "R2 still holds the store");
    assert.strictEqual(lock.acquireLock("h1"), false, "and R3 cannot start beside it");
    assert.strictEqual(lock.releaseLock("h1", { force: true }), true, "`tmem unlock` is still the escape hatch");
  });
});

test("a manual lease is ended by the manual path and by nobody else", () => {
  // The manual path has no process that spans its run: `tmem consolidate-context`
  // takes the lease and a LATER `tmem mark-done` ends it, so entitlement there
  // cannot come from an in-memory token. It comes from the owner field — which is
  // also what stops mark-done from opening a background runner's lock.
  withHome(() => {
    assert.strictEqual(lock.acquireLock("h1", { owner: "manual" }), true);
    const p = lock.lockPath("h1");
    const meta = JSON.parse(fs.readFileSync(p, "utf-8"));
    assert.strictEqual(meta.pid, null, "a lease has no live process to point at — the TTL judges it");
    assert.strictEqual(meta.owner, "manual");
    // Re-write it with a token this process never saw: now it is the lease of
    // some earlier `tmem`, exactly as mark-done finds it.
    fs.writeFileSync(p, JSON.stringify({ ...meta, token: "some-earlier-tmem" }));
    assert.strictEqual(lock.releaseLock("h1"), false, "and an unrelated process may not end it");
    assert.strictEqual(lock.releaseLock("h1", { expectOwner: "runner" }), false, "not a runner's to end");
    assert.strictEqual(lock.releaseLock("h1", { expectOwner: "manual" }), true);
    assert.ok(!fs.existsSync(p));
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
  // SAVE the previous values, including MEMORY_AUTO_CONSOLIDATE. Deleting it in
  // the finally instead of restoring it removed the suite-wide `off` switch for
  // every later test in this file, and their hook subprocesses then spawned REAL
  // `claude -p` runs — which is what made the completion-loop test flaky and slow.
  const prev = { h: process.env.HOME, u: process.env.USERPROFILE, d: process.env.CLAUDE_PROJECT_DIR,
                 a: process.env.MEMORY_AUTO_CONSOLIDATE, c: process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY };
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
      hash, projectDir: proj, trigger: "counter", env: envWithClaude(),
      spawnSyncFn: () => { throw new Error("a locked store must never reach spawn"); },
    });
    assert.strictEqual(rec.verdict, "skipped");
    assert.strictEqual(rec.reason, "locked", "the runner must not start on a locked store");

    assert.strictEqual(runHook(home, proj), 0, "and the hook never signals the session");
  } finally {
    process.env.HOME = prev.h; process.env.USERPROFILE = prev.u;
    restore("MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY", prev.c);
    restore("MEMORY_AUTO_CONSOLIDATE", prev.a);
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

// BEHAVIOUR CHANGE, deliberate: mark-done no longer releases the lock.
//
// This test used to assert the opposite ("mark-done released the lock"). That was
// the defect, not the contract: mark-done runs INSIDE the consolidation child, so
// the mutex over the store was opened by a model's judgement about which step it
// was on. Calling it early — or a human calling it while a background run held the
// lock for the same project — freed the store mid-flight and let a second run
// start on it. Lock lifecycle now belongs to consolidate_runner.js alone (acquire
// before spawn, release in a finally after the child exits), with `tmem unlock` as
// the human escape hatch. What mark-done still owns is asserted unchanged below:
// the counter reset and the cascade marker, so the next Stop is quiet.
test("completion loop: mark-done resets the counter and leaves the lock alone; next Stop is quiet", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-done-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-done-proj-"));
  try {
    const hash = projectHashForCwd(proj);
    seedDue(home, hash);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: proj };

    // The lock is taken by the runner, not the hook, so this stands in for a run
    // still in flight around this very mark-done call.
    assert.strictEqual(runHook(home, proj), 0, "due ⇒ the hook spawns and stays silent");
    const lockFile = path.join(home, ".memory-tencentdb", "projects", hash, "consolidation.lock");
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

    execFileSync("node", [CLI, "mark-done"], { env, stdio: "pipe" });
    assert.ok(fs.existsSync(lockFile), "mark-done must NOT open the mutex of a run still in flight");

    const cs = JSON.parse(fs.readFileSync(path.join(home, ".memory-tencentdb", "capture_state.json"), "utf-8"));
    assert.strictEqual(cs.projects[hash].consolidation_due, false, "counter reset");

    assert.strictEqual(runHook(home, proj), 0, "next Stop is quiet (not due, cascade marker advanced)");

    // The escape hatch is still a command, just no longer an implicit side effect.
    execFileSync("node", [CLI, "unlock"], { env, stdio: "pipe" });
    assert.ok(!fs.existsSync(lockFile), "tmem unlock releases it explicitly");
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
    const prev = { h: process.env.HOME, u: process.env.USERPROFILE,
                   a: process.env.MEMORY_AUTO_CONSOLIDATE, c: process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY };
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY = "12";
      process.env.MEMORY_AUTO_CONSOLIDATE = "on";   // suite default is off; spawn is stubbed below
      assert.strictEqual(lock.acquireLock(hashA), true, "project A's run is in flight");
      let sawSpawn = false;
      const recB = runner.runConsolidation({
        hash: hashB, projectDir: projB, trigger: "counter", env: envWithClaude(),
        // Stubbed: this asserts B got PAST the lock, not that a model ran.
        spawnSyncFn: () => { sawSpawn = true; return { status: 0, stdout: "{}" }; },
      });
      assert.strictEqual(sawSpawn, true, "B must reach its run despite A's lock");
      assert.notStrictEqual(recB.reason, "locked");
      assert.strictEqual(lock.isLocked(hashA), true, "and A's lock is untouched");
      assert.strictEqual(lock.isLocked(hashB), false, "B released its own lock when it finished");
    } finally {
      process.env.HOME = prev.h; process.env.USERPROFILE = prev.u;
      restore("MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY", prev.c);
      restore("MEMORY_AUTO_CONSOLIDATE", prev.a);
    }
    // Deliberately no runHook() here. This test's subject is cross-project
    // parallelism, and "the hook exits 0" is already pinned by cascade_skip.
    // Spawning from here raced the cleanup: the detached runner starts after
    // execFileSync returns, so it could touch the throwaway HOME after the
    // finally had removed it.
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(projA, { recursive: true, force: true });
    fs.rmSync(projB, { recursive: true, force: true });
  }
});
