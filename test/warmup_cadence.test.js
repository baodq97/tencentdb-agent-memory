"use strict";
// #5 Warmup doubling (upstream pipeline-manager warmup_threshold) — a fresh store
// should consolidate almost immediately (threshold 1) so a new project isn't
// blind, then back the cadence off by doubling (1→2→4→8→…) until it reaches the
// steady `consolidate-every`, after which it graduates (0 = use everyN). This
// accelerates ONLY the L1/consolidation trigger; persona synthesis still rides
// the cascade's L3 step, so we never build a persona from two atoms.
const { test } = require("node:test");
const assert = require("node:assert");
const { warmupThreshold, advanceWarmup } = require("../scripts/memory_auto_capture.js");

test("fresh state ⇒ effective threshold is 1 (consolidate after the first turn)", () => {
  assert.strictEqual(warmupThreshold({}, 20), 1);
  assert.strictEqual(warmupThreshold({ turn_count: 3 }, 20), 1);
});

test("advanceWarmup doubles the threshold until it graduates to steady-state", () => {
  const s = {};
  const seen = [warmupThreshold(s, 20)];        // 1
  for (let i = 0; i < 6; i++) {
    advanceWarmup(s, 20);
    seen.push(s.warmup_threshold === 0 ? 20 : warmupThreshold(s, 20));
  }
  // 1 → 2 → 4 → 8 → 16 → (32≥20 ⇒ graduate) 20 → 20
  assert.deepStrictEqual(seen, [1, 2, 4, 8, 16, 20, 20]);
  assert.strictEqual(s.warmup_threshold, 0, "graduated state is stored as 0");
});

test("graduated (0) ⇒ effective threshold is the steady everyN", () => {
  assert.strictEqual(warmupThreshold({ warmup_threshold: 0 }, 34), 34);
});

test("warmup threshold never exceeds everyN even mid-ramp", () => {
  // everyN smaller than the current ramp value: clamp to everyN.
  assert.strictEqual(warmupThreshold({ warmup_threshold: 16 }, 8), 8);
});
