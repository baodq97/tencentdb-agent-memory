// test/doctor_denominator.test.js
//
// Pins the fix for: doctor's reachability/capture-signal metrics used to
// denominate over EVERY record (or over the episodic population alone), which
// includes types NON_RECALL_TYPES (scripts/constants.js) excludes from recall
// by design. Measured across 89 real stores: 5713 L1 records, of which only
// 115 (2.0%) are vector-eligible — the rest (episodic + persona) can never be
// recalled, so denominating "capture signal" or "cold" over them reported a
// recall engine as catastrophically broken when it was not.
//
// This file pins the fix at three layers:
//   1. memory_reachability.js's summarizeEligibleReachability() — the pure
//      eligible/hot/cold arithmetic, given a flat atom list + injected ids.
//   2. transform.js's transformRoot() — the same split, built from a
//      StoreExtract/RootExtract-shaped fixture, summed into totals.reachability.
//   3. doctor.js's buildPlan()/renderPlanText() — the snapshot number round-
//      tripped onto the plan, and rendered as two lines: one percentage (over
//      the eligible population) and one plain count (episodic volume, no %).
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { summarizeEligibleReachability } = require("../scripts/memory_reachability.js");
const { buildPlan, renderPlanText } = require("../scripts/doctor.js");
const T = require("../scripts/view/transform.js");
const C = require("../scripts/view/contract.js");
const { STATUS, SCOPE } = C;

// ── Known split used throughout this file: 5 eligible (3 semantic + 2
// instruction), 2 hot; 14 ineligible (10 episodic + 4 persona). Chosen so
// eligible=5, hot=2, hotPct=40 are all exact — no rounding to hide a bug in. ──

test("summarizeEligibleReachability: denominates over eligible atoms only, never episodic/persona", () => {
  const atoms = [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `sem_${i}`, type: "semantic" })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `ins_${i}`, type: "instruction" })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `ep_${i}`, type: "episodic" })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `per_${i}`, type: "persona" })),
  ];
  // 2 hot: one semantic, one instruction. Also inject an episodic id — it must
  // never be counted as "hot" because it is not in the eligible population at all.
  const injectedIds = new Set(["sem_0", "ins_0", "ep_3"]);

  const result = summarizeEligibleReachability(atoms, injectedIds);

  assert.equal(result.eligible, 5);
  assert.equal(result.hot, 2);
  assert.equal(result.cold, 3);
  assert.equal(result.hotPct, 40);
  assert.equal(result.ineligible, 14);
});

test("summarizeEligibleReachability: empty eligible population reports 0% not NaN/Infinity", () => {
  const atoms = [{ id: "e1", type: "episodic" }, { id: "e2", type: "persona" }];
  const result = summarizeEligibleReachability(atoms, new Set());
  assert.equal(result.eligible, 0);
  assert.equal(result.hot, 0);
  assert.equal(result.hotPct, 0);
  assert.equal(result.ineligible, 2);
});

// ───────────────────────────────────────────────────────────────────────────
// transform.js: the same split, built from a store/root fixture
// ───────────────────────────────────────────────────────────────────────────

const rec = (id, type, over = {}) => ({
  record_id: id,
  content: over.content ?? `content of ${id}`,
  type,
  priority: 50,
  scene_name: "",
  session_key: "",
  session_id: "",
  created_time: "2026-01-10T00:00:00Z",
  updated_time: "2026-01-10T00:00:00Z",
  metadata: {},
  ...over,
});

function storeExtract(slug, { records, recallEntries }) {
  const ref = {
    slug, scope: slug === "global" ? SCOPE.GLOBAL : SCOPE.PROJECT, label: slug,
    dir: `/fixture/${slug}`,
    indexDbPath: `/fixture/${slug}/index.db`,
    vectorDbPath: null,
    sceneDir: `/fixture/${slug}/scene_blocks`,
    changelogPath: null,
    hasIndexDb: true,
    indexDbBytes: 4096,
    vectorDbBytes: 0,
  };
  return {
    ref,
    records: C.ok({ records, total: records.length, truncated: false }),
    vectors: C.unmeasured("vectors.db not present"),
    scenes: C.unmeasured("scene_blocks/ not present"),
  };
}

function rootExtract(stores, { recallLog } = {}) {
  return {
    rootDir: "/fixture",
    stores,
    persona: C.unmeasured("persona.md not present", {
      text: null, bytes: null, mtime: null, sections: null, bullets: null,
    }),
    state: C.ok({ sessions: {}, projects: {}, pendingSessions: 0, recallDisabledSlugs: [] }),
    config: C.ok({ config: {}, consolidateEvery: 20, sceneNavBudgetTokens: 200 }),
    captureState: C.ok({ turnCount: 10, lastConsolidationTurn: 10, sessions: {} }),
    recallLog: recallLog || C.unmeasured("recall log not read", { entries: null }),
    extractedAt: "2026-02-01T00:00:00Z",
  };
}

// The exact known split (5 eligible / 2 hot / 14 ineligible) as one store.
function buildKnownSplitStore() {
  const records = [
    ...Array.from({ length: 3 }, (_, i) => rec(`sem_${i}`, "semantic")),
    ...Array.from({ length: 2 }, (_, i) => rec(`ins_${i}`, "instruction")),
    ...Array.from({ length: 10 }, (_, i) => rec(`ep_${i}`, "episodic")),
    ...Array.from({ length: 4 }, (_, i) => rec(`per_${i}`, "persona")),
  ];
  const recallLog = C.ok({
    entries: [
      { at: "2026-02-01T00:00:00Z", injectedIds: ["sem_0"], droppedIds: [] },
      { at: "2026-02-01T00:00:01Z", injectedIds: ["ins_0"], droppedIds: [] },
      // An episodic id injected here must NOT leak into the eligible hot count.
      { at: "2026-02-01T00:00:02Z", injectedIds: ["ep_3"], droppedIds: [] },
    ],
  });
  return storeExtract("proj-a", { records, recallEntries: recallLog });
}

