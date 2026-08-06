"use strict";
// The reachability/capture-signal graders: coverage (vectors embedded) read
// "green" while half the stores were recall-blind and capture kept only the
// user's prompt. These metrics grade the goal — can memory be recalled, and does
// an atom carry an outcome — so the instrument stops lying.

const { test } = require("node:test");
const assert = require("node:assert");
const { isOutcomeBearing, summarizeReachability } = require("../scripts/memory_reachability.js");

test("isOutcomeBearing keeps result-bearing atoms, drops bare prompts/questions", () => {
  // outcome: number / path / version / decision verb
  assert.ok(isOutcomeBearing("Fixed sync to select by identity; store went 1740/1966 -> 1966/1966"));
  assert.ok(isOutcomeBearing("recall flag stored at projects.<hash>.recall in state.json"));
  assert.ok(isOutcomeBearing("bumped to v0.7.7 after 372 tests passed"));
  // not outcomes: questions, short prompts, chit-chat
  assert.ok(!isOutcomeBearing("cach giai quyet la gi :v"));
  assert.ok(!isOutcomeBearing("finding tiep theo system thinking"));
  assert.ok(!isOutcomeBearing("ok"));
  assert.ok(!isOutcomeBearing("chưa đủ thuyết phục tôi lắm"));
});

test("summarizeReachability separates reachable from recall-blind stores", () => {
  const stores = [
    { slug: "a", episodicCount: 100, sceneCount: 8, outcomeAtoms: 60 }, // reachable
    { slug: "b", episodicCount: 40, sceneCount: 0, outcomeAtoms: 5 },   // blind
    { slug: "c", episodicCount: 16, sceneCount: 0, outcomeAtoms: 2 },   // blind
    { slug: "d", episodicCount: 0, sceneCount: 3, outcomeAtoms: 0 },    // ignored (no episodic)
  ];
  const r = summarizeReachability(stores);
  assert.strictEqual(r.storesWithEpisodic, 3);
  assert.strictEqual(r.reachableStores, 1);
  assert.strictEqual(r.blindStores, 2);
  assert.strictEqual(r.blindAtoms, 56);
  assert.strictEqual(r.reachablePct, 33);
  assert.strictEqual(r.totalEpisodic, 156);
  assert.strictEqual(r.outcomeAtoms, 67);
  assert.strictEqual(r.signalPct, 43);
  assert.deepStrictEqual(r.blind.map((s) => s.slug), ["b", "c"]); // sorted by size
});

test("summarizeReachability is safe on empty input", () => {
  const r = summarizeReachability([]);
  assert.strictEqual(r.storesWithEpisodic, 0);
  assert.strictEqual(r.reachablePct, 0);
  assert.strictEqual(r.signalPct, 0);
});
