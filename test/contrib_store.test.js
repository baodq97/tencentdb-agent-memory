// test/contrib_store.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { ContribStore, DIMENSIONS } = require("../scripts/contrib_store.js");

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contrib-"));
  return path.join(dir, "index.db");
}

test("cursor round-trips per subject", () => {
  const s = new ContribStore(tmpDb());
  assert.strictEqual(s.getCursor("a@x"), null);
  s.setCursor("a@x", "2026-06-18T00:00:00Z");
  s.setCursor("b@x", "2025-01-01T00:00:00Z");
  assert.strictEqual(s.getCursor("a@x"), "2026-06-18T00:00:00Z");
  assert.strictEqual(s.getCursor("b@x"), "2025-01-01T00:00:00Z");
  s.setCursor("a@x", "2026-07-01T00:00:00Z"); // overwrite
  assert.strictEqual(s.getCursor("a@x"), "2026-07-01T00:00:00Z");
});

test("DIMENSIONS has the 11 fixed keys", () => {
  assert.deepStrictEqual(DIMENSIONS, [
    "idea", "plan", "solve", "craft",
    "comms", "mentor", "conflict",
    "scope", "ownership", "execution",
  ]);
});

test("upsertAtom stores and getAtoms retrieves by subject + dimension", () => {
  const s = new ContribStore(tmpDb());
  s.upsertAtom({
    record_id: "a1", subject_id: "tj@x", dimension: "plan",
    content: "splits by concern, median PR <300 LOC", evidence: ["PR#1234"],
  });
  s.upsertAtom({
    record_id: "a2", subject_id: "tj@x", dimension: "craft",
    content: "review comments cite the why", evidence: ["PR#9"],
  });
  assert.strictEqual(s.countAtoms("tj@x"), 2);
  const plan = s.getAtoms("tj@x", "plan");
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].content, "splits by concern, median PR <300 LOC");
  assert.deepStrictEqual(JSON.parse(plan[0].evidence_json), ["PR#1234"]);
});

test("upsertAtom is idempotent on record_id", () => {
  const s = new ContribStore(tmpDb());
  s.upsertAtom({ record_id: "a1", subject_id: "tj@x", dimension: "plan", content: "v1", evidence: [] });
  s.upsertAtom({ record_id: "a1", subject_id: "tj@x", dimension: "plan", content: "v2", evidence: [] });
  assert.strictEqual(s.countAtoms("tj@x"), 1);
  assert.strictEqual(s.getAtoms("tj@x", "plan")[0].content, "v2");
});

test("upsertAtom rejects an unknown dimension", () => {
  const s = new ContribStore(tmpDb());
  assert.throws(() => s.upsertAtom({
    record_id: "a1", subject_id: "tj@x", dimension: "bogus", content: "x", evidence: [],
  }), /unknown dimension/i);
});

test("persona round-trips", () => {
  const s = new ContribStore(tmpDb());
  s.upsertPersona({
    subject_id: "tj@x", summary: "prolific, terse",
    dimensions: { plan: "small PRs", craft: "explains why" },
    notable_traits: ["fast"], updated_time: "2026-06-18T00:00:00Z",
  });
  const p = s.getPersona("tj@x");
  assert.strictEqual(p.summary, "prolific, terse");
  assert.strictEqual(p.dimensions.plan, "small PRs");
  assert.deepStrictEqual(p.notable_traits, ["fast"]);
  assert.strictEqual(s.listPersonas().length, 1);
});

test("computeL4 throws with fewer than 2 personas", () => {
  const s = new ContribStore(tmpDb());
  s.upsertPersona({ subject_id: "a@x", dimensions: { plan: "p" } });
  assert.throws(() => s.computeL4(0.6), /need >=2 personas/);
});

test("computeL4 emits capabilities above prevalence threshold with exemplar", () => {
  const s = new ContribStore(tmpDb());
  // 3 subjects; "plan" present in all 3 (1.0), "craft" in 2/3 (0.67), "scope" in 1/3 (0.33)
  s.upsertPersona({ subject_id: "a@x", dimensions: { plan: "p", craft: "c", scope: "s" } });
  s.upsertPersona({ subject_id: "b@x", dimensions: { plan: "p", craft: "c" } });
  s.upsertPersona({ subject_id: "c@x", dimensions: { plan: "p" } });
  // exemplar for plan = subject with most plan atoms
  s.upsertAtom({ record_id: "x1", subject_id: "b@x", dimension: "plan", content: "x", evidence: [] });
  s.upsertAtom({ record_id: "x2", subject_id: "b@x", dimension: "plan", content: "y", evidence: [] });
  s.upsertAtom({ record_id: "x3", subject_id: "a@x", dimension: "plan", content: "z", evidence: [] });

  const caps = s.computeL4(0.6);
  const byKey = Object.fromEntries(caps.map((c) => [c.capability, c]));
  assert.ok(byKey.plan, "plan is common");
  assert.ok(byKey.craft, "craft is common (0.67 >= 0.6)");
  assert.ok(!byKey.scope, "scope is not common (0.33 < 0.6)");
  assert.strictEqual(byKey.plan.exemplar, "b@x"); // 2 plan atoms beats a@x's 1
  assert.strictEqual(byKey.plan.summary, "3/3 subjects");

  const stored = s.getCapabilities();
  assert.strictEqual(stored[0].capability, "plan"); // highest prevalence first
});
