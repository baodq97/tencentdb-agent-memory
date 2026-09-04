#!/usr/bin/env node
/**
 * tmem doctor — planner + renderer over the SAME snapshot the visualiser uses.
 *
 * PURE: snapshot in, plan out. No I/O, no store access, no fix execution. cli.js
 * owns extract+transform (identical to the view pipeline) and owns running the
 * fixes; this module only (a) maps each gap.kind to the command that repairs it
 * and its safety tier, and (b) renders the plan for a human or for an agent
 * (`--json`). There must never be a second definition of a health metric here —
 * every number comes off the snapshot buildGaps()/totals already computed. See
 * the same rule in persona_projection.js's header.
 */
"use strict";

// ── Fix mapping: gap.kind → how it is repaired ──
//
// tier:
//   auto    — idempotent + additive, cannot lose data (safe under `--fix`).
//   confirm — removes records; every such primitive ARCHIVES before deleting, so
//             it is reversible, but it still asks before running (`--fix --apply`).
//   manual  — needs a human decision or the write-side consolidator; doctor only
//             surfaces it, never runs it.
//
// A kind with no entry falls through to `manual` with the gap's own `suggestion`
// string (many GAP_KINDs — orphaned vectors, capture backlog, unreadable store —
// have no doctor primitive and legitimately land there), so a new gap kind
// degrades to "reported, not auto-fixed" rather than being silently dropped.
//
// `command` is a function of scope: the vector fix repairs current+global
// (`tmem sync`) or every store (`tmem sync --all`) depending on what doctor
// examined, so the scope decision is made ONCE here instead of writing "--all"
// and stripping it back off later.
const FIX_BY_KIND = {
  vectors_missing:      { tier: "auto",    command: (s) => (s === "all" ? "tmem sync --all" : "tmem sync") },
  vectors_unmeasurable: { tier: "auto",    command: (s) => (s === "all" ? "tmem sync --all" : "tmem sync") },
  // --full, not a delta sync: the vectors are all PRESENT, they are just from the
  // wrong generation, so a delta pass finds nothing missing and changes nothing.
  // Only a full re-embed replaces them, and only a full re-embed re-stamps the
  // store — a partial pass deliberately leaves the stamp alone rather than bless
  // a half-migrated index.
  vectors_stale:        { tier: "auto",    command: (s) => (s === "all" ? "tmem sync --full --all" : "tmem sync --full") },
  duplicate_records:    { tier: "confirm", command: () => "tmem dedup --atoms --apply" },
  low_signal_records:   { tier: "confirm", command: () => "tmem prune --low-signal --apply" },
  scene_invisible:      { tier: "manual",  command: () => "tmem config scene-max-tokens <n>" },
  persona_unprojected:  { tier: "manual",  command: () => "re-consolidate persona (bullet exceeds tier-0 budget)" },
};

const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 };
const TIER_RANK = { auto: 0, confirm: 1, manual: 2 };

/**
 * Is this gap in the requested scope?
 *
 * scope "all"     → every gap.
 * scope "current" → root-level gaps (persona, whole-store noise) always count;
 *                   store-scoped gaps only when they name global or the current
 *                   project. This mirrors recall, which sees current + global.
 */
function gapInScope(gap, { scope, currentSlug }) {
  if (scope === "all") return true;
  const subj = gap && gap.subject;
  if (!subj || subj.scope !== "project") return true; // root/persona gaps
  return subj.slug === "global" || (currentSlug && subj.slug === currentSlug);
}

function fixFor(gap, scope) {
  const mapped = FIX_BY_KIND[gap.kind];
  if (mapped) return { command: mapped.command(scope), tier: mapped.tier, reversible: true };
  return { command: gap.suggestion || null, tier: "manual", reversible: true };
}

/**
 * Group the in-scope gaps by kind into findings the plan reports. One finding per
 * kind: its severity, how many stores it hit, up to a few affected labels, and
 * the fix. Detail (every affected slug) stays on `affectedSlugs` for an agent
 * that wants to act per store.
 */
