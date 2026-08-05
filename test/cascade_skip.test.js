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

function seed(home, { turnCount, cascade }) {
  const base = path.join(home, ".memory-tencentdb");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(
    path.join(base, "capture_state.json"),
    JSON.stringify({ turn_count: turnCount, last_consolidation_turn: 0, consolidation_due: true })
  );
  fs.writeFileSync(path.join(base, "cascade_state.json"), JSON.stringify(cascade));
  return base;
}

// Run the asyncRewake hook (no args). Returns { code, locked }.
function runHook(home) {
  let code = 0;
  try {
    execFileSync("node", [SCRIPT], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "pipe" });
  } catch (e) {
    code = e.status;
  }
  const locked = fs.existsSync(path.join(home, ".memory-tencentdb", "consolidation.lock"));
  return { code, locked };
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

test("armed L2 with a new L1 atom IS dispatched (exit 2, lock held)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-cas-run-"));
  try {
    seed(home, { turnCount: 11, cascade: { stage: "l2", last_consolidated_l1: 10 } });
    const { code, locked } = runHook(home);
    assert.strictEqual(code, 2, "expected dispatch (exit 2) when a new L1 atom exists");
    assert.strictEqual(locked, true, "dispatch must acquire the consolidation lock");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
