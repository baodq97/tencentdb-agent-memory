"use strict";
// WS6 — cascade skip-if-no-new.
//
// Consolidation is an event cascade: L1 done arms L2, L2 done arms L3. The
// pipeline tracks a "last-consolidated L1" marker (the L1 atom count already
// folded upward). An armed L2/L3 step is SKIPPED when no new L1 atom has been
// captured since that marker — dispatching an LLM agent over unchanged material
// is wasted work. When a new atom exists, the step is dispatched.
//
// Isolation: the end-to-end cases run the hook in a child process under a
// throwaway HOME, so nothing touches the developer's ~/.memory-tencentdb.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "memory_pipeline.js");
const { planCascadeStep, advanceCascade } = require("../scripts/memory_pipeline.js");
const { projectHashForCwd } = require("../scripts/memory_reader.js");

// A deterministic project scope for the per-project state. The temp dir has no
// .git, so projectHashForCwd falls back to the slug of its own path.
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-cas-proj-"));
const HASH = projectHashForCwd(PROJ);

// Seed the per-project counter + cascade. turn_count doubles as the project's L1
// count; consolidation_due arms the turn-count path.
function seed(home, { turnCount, cascade }) {
  const base = path.join(home, ".memory-tencentdb");
  const projDir = path.join(base, "projects", HASH);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(base, "capture_state.json"),
    JSON.stringify({
      turn_count: turnCount,
      projects: { [HASH]: { turn_count: turnCount, last_consolidation_turn: 0, consolidation_due: true } },
    })
  );
  fs.writeFileSync(path.join(projDir, "cascade_state.json"), JSON.stringify(cascade));
  return base;
}

// Run the asyncRewake hook (no args) scoped to the seeded project. { code, locked }.
function runHook(home) {
  let code = 0;
  try {
    execFileSync("node", [SCRIPT], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: PROJ },
      stdio: "pipe",
    });
  } catch (e) {
    code = e.status;
  }
  const locked = fs.existsSync(path.join(home, ".memory-tencentdb", "projects", HASH, "consolidation.lock"));
  return { code, locked };
}

// Evaluate the target decision in-process under a throwaway HOME. Deterministic:
// no child, no detached runner, nothing that could reach a real store.
function targetsUnderHome(home, cascade, currentL1) {
  const prev = { h: process.env.HOME, u: process.env.USERPROFILE, d: process.env.CLAUDE_PROJECT_DIR };
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.CLAUDE_PROJECT_DIR = PROJ;
  try {
    const pipeline = require("../scripts/memory_pipeline.js");
    return pipeline.selectTargets({
      hash: HASH,
      forced: false,
      info: { due: true },
      cascade,
      plan: pipeline.planCascadeStep(cascade, currentL1),
      captureMod: { getTurnCount: () => 0 },
    });
  } finally {
    process.env.HOME = prev.h; process.env.USERPROFILE = prev.u;
    if (prev.d === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prev.d;
  }
}

test("planCascadeStep skips an armed tier with no new L1", () => {
  for (const stage of ["l2", "l3"]) {
    const plan = planCascadeStep({ stage, last_consolidated_l1: 10 }, 10);
    assert.deepStrictEqual(plan, { run: false, tier: stage, reason: "no-new-l1" });
  }
});

test("planCascadeStep runs an armed tier when a new L1 atom exists", () => {
  for (const stage of ["l2", "l3"]) {
    const plan = planCascadeStep({ stage, last_consolidated_l1: 10 }, 11);
    assert.deepStrictEqual(plan, { run: true, tier: stage, reason: "new-l1" });
  }
});

test("planCascadeStep starts a fresh cascade at l1 only when new L1 exists", () => {
  assert.deepStrictEqual(
    planCascadeStep({ stage: "idle", last_consolidated_l1: 5 }, 7),
    { run: true, tier: "l1", reason: "new-l1" }
  );
  assert.deepStrictEqual(
    planCascadeStep({ stage: "idle", last_consolidated_l1: 5 }, 5),
    { run: false, tier: null, reason: "no-new-l1" }
  );
});

test("advanceCascade arms the next tier and marks the L1 count at the top", () => {
  const s0 = { stage: "l1", last_consolidated_l1: 0 };
  const s1 = advanceCascade(s0, "l1", 12);
  assert.strictEqual(s1.stage, "l2");
  assert.strictEqual(s1.last_consolidated_l1, 0); // marker not moved mid-cascade
  const s2 = advanceCascade(s1, "l2", 12);
  assert.strictEqual(s2.stage, "l3");
  const s3 = advanceCascade(s2, "l3", 12);
  assert.strictEqual(s3.stage, "idle");
  assert.strictEqual(s3.last_consolidated_l1, 12); // marker advances only when the cascade completes
  // Now idle with marker at 12: no new L1 means the next plan skips.
  assert.strictEqual(planCascadeStep(s3, 12).run, false);
});

test("armed L2 with no new L1 since marker is NOT dispatched (exit 0, no lock)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-cas-skip-"));
  try {
    seed(home, { turnCount: 10, cascade: { stage: "l2", last_consolidated_l1: 10 } });
    const { code, locked } = runHook(home);
    assert.strictEqual(code, 0, "expected skip (exit 0) when there is no new L1");
    assert.strictEqual(locked, false, "must not acquire the consolidation lock when skipping");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("armed L2 with a new L1 atom IS selected as a target (hook still exits 0)", () => {
  // Ported from an exit-2 assertion. Consolidation no longer interrupts the
  // session: the hook spawns a detached runner and always exits 0, and the
  // runner — not the hook — acquires the lock, so a spawn that never happens
  // cannot wedge the project for the lock's 30-minute TTL. The DECISION is now
  // asserted directly via selectTargets(); the hook's contract is only that it
  // stays silent.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-cas-run-"));
  try {
    seed(home, { turnCount: 11, cascade: { stage: "l2", last_consolidated_l1: 10 } });
    const targets = targetsUnderHome(home, { stage: "l2", last_consolidated_l1: 10 }, 11);
    assert.strictEqual(targets.length, 1, "a new L1 atom must produce exactly one target");
    assert.strictEqual(targets[0].hash, HASH);
    const { code, locked } = runHook(home);
    assert.strictEqual(code, 0, "the hook must never signal the session again");
    assert.strictEqual(locked, false, "the hook must not hold the lock — the runner acquires it");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