test("transformRoot: totals.reachability denominates on the eligible population, episodic never enters hotPct", () => {
  const store = buildKnownSplitStore();
  const recallLog = C.ok({
    entries: [
      { at: "2026-02-01T00:00:00Z", injectedIds: ["sem_0"], droppedIds: [] },
      { at: "2026-02-01T00:00:01Z", injectedIds: ["ins_0"], droppedIds: [] },
      { at: "2026-02-01T00:00:02Z", injectedIds: ["ep_3"], droppedIds: [] },
    ],
  });
  const snap = T.transformRoot(rootExtract([store], { recallLog }));

  const r = snap.totals.reachability;
  assert.equal(r.eligible, 5);
  assert.equal(r.hot, 2);
  assert.equal(r.cold, 3);
  assert.equal(r.hotPct, 40);
  assert.equal(r.episodicVolume, 10);
  assert.equal(r.ineligibleVolume, 14);

  // The regression this test exists to catch: episodic volume never enters the
  // hotPct denominator. If a future change re-adds episodic to `eligible`,
  // hotPct silently drops from 40 to something under 40 without eligible/hot
  // becoming visibly wrong on their own.
  assert.notEqual(r.eligible, r.episodicVolume + r.eligible);
});

test("transformRoot: totals.reachability.hot is unmeasured (null), not 0, when the recall log itself is unmeasured", () => {
  const store = buildKnownSplitStore();
  const snap = T.transformRoot(rootExtract([store])); // no recallLog -> unmeasured

  const r = snap.totals.reachability;
  assert.equal(r.eligible, 5); // eligibility is a type fact, known regardless
  assert.equal(r.hot, null, "hot must read unmeasured, never a false zero");
  assert.equal(r.cold, null);
  assert.equal(r.hotPct, null);
});

test("transformRoot: per-store StoreSummary.reachability feeds the totals sum", () => {
  const storeA = storeExtract("a", { records: [rec("s1", "semantic")] });
  const storeB = storeExtract("b", { records: [rec("s2", "semantic"), rec("e1", "episodic")] });
  const recallLog = C.ok({
    entries: [{ at: "2026-02-01T00:00:00Z", injectedIds: ["s1", "s2"], droppedIds: [] }],
  });
  const snap = T.transformRoot(rootExtract([storeA, storeB], { recallLog }));

  const a = snap.stores.find((s) => s.slug === "a");
  const b = snap.stores.find((s) => s.slug === "b");
  assert.deepEqual(a.reachability, { eligible: 1, hot: 1 });
  assert.deepEqual(b.reachability, { eligible: 1, hot: 1 });
  assert.equal(snap.totals.reachability.eligible, 2);
  assert.equal(snap.totals.reachability.hot, 2);
});

// ───────────────────────────────────────────────────────────────────────────
// doctor.js: buildPlan round-trips totals.reachability; renderPlanText shows
// two lines — one percentage, one plain count with no percentage.
// ───────────────────────────────────────────────────────────────────────────

test("buildPlan: totals.reachability round-trips off the snapshot unchanged", () => {
  const reachability = { eligible: 5, hot: 2, cold: 3, hotPct: 40, episodicVolume: 10, ineligibleVolume: 14 };
  const plan = buildPlan({ gaps: [], totals: { stores: 1, records: 19, reachability } }, { scope: "current" });
  assert.deepEqual(plan.totals.reachability, reachability);
});

test("renderPlanText: one percentage line for eligible/hot, one plain-count line for episodic volume (no percentage)", () => {
  const reachability = { eligible: 5, hot: 2, cold: 3, hotPct: 40, episodicVolume: 10, ineligibleVolume: 14 };
  const plan = buildPlan({ gaps: [], totals: { stores: 1, records: 19, reachability } }, { scope: "current" });
  const text = renderPlanText(plan);

  assert.match(text, /atoms that can be recalled: 2\/5 \(40%\) recalled at least once/);
  const episodicLine = text.split("\n").find((l) => l.includes("captured but out of recall scope by design"));
  assert.ok(episodicLine, "expected an episodic-volume line");
  assert.match(episodicLine, /10 episodic atoms/);
  assert.doesNotMatch(episodicLine, /%/, "the episodic-volume line must never carry a percentage");
});

test("renderPlanText: hot=null (recall log unmeasured) is worded as unmeasured, not 0%", () => {
  const reachability = { eligible: 5, hot: null, cold: null, hotPct: null, episodicVolume: 10, ineligibleVolume: 14 };
  const plan = buildPlan({ gaps: [], totals: { stores: 1, records: 19, reachability } }, { scope: "current" });
  const text = renderPlanText(plan);
  assert.match(text, /unmeasured/);
  assert.doesNotMatch(text, /0%/);
});

test("renderPlanText: no reachability on the snapshot -> no reachability lines rendered (old snapshots keep working)", () => {
  const plan = buildPlan({ gaps: [], totals: { stores: 1, records: 19 } }, { scope: "current" });
  const text = renderPlanText(plan);
  assert.doesNotMatch(text, /atoms that can be recalled/);
  assert.doesNotMatch(text, /captured but out of recall scope/);
});
