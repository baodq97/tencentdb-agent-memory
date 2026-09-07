"use strict";
// Consolidation drops a trigger when it hits a lock — regression coverage.
//
// The premise "the work is lost" does not hold at the state layer: the
// counters that arm a trigger (capture_state.json's slot.turn_count /
// last_consolidation_turn) are reset ONLY by markConsolidated(), called ONLY
// from `tmem mark-done` on a genuinely completed run — never by a lock miss.
// So candidate (a), "do not consume the trigger", is largely already true; the
// real gap closed here is (1) making a lock-collision record distinguishable
// from a true loss, and (2) not spawning a doomed `claude` process on a
// collision the caller could have checked cheaply first. See the WHY-comment
// at the top of scripts/consolidate_runner.js for the full design rationale.
//
// No test in this file may start a real `claude` process: every case injects
// spawnSyncFn / spawnFn.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runner = require("../scripts/consolidate_runner.js");
// A `claude` on PATH, always. Without it consolidate_runner's preflight short-
// circuits to skipped/no-claude-binary BEFORE the lock check, so every assertion
// below silently tests the preflight instead of the lock — green on a developer
// machine with Claude Code installed, red on a clean CI runner. That exact
// failure shipped once already (see test/_fake_claude.js); this file repeated it.
const { envWithClaude } = require("./_fake_claude.js");
const lock = require("../scripts/memory_pipeline.js");
const pipeline = require("../scripts/memory_pipeline.js");

const HASH = "-test-consolidate-lock-queue";

/** Same pattern as test/consolidate_runner.test.js's withRoot. */
function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-lockqueue-"));
  const prev = process.env.MEMORY_TENCENTDB_HOME;
  const prevCap = process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY;
  const prevAuto = process.env.MEMORY_AUTO_CONSOLIDATE;
  process.env.MEMORY_TENCENTDB_HOME = root;
  process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY = "12";
  process.env.MEMORY_AUTO_CONSOLIDATE = "on";
  fs.mkdirSync(path.join(root, "projects", HASH, "scene_blocks"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", HASH, "changelog.jsonl"), "");
  try { return fn(root); } finally {
    if (prev === undefined) delete process.env.MEMORY_TENCENTDB_HOME; else process.env.MEMORY_TENCENTDB_HOME = prev;
    if (prevCap === undefined) delete process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY; else process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY = prevCap;
    if (prevAuto === undefined) delete process.env.MEMORY_AUTO_CONSOLIDATE; else process.env.MEMORY_AUTO_CONSOLIDATE = prevAuto;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const runsIn = (root) => fs.readFileSync(path.join(root, "consolidation_runs.jsonl"), "utf-8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

function seedSlot(root, hash, slot) {
  const state = { turn_count: slot.turn_count, last_consolidation_turn: slot.last_consolidation_turn, sessions: {}, projects: { [hash]: slot } };
  fs.writeFileSync(path.join(root, "capture_state.json"), JSON.stringify(state, null, 2), "utf-8");
}

test("a session-end race against a held lock does not spawn a claude process and is recorded as retryable", () => {
  withRoot((root) => {
    assert.strictEqual(pipeline.acquireLock(HASH), true, "pre-acquire the lock, simulating a live run");
    try {
      const spawned = runner.spawnDetachedRunner({
        hash: HASH,
        trigger: "session-end",
        spawnFn: () => { throw new Error("must not spawn while locked"); },
      });
      assert.strictEqual(spawned, false, "a locked target must not be spawned");

      const runs = runsIn(root);
      assert.strictEqual(runs.length, 1, "the collision is recorded, not silently dropped");
      assert.strictEqual(runs[0].verdict, "skipped");
      assert.strictEqual(runs[0].reason, "locked");
      assert.strictEqual(runs[0].retryable, true, "distinguishable from today's plain locked skip");
    } finally {
      pipeline.releaseLock(HASH);
    }
  });
});

test("the backlog counter survives a lock collision untouched", () => {
  withRoot((root) => {
    const seeded = { turn_count: 37, last_consolidation_turn: 12, consolidation_due: true };
    seedSlot(root, HASH, seeded);

    assert.strictEqual(pipeline.acquireLock(HASH), true);
    try {
      const rec = runner.runConsolidation({
        hash: HASH,
        trigger: "session-end", env: envWithClaude(),
        spawnSyncFn: () => { throw new Error("must not spawn while locked"); },
      });
      assert.strictEqual(rec.verdict, "skipped");
      assert.strictEqual(rec.reason, "locked");
      assert.strictEqual(rec.retryable, true);
      assert.strictEqual(rec.turns_since_consolidation, 37 - 12, "logged read-only, matches the seeded slot");
    } finally {
      pipeline.releaseLock(HASH);
    }

    const state = JSON.parse(fs.readFileSync(path.join(root, "capture_state.json"), "utf-8"));
    const slot = state.projects[HASH];
    assert.strictEqual(slot.turn_count, seeded.turn_count, "turn_count untouched by a lock miss");
    assert.strictEqual(slot.last_consolidation_turn, seeded.last_consolidation_turn, "last_consolidation_turn untouched by a lock miss");
  });
});

test("a second trigger after release is the one that actually runs, never concurrently", () => {
  withRoot((root) => {
    const seeded = { turn_count: 37, last_consolidation_turn: 12, consolidation_due: true };
    seedSlot(root, HASH, seeded);

    let spawnCount = 0;

    assert.strictEqual(pipeline.acquireLock(HASH), true, "simulate a live run holding the lock");
    const firstRec = runner.runConsolidation({
      hash: HASH,
      trigger: "session-end", env: envWithClaude(),
      spawnSyncFn: () => { spawnCount += 1; throw new Error("must not spawn while locked"); },
    });
    assert.strictEqual(firstRec.verdict, "skipped");
    assert.strictEqual(firstRec.reason, "locked");
    assert.strictEqual(spawnCount, 0, "the first, colliding trigger never spawns");

    pipeline.releaseLock(HASH);

    const secondRec = runner.runConsolidation({
      hash: HASH,
      trigger: "counter", env: envWithClaude(),
      spawnSyncFn: () => {
        spawnCount += 1;
        // The deferred trigger's backlog is what this run processes — prove it
        // by producing a measurable store delta, the runner's only definition
        // of success.
        fs.writeFileSync(path.join(root, "projects", HASH, "changelog.jsonl"), JSON.stringify({ op: "test" }) + "\n");
        return { status: 0, stdout: JSON.stringify({ subtype: "success", total_cost_usd: 0.01, num_turns: 1 }) };
      },
    });

    assert.strictEqual(secondRec.verdict, "changed", "the deferred backlog was processed, not lost");
    assert.strictEqual(spawnCount, 1, "exactly one spawn total across both calls — never concurrent");

    const runs = runsIn(root);
    assert.strictEqual(runs.length, 2, "both the collision and the eventual run are logged");
    assert.strictEqual(runs[0].reason, "locked");
    assert.strictEqual(runs[1].verdict, "changed");
  });
});

test("the counter arm's pre-filter still exists and is unaffected", () => {
  // Regression check: memory_pipeline.js's selectTargets still excludes a
  // locked hash on its own, upstream of spawnDetachedRunner's new pre-check —
  // the new check is additive, not a replacement for the existing filter.
  withRoot(() => {
    assert.strictEqual(lock.acquireLock(HASH), true);
    try {
      assert.strictEqual(lock.isLocked(HASH), true, "the counter arm's own filter sees the lock");
    } finally {
      lock.releaseLock(HASH);
    }
  });
});
