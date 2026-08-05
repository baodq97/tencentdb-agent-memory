"use strict";
// Recall render enrichments (upstream parity, cheap + local):
//  #2 a compact staleness date (YYYY-MM-DD) on each injected memory line, so the
//     model can weigh recency — absent when no timestamp is stored.
//  #3 a one-line "search deeper" affordance in the block, turning passive recall
//     into agent-driven retrieval (tmem search / tmem scene).
const { test } = require("node:test");
const assert = require("node:assert");
const { renderMemories, MEMORY_SEARCH_HINT } = require("../scripts/memory_recall.js");

test("#2 injected line carries the memory's date when a timestamp is stored", () => {
  const out = renderMemories(
    [{ record_id: "a", type: "episodic", content: "shipped incremental read", timestamp_end: "2026-03-01T10:00:00.000Z" }],
    4000,
  );
  assert.match(out.text, /2026-03-01/);
  assert.match(out.text, /- \[episodic\] \(2026-03-01\) shipped incremental read/);
});

test("#2 no timestamp ⇒ line stays byte-identical (no date, no budget change)", () => {
  const out = renderMemories([{ record_id: "a", type: "fact", content: "hello" }], 4000);
  assert.match(out.text, /- \[fact\] hello/);
  assert.doesNotMatch(out.text, /\(\d{4}-/);
});

test("#3 the block carries a search-deeper affordance when memories exist", () => {
  const out = renderMemories([{ record_id: "a", type: "fact", content: "x" }], 4000);
  assert.ok(MEMORY_SEARCH_HINT.includes("tmem search"), "hint names tmem search");
  assert.ok(out.text.includes(MEMORY_SEARCH_HINT), "hint is included in the block");
});

test("#3 no affordance (and no block) when there are no memories", () => {
  const out = renderMemories([], 4000);
  assert.strictEqual(out.text, "");
});

test("#3 the affordance line does not count as a memory bullet", () => {
  // Guards the existing budget-accounting tests: the hint must not start with "- ".
  const out = renderMemories([{ record_id: "a", type: "fact", content: "x" }], 4000);
  const bullets = out.text.split("\n").filter((l) => l.startsWith("- "));
  assert.strictEqual(bullets.length, 1);
});
