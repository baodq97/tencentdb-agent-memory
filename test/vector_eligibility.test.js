"use strict";
// GAP-3: episodic/persona atoms were embedded but recall's keepDistilledAtoms
// drops them, so 98% of the vector index was dead weight that starved every KNN
// (measured: 0/10 survivors per query). The fix skips embedding those types. The
// invariant that MUST hold: the write-side predicate (isVectorEligible) and the
// read-side filter (keepDistilledAtoms) agree for every type — a divergence would
// re-introduce dead vectors or drop a type we embedded.

const { test } = require("node:test");
const assert = require("node:assert");
const { isVectorEligible, NON_RECALL_TYPES } = require("../scripts/memory_store.js");
const { keepDistilledAtoms } = require("../scripts/memory_recall.js");

test("isVectorEligible: recall-ineligible types are not embedded", () => {
  assert.strictEqual(isVectorEligible("episodic"), false);
  assert.strictEqual(isVectorEligible("persona"), false);
  assert.strictEqual(isVectorEligible("semantic"), true);
  assert.strictEqual(isVectorEligible("instruction"), true);
  assert.strictEqual(isVectorEligible(""), true);        // untyped is kept
  assert.strictEqual(isVectorEligible(undefined), true);
});

test("write predicate and read filter agree for every type (no divergence)", () => {
  const types = ["episodic", "persona", "semantic", "instruction", "", "unknown-future-type"];
  for (const t of types) {
    const embedded = isVectorEligible(t);                 // would we store a vector?
    const kept = keepDistilledAtoms([{ type: t }]).length === 1; // would recall use it?
    assert.strictEqual(embedded, kept, `divergence for type "${t}": embed=${embedded} keep=${kept}`);
  }
});

test("NON_RECALL_TYPES is exactly the pair recall drops", () => {
  assert.deepStrictEqual([...NON_RECALL_TYPES].sort(), ["episodic", "persona"]);
});
