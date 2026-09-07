"use strict";
// Recall-reachability + capture-signal metrics — the goal-proximate graders that
// vector COVERAGE cannot express. Measured: coverage read 100% ("green") while
// half the stores had zero recallable memory, and 91% of a session's durable
// facts were dropped at capture (only the user's prompt is stored). Coverage
// answers "are vectors embedded"; these answer the actual goal: "can the agent
// recall what happened, and does capture keep the outcome or just the question".
//
// PURE: aggregates plain descriptors, no fs/store access. cli.js reads the store
// and passes the numbers in, so this is unit-testable without a real store.
//
// summarizeReachability() below denominates its "capture signal" entirely on
// the EPISODIC population — a real capture-volume signal, but not a recall-
// health number, because scripts/constants.js's NON_RECALL_TYPES excludes
// episodic (and persona) from ever being embedded or read back. Measured
// across 89 real stores: 5713 L1 records, of which only 115 (2.0%) are
// vector-eligible — the rest are structurally unreachable BY DESIGN, not
// broken. summarizeEligibleReachability() below is the honest recall-health
// number: it denominates over the eligible population only.

const { isVectorEligible } = require("./constants.js");

// An atom carries an OUTCOME (not just a topic/question) when it names a result:
// a number, a path/symbol, a version, or a decision verb — and is not itself a
// question. Deliberately conservative: a false "outcome" inflates the signal
// score, which is the number we are trying to keep honest.
const OUTCOME_RE =
  /[/\\]|\bv?\d+\.\d+|\d{3,}|→|->|\b[\w-]+\.[\w-]{2,}\b|\b(fixed|fix|chose|decided|decision|shipped|measured|because|resolved|root[\s-]?cause|root)\b/i;
const QUESTION_RE = /\?\s*$/;

/**
 * True when an atom's text states a durable outcome rather than a bare prompt.
 * @param {string} text
 */
function isOutcomeBearing(text) {
  const t = String(text || "").trim();
  if (!t || t.length < 25) return false;      // too short to carry an outcome
  if (QUESTION_RE.test(t)) return false;       // a question is not a result
  return OUTCOME_RE.test(t);
}

/**
 * @param {Array<{slug:string, episodicCount:number, sceneCount:number, outcomeAtoms:number}>} stores
 * @returns {{
 *   storesWithEpisodic:number, reachableStores:number, blindStores:number,
 *   blindAtoms:number, reachablePct:number,
 *   totalEpisodic:number, outcomeAtoms:number, signalPct:number,
 *   blind: Array<{slug:string, episodicCount:number}>
 * }}
 */
function summarizeReachability(stores) {
  const list = Array.isArray(stores) ? stores : [];
  const withEpisodic = list.filter((s) => s && (s.episodicCount || 0) > 0);
  const reachable = withEpisodic.filter((s) => (s.sceneCount || 0) > 0);
  const blindList = withEpisodic.filter((s) => (s.sceneCount || 0) === 0);
  const blindAtoms = blindList.reduce((n, s) => n + (s.episodicCount || 0), 0);
  const totalEpisodic = withEpisodic.reduce((n, s) => n + (s.episodicCount || 0), 0);
  const outcomeAtoms = withEpisodic.reduce((n, s) => n + (s.outcomeAtoms || 0), 0);
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  return {
    storesWithEpisodic: withEpisodic.length,
    reachableStores: reachable.length,
    blindStores: blindList.length,
    blindAtoms,
    reachablePct: pct(reachable.length, withEpisodic.length),
    totalEpisodic,
    outcomeAtoms,
    signalPct: pct(outcomeAtoms, totalEpisodic),
    blind: blindList
      .map((s) => ({ slug: s.slug, episodicCount: s.episodicCount || 0 }))
      .sort((a, b) => b.episodicCount - a.episodicCount),
  };
}

/**
 * The recall-health reachability number: how many of the atoms that CAN be
 * recalled (isVectorEligible(type)) actually WERE, at least once, per the
 * recall log. Episodic/persona volume never enters this denominator — it is
 * reported separately by the caller as `ineligible`, a capture-volume figure,
 * never a recall-health percentage.
 *
 * @param {Array<{id:string, type:string}>} atoms
 * @param {Set<string>|Array<string>} injectedIds  ids the recall log shows were
 *   ever injected into a session (i.e. "hot" at least once).
 * @returns {{eligible:number, hot:number, cold:number, hotPct:number, ineligible:number}}
 */
function summarizeEligibleReachability(atoms, injectedIds) {
  const list = Array.isArray(atoms) ? atoms : [];
  const injected = injectedIds instanceof Set ? injectedIds : new Set(injectedIds || []);
  let eligible = 0;
  let hot = 0;
  let ineligible = 0;
  for (const a of list) {
    if (!a) continue;
    if (isVectorEligible(a.type)) {
      eligible += 1;
      if (injected.has(a.id)) hot += 1;
    } else {
      ineligible += 1;
    }
  }
  const cold = eligible - hot;
  const hotPct = eligible > 0 ? Math.round((hot / eligible) * 100) : 0;
  return { eligible, hot, cold, hotPct, ineligible };
}

module.exports = {
  isOutcomeBearing,
  summarizeReachability,
  summarizeEligibleReachability,
  OUTCOME_RE,
};
