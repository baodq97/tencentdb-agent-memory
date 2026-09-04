"use strict";
// GAP-6 — the feedback loop. Recall is a one-way push today: every turn injects
// ranked atoms into <memories> and logs which ids it chose (recall_log.jsonl,
// injectedIds), but nothing reads that back, so the store cannot tell a memory
// that earns its keep from one that has never once been recalled. This module
// closes the loop deterministically: it tallies the recall log into per-atom
// usage, and cli.js cross-references that against the store to name the COLD
// atoms (stored, never injected) — the ones a prune should target first.
//
// "Injected" is a proxy for "used": we can see what the ranker surfaced, not what
// the model then leaned on. It is the best signal available on-path and it is
// honest — an atom never injected was certainly never used.
//
// PURE: log rows in, aggregates out. No fs; cli.js reads the file and the store.

/**
 * Tally recall-log rows into per-atom injection stats.
 * @param {Array<{at?:string, source?:string, query?:string, injectedIds?:string[]}>} entries
 * @returns {{
 *   turns:number, injections:number, uniqueAtoms:number, emptyTurns:number,
 *   perAtom: Array<{id:string, count:number, lastAt:string}>,
 *   injectedIds: Set<string>
 * }}
 */
function summarizeRecallFeedback(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byId = new Map(); // id -> { id, count, lastAt }
  let injections = 0;
  let factInjections = 0;
  let emptyTurns = 0;

  for (const e of list) {
    const ids = (e && Array.isArray(e.injectedIds) ? e.injectedIds : []).filter(Boolean);
    const factIds = (e && Array.isArray(e.injectedFactIds) ? e.injectedFactIds : []).filter(Boolean);
    // Facts are tallied in the SAME map as atoms. They are different populations
    // with different id lifecycles, but the question this module answers -- "did
    // anything the store holds ever reach a turn?" -- is the same question for
    // both, and a second parallel map would mean every caller had to remember to
    // ask twice. The `fact:` prefix keeps them distinguishable in `perAtom`.
    for (const id of factIds) {
      factInjections++;
      const cur = byId.get(id);
      if (cur) { cur.count++; if ((e.at || "") > cur.lastAt) cur.lastAt = e.at || ""; }
      else byId.set(id, { id, count: 1, lastAt: (e && e.at) || "" });
    }
    // "Recalled nothing" must mean the TURN injected nothing. Counting a turn as
    // empty because it carried no ATOMS was how this metric came to report 55 of
    // 60 turns silent while every one of them injected scene facts.
    if (!ids.length && !factIds.length) { emptyTurns++; continue; }
    if (!ids.length) continue;
    const at = (e && e.at) || "";
    for (const id of ids) {
      injections++;
      const cur = byId.get(id);
      if (cur) {
        cur.count++;
        if (at > cur.lastAt) cur.lastAt = at; // ISO strings sort chronologically
      } else {
        byId.set(id, { id, count: 1, lastAt: at });
      }
    }
  }

  const perAtom = [...byId.values()].sort(
    (a, b) => b.count - a.count || (a.id < b.id ? -1 : 1)
  );
  return {
    turns: list.length,
    injections,
    // Split out so a reader can see WHICH surface is carrying the turns. Before
    // the relevance floor this was 0 and `injections` was everything; after it
    // the ratio inverted, and a single total would have hidden that entirely.
    factInjections,
    uniqueAtoms: byId.size,
    emptyTurns,
    perAtom,
    injectedIds: new Set(byId.keys()),
  };
}

/**
 * Split a store's atom ids into hot (injected ≥1) and cold (never injected),
 * given the feedback summary. Cold atoms are the prune candidates.
 * @param {Array<{id:string, content?:string, type?:string}>} storeAtoms
 * @param {ReturnType<typeof summarizeRecallFeedback>} summary
 * @returns {{hot:Array, cold:Array, coldPct:number}}
 */
function classifyStoreAtoms(storeAtoms, summary) {
  const injected = (summary && summary.injectedIds) || new Set();
  const list = Array.isArray(storeAtoms) ? storeAtoms : [];
  const hot = [];
  const cold = [];
  for (const a of list) {
    if (!a || !a.id) continue;
    (injected.has(a.id) ? hot : cold).push(a);
  }
  const total = hot.length + cold.length;
  const coldPct = total > 0 ? Math.round((cold.length / total) * 100) : 0;
  return { hot, cold, coldPct };
}

module.exports = { summarizeRecallFeedback, classifyStoreAtoms };
