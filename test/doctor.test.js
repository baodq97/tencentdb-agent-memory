// test/doctor.test.js
//
// scripts/doctor.js is PURE: a transformRoot() snapshot in, a fix plan out. It
// maps each gap.kind to the command that repairs it and its safety tier, and
// renders the plan. These tests pin that mapping and the scope/verdict logic on
// synthetic snapshots — nothing here touches the filesystem or ~/.memory-tencentdb
// (see eval_isolation.test.js for why that rule exists).
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

const {
  FIX_BY_KIND,
  gapInScope,
  fixFor,
  verdictFrom,
  buildPlan,
  renderPlanText,
} = require("../scripts/doctor.js");

const projGap = (kind, slug, extra = {}) => ({
  kind,
  severity: extra.severity || "warn",
  unmeasured: extra.unmeasured || false,
  subject: { scope: "project", slug, label: slug.replace(/^.*-/, "") },
  suggestion: extra.suggestion,
});
const rootGap = (kind, extra = {}) => ({
  kind,
  severity: extra.severity || "warn",
  unmeasured: false,
  subject: { scope: "root", slug: null, label: "all stores" },
  suggestion: extra.suggestion,
});

test("gapInScope: root/persona gaps count in every scope", () => {
  const g = rootGap("low_signal_records");
  assert.equal(gapInScope(g, { scope: "current", currentSlug: "x" }), true);
  assert.equal(gapInScope(g, { scope: "all", currentSlug: "x" }), true);
});

test("gapInScope: current scope keeps only global + the current project store", () => {
  const cur = projGap("vectors_missing", "-home-bd-proj-a");
  const other = projGap("vectors_missing", "-home-bd-proj-b");
  const glob = { kind: "vectors_missing", severity: "warn", subject: { scope: "project", slug: "global" } };
  const opts = { scope: "current", currentSlug: "-home-bd-proj-a" };
  assert.equal(gapInScope(cur, opts), true);
  assert.equal(gapInScope(glob, opts), true);
  assert.equal(gapInScope(other, opts), false);
  // --all takes everything
  assert.equal(gapInScope(other, { scope: "all" }), true);
});

test("fixFor: known kind → scope-correct command+tier; unknown → manual + its own suggestion", () => {
  assert.equal(FIX_BY_KIND.vectors_missing.tier, "auto");
  assert.equal(FIX_BY_KIND.duplicate_records.tier, "confirm");
  // Vector fix is scoped: all → --all, current → plain sync (no post-hoc rewrite).
  assert.deepEqual(fixFor({ kind: "vectors_missing" }, "all"), { command: "tmem sync --all", tier: "auto", reversible: true });
  assert.deepEqual(fixFor({ kind: "vectors_missing" }, "current"), { command: "tmem sync", tier: "auto", reversible: true });
  const unknown = fixFor({ kind: "brand_new_kind", suggestion: "tmem frob" }, "all");
  assert.equal(unknown.tier, "manual");
  assert.equal(unknown.command, "tmem frob");
});

test("verdictFrom: critical dominates warn dominates ok, and count 0 does not fire", () => {
  assert.equal(verdictFrom([{ severity: "warn", count: 1 }]), "warn");
  assert.equal(verdictFrom([{ severity: "critical", count: 1 }, { severity: "warn", count: 3 }]), "critical");
  assert.equal(verdictFrom([{ severity: "critical", count: 0 }, { severity: "warn", count: 2 }]), "warn");
  assert.equal(verdictFrom([]), "ok");
});

test("buildPlan: groups gaps by kind, counts stores, splits fix tiers, extracts totals", () => {
  const snapshot = {
    generatedAt: "2026-08-05T00:00:00Z",
    snapshotId: "s-test",
    gaps: [
      projGap("vectors_missing", "-home-bd-proj-a", { severity: "critical" }),
      projGap("vectors_missing", "-home-bd-proj-b", { severity: "critical" }),
      projGap("duplicate_records", "-home-bd-proj-a"),
      rootGap("low_signal_records"),
      projGap("vectors_unmeasurable", "-home-bd-proj-c", { unmeasured: true }),
    ],
    totals: {
      stores: 3, records: 100, scenes: 4,
      coverage: { vectors: { covered: 40, measuredRecords: 90, ratio: 0.4444 } },
      lowSignal: { unionRecords: 12 },
      duplicates: { exact: 3 },
    },
  };

  const plan = buildPlan(snapshot, { scope: "all", currentSlug: "" });
  assert.equal(plan.verdict, "critical");
  assert.equal(plan.totals.vectorsMissing, 50); // 90 measured - 40 covered
  assert.equal(plan.totals.lowSignal, 12);
  assert.equal(plan.totals.duplicates, 3);

  const vm = plan.findings.find((f) => f.kind === "vectors_missing");
  assert.equal(vm.count, 2);
  assert.equal(vm.affectedStores, 2);
  assert.equal(vm.fix.tier, "auto");

  // vectors_unmeasurable has 0 measured defects (only 1 unmeasured) → not counted
  // toward autoFixable, but still reported.
  const vu = plan.findings.find((f) => f.kind === "vectors_unmeasurable");
  assert.equal(vu.count, 0);
  assert.equal(vu.unmeasured, 1);

  assert.equal(plan.autoFixable, 1);   // vectors_missing (vu has count 0)
  assert.equal(plan.confirmRequired, 2); // duplicate_records + low_signal_records
});

test("buildPlan: current scope drops other-project gaps from the plan", () => {
  const snapshot = {
    gaps: [
      projGap("vectors_missing", "-home-bd-proj-a", { severity: "critical" }),
      projGap("vectors_missing", "-home-bd-proj-b", { severity: "critical" }),
    ],
    totals: {},
  };
  const plan = buildPlan(snapshot, { scope: "current", currentSlug: "-home-bd-proj-a" });
  const vm = plan.findings.find((f) => f.kind === "vectors_missing");
  assert.equal(vm.count, 1);
  assert.equal(vm.affectedStores, 1);
});

test("renderPlanText: healthy plan says so; a total always renders with its gap", () => {
  const healthy = buildPlan({ gaps: [], totals: { stores: 5, records: 10 } }, { scope: "current" });
  assert.match(renderPlanText(healthy), /No problems in scope/);

  const withGap = buildPlan({
    gaps: [projGap("vectors_missing", "-x", { severity: "critical" })],
    totals: { stores: 5, records: 100, coverage: { vectors: { covered: 40, measuredRecords: 100, ratio: 0.4 } } },
  }, { scope: "all" });
  const text = renderPlanText(withGap);
  assert.match(text, /60 missing vectors/); // 100 - 40, rendered next to the total
  assert.match(text, /tmem sync --all/);
});
