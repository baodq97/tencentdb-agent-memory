"use strict";
// Regression: `tmem sync` must pick the records that ACTUALLY lack a vector, by
// identity — not the newest-N by count. The count-based selection (delta =
// records - vecCount, then newest-N by updated_time) assumed the missing vectors
// were the most recently updated records; when they were not, upsert overwrote
// the newest (already-vectored) records and the count never moved, so a store
// re-embedded the same wrong N every run and never converged (measured: 226 stuck,
// 0 of the truly-missing older records fixed). VectorStore.existingIds() is the
// primitive the fix selects on.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { VectorStore } = require("../scripts/vector_store.js");

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vecsync-"));
  // dims=4 keeps the test cheap; the vec0 table rejects a wrong-width vector, so
  // the width must match what we upsert.
  return { dir, vs: new VectorStore(path.join(dir, "v.db"), 4) };
}
const V = (a, b, c, d) => [a, b, c, d];

test("existingIds returns exactly the upserted record_ids", () => {
  const { dir, vs } = tmpStore();
  if (vs.degraded) { vs.close(); fs.rmSync(dir, { recursive: true, force: true }); return; }
  assert.strictEqual(vs.upsertVec("r1", V(1, 0, 0, 0)), true);
  assert.strictEqual(vs.upsertVec("r2", V(0, 1, 0, 0)), true);
  const ids = vs.existingIds();
  assert.strictEqual(ids.size, 2);
  assert.ok(ids.has("r1") && ids.has("r2"));
  assert.ok(!ids.has("r3"), "an un-upserted id must be absent");
  vs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sync selects the truly-missing record even when it is the OLDEST, not newest", () => {
  const { dir, vs } = tmpStore();
  if (vs.degraded) { vs.close(); fs.rmSync(dir, { recursive: true, force: true }); return; }
  // The bug scenario: three records, and the ONLY one lacking a vector is the
  // oldest. The old count-based path embedded the newest `delta` records — which
  // already had vectors — and never touched the old one.
  const records = [
    { record_id: "old", updated_time: "2026-01-01T00:00:00Z" },
    { record_id: "mid", updated_time: "2026-06-01T00:00:00Z" },
    { record_id: "new", updated_time: "2026-08-01T00:00:00Z" },
  ];
  vs.upsertVec("mid", V(0, 1, 0, 0));
  vs.upsertVec("new", V(0, 0, 1, 0));
  const have = vs.existingIds();

  // Identity selection (the fix): exactly the missing record, regardless of age.
  const missing = records.filter((r) => !have.has(String(r.record_id))).map((r) => r.record_id);
  assert.deepStrictEqual(missing, ["old"]);

  // The old count-based selection would have taken the newest (records-vecCount)=1
  // record ("new"), which already has a vector — a no-op that never converges.
  const delta = records.length - vs.count();
  const oldPick = records
    .slice()
    .sort((a, b) => (b.updated_time || "").localeCompare(a.updated_time || ""))
    .slice(0, delta)
    .map((r) => r.record_id);
  assert.deepStrictEqual(oldPick, ["new"], "documents the old buggy pick");
  assert.notStrictEqual(oldPick[0], missing[0], "old path picked a record that was not missing");

  vs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