function buildFindings(gaps, opts) {
  const byKind = new Map();
  for (const g of gaps) {
    if (!gapInScope(g, opts)) continue;
    const key = g.kind;
    if (!byKind.has(key)) {
      byKind.set(key, {
        kind: g.kind,
        severity: g.severity,
        count: 0,
        // Unmeasured gaps are "could not check", not "found a problem" — counted
        // separately so they never inflate the defect count or a fix tier.
        unmeasured: 0,
        affectedSlugs: [],
        affectedLabels: [],
        fix: fixFor(g, opts.scope),
      });
    }
    const f = byKind.get(key);
    if (g.unmeasured) f.unmeasured += 1;
    else f.count += 1;
    const subj = g.subject || {};
    if (subj.slug && !f.affectedSlugs.includes(subj.slug)) f.affectedSlugs.push(subj.slug);
    if (subj.label && f.affectedLabels.length < 5 && !f.affectedLabels.includes(subj.label)) {
      f.affectedLabels.push(subj.label);
    }
  }
  return [...byKind.values()].sort((a, b) =>
    (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
    (TIER_RANK[a.fix.tier] ?? 3) - (TIER_RANK[b.fix.tier] ?? 3) ||
    b.count - a.count
  );
}

/**
 * Verdict from the findings actually in scope — NOT from the store-wide
 * gapsBySeverity, because a `--fix` run in one project should be judged on that
 * project's gaps, not on 40 other stores it will not touch.
 */
function verdictFrom(findings) {
  if (findings.some((f) => f.severity === "critical" && f.count > 0)) return "critical";
  if (findings.some((f) => f.severity === "warn" && f.count > 0)) return "warn";
  return "ok";
}

/**
 * The machine-readable plan. `snapshot` is a transformRoot() result. `opts`:
 *   scope        "current" (default) | "all"
 *   currentSlug  project slug for the cwd (from getDirs().pHash), or ""
 */
function buildPlan(snapshot, opts = {}) {
  const scope = opts.scope === "all" ? "all" : "current";
  const currentSlug = opts.currentSlug || "";
  const gaps = Array.isArray(snapshot && snapshot.gaps) ? snapshot.gaps : [];
  // fixFor() already derives the scope-correct command (current → `tmem sync`,
  // all → `tmem sync --all`), so there is no post-hoc rewrite here.
  const findings = buildFindings(gaps, { scope, currentSlug });

  const counts = { auto: 0, confirm: 0, manual: 0 };
  for (const f of findings) if (f.count > 0) counts[f.fix.tier] = (counts[f.fix.tier] || 0) + 1;

  const t = (snapshot && snapshot.totals) || {};
  const cov = (t.coverage && t.coverage.vectors) || {};
  const vectorsCovered = typeof cov.covered === "number" ? cov.covered : null;
  const vectorsMeasured = typeof cov.measuredRecords === "number" ? cov.measuredRecords : null;
  const vectorsMissing =
    vectorsMeasured != null && vectorsCovered != null ? vectorsMeasured - vectorsCovered : null;

  return {
    verdict: verdictFrom(findings),
    generatedAt: snapshot && snapshot.generatedAt,
    snapshotId: snapshot && snapshot.snapshotId,
    scope,
    currentSlug: currentSlug || null,
    totals: {
      stores: t.stores ?? null,
      records: t.records ?? null,
      scenes: t.scenes ?? null,
      vectorsCovered,
      vectorsMissing,
      vectorRatio: typeof cov.ratio === "number" ? Number(cov.ratio.toFixed(4)) : null,
      // PRUNABLE, not the 6-class union. The header sits directly above a
      // "fix: tmem prune --low-signal --apply" line, and the union counts three
      // classes prune never deletes -- it printed "897 low-signal" while a dry
      // run matched 0 records across all 86 stores. The union is still available
      // on the finding's evidence for anyone auditing the corpus.
      lowSignal: (t.lowSignal && t.lowSignal.prunableRecords) ?? null,
      duplicates: (t.duplicates && t.duplicates.exact) ?? null,
    },
    findings: findings.map((f) => ({
      kind: f.kind,
      severity: f.severity,
      count: f.count,
      unmeasured: f.unmeasured,
      affectedStores: f.affectedSlugs.length,
      affectedSample: f.affectedLabels,
      fix: f.fix,
    })),
    autoFixable: counts.auto,
    confirmRequired: counts.confirm,
    manual: counts.manual,
  };
}

// ── Text rendering ──

const VERDICT_ICON = { ok: "🟢", warn: "🟡", critical: "🔴" };
const SEV_ICON = { critical: "🔴", warn: "🟡", info: "🔵" };

function renderPlanText(plan) {
  const out = [];
  const icon = VERDICT_ICON[plan.verdict] || "";
  out.push(`${icon} memory health: ${plan.verdict.toUpperCase()}  (scope: ${plan.scope}${plan.currentSlug ? ` — ${plan.currentSlug}` : ""})`);

  const t = plan.totals;
  // A total never renders without its gap (the visualiser's rule).
  const bits = [];
  if (t.stores != null) bits.push(`${t.stores} stores`);
  if (t.records != null) bits.push(`${t.records} records`);
  if (t.vectorsMissing != null) bits.push(`${t.vectorsMissing} missing vectors (${Math.round((t.vectorRatio ?? 0) * 100)}% covered)`);
  if (t.lowSignal != null) bits.push(`${t.lowSignal} prunable low-signal`);
  if (t.duplicates != null) bits.push(`${t.duplicates} duplicate`);
  if (bits.length) out.push("  " + bits.join(" · "));

  if (!plan.findings.length) {
    out.push("\nNo problems in scope. ✓");
    return out.join("\n");
  }

  out.push("");
  out.push(`Findings (${plan.autoFixable} auto-fixable · ${plan.confirmRequired} confirm · ${plan.manual} manual):`);
  for (const f of plan.findings) {
    const sev = SEV_ICON[f.severity] || " ";
    const n = f.count + (f.unmeasured ? `+${f.unmeasured}?` : "");
    const where = f.affectedStores > 0 ? ` [${f.affectedSample.join(", ")}${f.affectedStores > f.affectedSample.length ? ", …" : ""}]` : "";
    out.push(`  ${sev} ${f.kind}  ×${n}  (${f.fix.tier})${where}`);
    out.push(`      fix: ${f.fix.command || "(no automated fix)"}`);
  }

  out.push("");
  out.push(plan.autoFixable > 0
    ? "Run `tmem doctor --fix` to apply the auto-fixable set (idempotent), or `--json` for the full plan."
    : "No auto-fixable findings. Review the confirm/manual fixes above, or `--json` for the full plan.");
  return out.join("\n");
}

// ── Upgrade nudges (pure) ──
//
// After a plugin upgrade, the new memory features (compressed/scrubbed global
// persona, per-project doctrine + PreToolUse guardrails) are LATENT: existing data
// isn't migrated, it activates on the next consolidation. There is no schema
// migration (schema is unchanged, all additive), so instead of a migration script
// we nudge the user to re-consolidate when a store still shows the old shape.
//
// Pure: takes plain data (no store access), returns hint strings. cli.js gathers
// the persona texts + atom count and prints these under `tmem doctor`.
function buildUpgradeNudges({ globalPersona, projectPersona, projectAtomCount, globalAtomCount } = {}, opts = {}) {
  const out = [];
  const gp = String(globalPersona || "");
  // Recovery (upstream P2.5 parity): memories exist but the persona document is
  // missing or was wiped — nudge a re-consolidation to rebuild it from atoms.
  if (!gp.trim() && (globalAtomCount || 0) > 0) {
    out.push(`You have ${globalAtomCount} global memories but no persona document — the tier-0 <persona-core> block is empty until you rebuild it: /memory-consolidate`);
  }
  if (gp.trim()) {
    let budget = null;
    try { budget = require("./persona_projection.js").checkPersonaBudget(gp, opts.maxChars ? { maxChars: opts.maxChars } : {}); } catch {}
    if (budget && !budget.ok) {
      const drop = budget.violations.find((v) => v.kind === "tier0_overflow");
      out.push(
        drop
          ? `Global persona over budget — ${drop.droppedCount} of ${drop.alwaysCount} standing rules are silently dropped at session start. Re-consolidate to compress: /memory-consolidate`
          : `Global persona has over-long bullets (>160 chars) that waste the tier-0 budget. Re-consolidate to split them: /memory-consolidate`,
      );
    }
    let sensitive = false;
    try { sensitive = require("./redact.js").isSensitive(gp); } catch {}
    if (sensitive) {
      out.push("Global persona contains sensitive/infra values (secrets / redirect URIs / cloud ids) that leak into every project. Re-consolidate to scrub them, or move them to --scope project: /memory-consolidate");
    }
  }
  if ((projectAtomCount || 0) > 0 && !String(projectPersona || "").trim()) {
    out.push(`This project has ${projectAtomCount} memories but no Operating Doctrine yet — the <project-doctrine> block and PreToolUse guardrails stay empty until you consolidate: /memory-consolidate`);
  }
  return out;
}

module.exports = {
  FIX_BY_KIND,
  gapInScope,
  fixFor,
  buildFindings,
  verdictFrom,
  buildPlan,
  renderPlanText,
  buildUpgradeNudges,
};
