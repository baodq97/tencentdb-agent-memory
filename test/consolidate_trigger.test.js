"use strict";
// The consolidation trigger predicate.
//
// This one function decides how stale the whole memory system is allowed to get,
// so it is pure and pinned exhaustively. The values it is pinned against are
// measured, not chosen: over 14 days of real traffic (838 injected turns, 17
// projects) a counter-only policy left 33.5% of turns never consolidated with a
// median lag of 4.15 h, because the median session is 4 turns and short-lived
// projects never reach any counter. Adding the session-boundary arm takes that
// to 1.9% never served and p50 0.58 h. Each arm alone abandons exactly the
// population the other one covers, which is why the OR — and not either arm — is
// what these tests protect.

const { test } = require("node:test");
const assert = require("node:assert");
const { consolidationTrigger } = require("../scripts/memory_auto_capture.js");

const CFG = { every: 10, sessionEndMin: 3 };
const slot = (turns, done = 0, warmup = 0) => ({
  turn_count: turns, last_consolidation_turn: done, warmup_threshold: warmup,
});
// cfg is passed as the OVERRIDE so these cases do not depend on the developer's
// own config.json; production callers let the predicate resolve it itself.
const mid = (s, o) => consolidationTrigger(s, o || {}, CFG);

test("counter arm fires at the threshold and not before", () => {
  assert.strictEqual(mid(slot(9)), null);
  assert.strictEqual(mid(slot(10)), "counter");
  assert.strictEqual(mid(slot(40)), "counter");
});

test("session arm fires only when the session is ending", () => {
  assert.strictEqual(mid(slot(3)), null, "3 new turns mid-session is not enough");
  assert.strictEqual(mid(slot(3), { sessionEnding: true }), "session-end");
  assert.strictEqual(mid(slot(2), { sessionEnding: true }), null, "below the session minimum");
});

test("the arms are an OR: a long session fires on the counter before it ends", () => {
  // The reason the counter arm survives at all. Without it a 200-turn session
  // would accrue for hours with nothing distilled, and the session-boundary arm
  // would only pay out once, at the end.
  assert.strictEqual(mid(slot(10), { sessionEnding: false }), "counter");
});

test("the session arm wins the label when both fire", () => {
  // Both are true at 12 new turns on an ending session. The label is the only
  // record of WHY a run happened once it reaches the runs log, and the more
  // specific cause is the useful one when reading that log back.
  assert.strictEqual(mid(slot(12), { sessionEnding: true }), "session-end");
});

test("nothing new means no run, on either arm", () => {
  // A run over unchanged material spends a model call and the user's rate limit
  // to write nothing. This is the guard that makes an idle machine cost zero.
  assert.strictEqual(mid(slot(5, 5)), null);
  assert.strictEqual(mid(slot(5, 5), { sessionEnding: true }), null);
  assert.strictEqual(mid(slot(5, 9), { sessionEnding: true }), null, "negative delta is not a trigger");
});

test("warmup still gates the counter arm on a fresh store", () => {
  // A brand-new project must not stay blind until turn 10. warmupThreshold
  // predates this change and is deliberately not superseded by it.
  assert.strictEqual(mid(slot(1, 0, 1)), "counter", "fresh store fires on the first turn");
  assert.strictEqual(mid(slot(3, 0, 4)), null, "mid-warmup, below the doubled threshold");
  assert.strictEqual(mid(slot(4, 0, 4)), "counter", "at the doubled threshold");
});

test("with no override the predicate resolves its own config", () => {
  // Production callers pass only (slot, opts) — the whole reason cfg stopped
  // being assembled at every call site. Driven through the env overrides so the
  // assertion is deterministic and does not read the developer's config.json.
  const prevE = process.env.MEMORY_CONSOLIDATE_EVERY;
  const prevS = process.env.MEMORY_CONSOLIDATE_ON_SESSION_END;
  process.env.MEMORY_CONSOLIDATE_EVERY = "7";
  process.env.MEMORY_CONSOLIDATE_ON_SESSION_END = "2";
  try {
    assert.strictEqual(consolidationTrigger(slot(6), {}), null, "below the resolved counter");
    assert.strictEqual(consolidationTrigger(slot(7), {}), "counter", "at the resolved counter");
    assert.strictEqual(consolidationTrigger(slot(2), { sessionEnding: true }), "session-end",
      "at the resolved session minimum");
  } finally {
    if (prevE === undefined) delete process.env.MEMORY_CONSOLIDATE_EVERY; else process.env.MEMORY_CONSOLIDATE_EVERY = prevE;
    if (prevS === undefined) delete process.env.MEMORY_CONSOLIDATE_ON_SESSION_END; else process.env.MEMORY_CONSOLIDATE_ON_SESSION_END = prevS;
  }
});

test("no slot is not a trigger", () => {
  assert.strictEqual(consolidationTrigger(null, {}, CFG), null);
});
