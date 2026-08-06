"use strict";
// GAP-6 feedback loop: recall pushes atoms and logs injectedIds, but nothing read
// that back — the store couldn't tell a recalled memory from a never-recalled one.
// These grade the loop: tally injections per atom, and split the store into hot
// (recalled) vs cold (never recalled — the prune target).

const { test } = require("node:test");
const assert = require("node:assert");
const { summarizeRecallFeedback, classifyStoreAtoms } = require("../scripts/recall_feedback.js");

test("summarizeRecallFeedback tallies injections per atom and keeps the newest timestamp", () => {
  const rows = [
    { at: "2026-08-06T01:00:00Z", injectedIds: ["a", "b"] },
    { at: "2026-08-06T02:00:00Z", injectedIds: ["a"] },
    { at: "2026-08-06T03:00:00Z", injectedIds: [] },     // a turn that recalled nothing
    { at: "2026-08-06T04:00:00Z", injectedIds: ["", null] }, // empties filtered out
  ];
  const s = summarizeRecallFeedback(rows);
  assert.strictEqual(s.turns, 4);
  assert.strictEqual(s.injections, 3);
  assert.strictEqual(s.uniqueAtoms, 2);
  assert.strictEqual(s.emptyTurns, 2);           // the [] turn and the all-empty-ids turn
  assert.deepStrictEqual(s.perAtom[0], { id: "a", count: 2, lastAt: "2026-08-06T02:00:00Z" });
  assert.ok(s.injectedIds.has("a") && s.injectedIds.has("b"));
});

test("classifyStoreAtoms splits hot (recalled) from cold (never recalled)", () => {
  const s = summarizeRecallFeedback([{ at: "t", injectedIds: ["a", "b"] }]);
  const cls = classifyStoreAtoms([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], s);
  assert.deepStrictEqual(cls.hot.map((x) => x.id), ["a", "b"]);
  assert.deepStrictEqual(cls.cold.map((x) => x.id), ["c", "d"]);
  assert.strictEqual(cls.coldPct, 50);
});

test("safe on empty / malformed input", () => {
  const s = summarizeRecallFeedback(null);
  assert.strictEqual(s.turns, 0);
  assert.strictEqual(s.uniqueAtoms, 0);
  const cls = classifyStoreAtoms(null, s);
  assert.strictEqual(cls.coldPct, 0);
});
