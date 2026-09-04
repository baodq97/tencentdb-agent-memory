#!/usr/bin/env node
/**
 * The `<scene-navigation>` block: rendering only, no I/O.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Two callers need the same answer about the same block, from opposite ends:
 *
 *   - `memory_recall.buildSceneNav()` needs the TEXT to inject into a turn.
 *   - `view/transform.sceneNavVisibility()` needs the COUNT — how many scenes
 *     actually fit — to report `visibleInNav` / `invisibleInNav` and to raise the
 *     "written but never seen" gap.
 *
 * Until this file existed, the second was a hand copy of the first: the fill
 * loop, the sort, the `+2` newline-joiner allowance, the 80-char summary cut, the
 * emoji ladder, the header/footer/guide literals. Nothing forced them to agree,
 * and the divergence had already started — `memory_recall`'s ATOM loops changed
 * `break` to `continue` in the same branch that added the copy. When that fix
 * reaches the scene loop, a stale copy would keep reporting scenes as invisible
 * that the agent can see, and the gap built on it would fire on nothing. Sharing
 * the core makes that a one-line change in one place, which is the whole point.
 *
 * It could not simply be exported from memory_recall.js: transform.js is pure by
 * test (`view_transform.test.js` asserts memory_recall.js never enters
 * require.cache, and requiring it pulls in memory_store.js -> node:sqlite). So the
 * core lives here and BOTH sides import it — the same arrangement
 * persona_projection.js already has with the projection.
 *
 * The module used to require nothing at all. It now requires grounding.js and
 * persona_projection.js, and only those: both are pure string math with no fs, no
 * db and no config, and transform.js already imports persona_projection.js, so
 * the dependency the purity test actually guards (memory_store -> node:sqlite) is
 * still nowhere near this file. The reason for taking them is `rankScenes` below:
 * the alternative was a second, subtly different relevance scorer.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT
 * ---------------------------------
 * Here: ranking a list of scenes against a query and rendering it into a budgeted
 * block. Not here: finding the scenes (fs), deciding GROUP order (`buildSceneNav`
 * puts project scenes before global ones so global drops first under budget — a
 * recall policy, not a rendering rule), or resolving the budget from config.
 * Callers hand in an ALREADY-NORMALISED list, so neither caller's row shape leaks
 * in here and the core cannot start special-casing one of them.
 */
"use strict";

const { significantTokens } = require("./grounding.js");
const { buildIdf, relevanceScore } = require("./persona_projection.js");
/**
 * Token→char factor shared with memory_recall.js and the persona budgets. Read
 * from the leaf rather than redeclared: this file used to carry its own `= 4`,
 * which is exactly the drift persona_projection's copy of the comment warns
 * about. Re-exported because transform.js imports it from here.
 */
const { CHARS_PER_TOKEN } = require("./constants.js");

/**
 * Literal parts of the block. Exported because the view reports the budget
 * arithmetic these produce, and a second copy of the header string would put the
 * two modules' char accounting quietly out of step.
 */
const NAV = Object.freeze({
  HEADER: "<scene-navigation>",
  FOOTER: "</scene-navigation>",
  GUIDE: "Load a full scene on demand: `tmem scene <name>`.",
  SUMMARY_MAX_CHARS: 80,
  /** header + guide + footer are joined by 2 newlines before any line is added. */
  JOINER_CHARS: 2,
});

/**
 * Fire-emoji cue based on scene heat (visual priority for the agent).
 *
 * THE LADDER NOW MATCHES THE SCALE THAT IS ACTUALLY WRITTEN. It used to start at
 * 50 and climb to 1000, while `skills/memory-consolidate/SKILL.md` tells the
 * writer "heat 4-5: active this week, 2-3: recent, 1: historical" — so across
 * 219 real scenes it rendered exactly zero flames and the cue was dead code
 * (the view reports this as `heat_scale_mismatch`).
 *
 * Two rungs, not five. Every rung costs chars on the per-turn nav line, and the
 * live distribution is degenerate — 130 of 219 scenes sit at heat 5 and 50 at
 * heat 4 — so a rung per heat value would spend budget on a cue that does not
 * discriminate. "Active this week" (4-5) is the only distinction the documented
 * scale actually makes, so that is the only distinction drawn: 5 gets two
 * flames, 4 gets one, 1-3 get none. Ranking is `rankScenes`'s job, not the
 * emoji's.
 *
 * `scripts/view/contract.js:HEAT_SCALE.READER_FIRST_FLAME_AT` states the first
 * rung independently and transform.js asserts the two agree at load — change
 * both or neither.
 */
function heatEmoji(heat) {
  if (heat >= 5) return " 🔥🔥";
  if (heat >= 4) return " 🔥";
  return "";
}

/** Word-boundary-preferring cut with an ellipsis. */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const last = cut.lastIndexOf(" ");
  return (last > 0 ? cut.slice(0, last) : cut) + "...";
}

/**
 * One rendered nav line for one scene. Exported for tests and for anything that
 * needs to know what a scene costs without rendering the whole block.
 *
 * @param {{name: string, heat: number|string, summary: string}} scene
 */
function navLine(scene) {
  const heat = parseInt(scene && scene.heat, 10) || 0;
  const name = String((scene && scene.name) || "");
  const summary = truncate(String((scene && scene.summary) || "").trim(), NAV.SUMMARY_MAX_CHARS);
  return `- ${name} (heat=${heat}${heatEmoji(heat)})${summary ? " " + summary : ""}`;
}

/** The text a scene is scored on: what the nav line itself shows. */
function sceneText(scene) {
  return `${(scene && scene.name) || ""} ${(scene && scene.summary) || ""}`.trim();
}

/** Heat as the renderer reads it. `parseInt` — see {@link byHeatDesc}. */
const heatOf = (s) => parseInt(s && s.heat, 10) || 0;

/**
 * The FALLBACK order every caller hands to {@link rankScenes}: heat descending,
 * input order preserved within a heat (Array#sort is stable).
 *
 * WHY IT IS HERE AND NOT AT THE CALL SITES. `rankScenes` is an exact no-op for an
 * empty query, which makes the caller-supplied order load-bearing — it IS the
 * rendered order on every turn with no prompt text. And `transform.sceneNavVisibility()`
 * must reproduce whatever `memory_recall.buildSceneNav()` does, exactly, or the
 * `visibleInNav` count it reports is a count of a different block. Both spelled
 * this sort out by hand and they had already diverged on coercion:
 * `parseInt(x, 10) || 0` on one side, `Number(x) || 0` on the other.
 *
 * `parseInt` is the one kept, because it is what the RENDERER uses: `navLine()`
 * prints `heat=${parseInt(...)}` and `rankScenes` breaks ties with the same
 * reading. An order sorted by `Number` could therefore disagree with the numbers
 * printed on the very lines it ordered ("4.7" prints as 4 but sorts above 5's
 * neighbours; "5x" prints as 5 but sorts as 0). Heat is written as a small
 * integer by the consolidator; where it is not, matching the printed value is the
 * only reading with a defensible meaning.
 *
 * @param {Array<{heat: number|string}>} scenes
 * @returns {Array} A new array; the input is never mutated.
 */
function byHeatDesc(scenes) {
  return (Array.isArray(scenes) ? scenes : []).slice().sort((a, b) => heatOf(b) - heatOf(a));
}

/**
 * Order one group of scenes by relevance to `query`.
 *
 * WHY: the nav block was byte-identical on every turn. With 219 scenes and an
 * 800-char budget it showed the same 78 and the other 141 were unreachable —
 * ~557 chars/turn of context that could not, even in principle, respond to what
 * was being asked. Heat cannot fix that on its own: 180 of the 219 scenes are
 * heat 4 or 5, so 82% of the store is tied for first place and the sort
 * degenerates into "whatever the directory listing happened to yield".
 *
 * So relevance is primary and heat is the tiebreak, not the other way round. The
 * scorer is persona_projection's — the same idf + weighted-coverage function
 * tier 1 ranks persona bullets with — rather than a second one written here.
 * The idf corpus is the scene list itself, which is what makes it discriminate:
 * "memory" appears in most scene names and is worth ~nothing, "tencentdb" or
 * "vector" appears in a handful and decides the slice.
 *
 * NO DECAY. Heat is used exactly as written; recomputing or ageing it is the
 * writer's business, not the reader's.
 *
 * EMPTY QUERY IS AN EXACT NO-OP — the caller's order is returned untouched, so
 * a turn with no prompt text renders byte-for-byte what it rendered before.
 * That is also why this ranks ONE GROUP: `buildSceneNav` ranks project scenes
 * and global scenes separately and concatenates, because which group drops first
 * under budget is a recall policy that relevance must not be able to overturn.
 *
 * @param {Array<{name: string, heat: number|string, summary: string}>} scenes
 *   Normalised rows, already in the caller's fallback order (heat desc).
 * @param {string} query The current prompt.
 * @returns {Array} A new array; the input is never mutated.
 */
function rankScenes(scenes, query) {
  const list = Array.isArray(scenes) ? scenes : [];
  const qTokens = new Set(significantTokens(query || ""));
  if (!qTokens.size || list.length < 2) return list.slice();

  // buildIdf reads `.text` off each item and keys its token cache by identity,
  // so the wrapper is what gets passed in and what gets looked up.
  const docs = list.map((s, i) => ({ scene: s, i, text: sceneText(s) }));
  const { idf, tokens } = buildIdf(docs);

  return docs
    .map((d) => ({ d, score: relevanceScore(d.text, qTokens, idf, tokens.get(d)) }))
    // Relevance first; heat only separates scenes the query cannot tell apart —
    // which includes every scene scoring 0, so an unmatched tail keeps exactly
    // the order it arrived in.
    .sort((x, y) => y.score - x.score || heatOf(y.d.scene) - heatOf(x.d.scene) || x.d.i - y.d.i)
    .map((x) => x.d.scene);
}

/**
 * Render the block, filling top-down until the next line would overflow.
 *
 * The fill BREAKS rather than skipping: one oversized line hides every scene
 * behind it. That is current behaviour and is preserved verbatim by this
 * extraction — changing it is a behaviour change, and now it is a change to one
 * loop instead of two.
 *
 * @param {Array<{name: string, heat: number|string, summary: string}>} orderedScenes
 *   Already sorted by the caller's policy and already normalised: `name` carries
 *   NO `.md` extension. `name` was chosen over `filename` because it is what the
 *   block actually prints and what the agent types back (`tmem scene <name>`) —
 *   the extension is a storage detail of whoever read the directory, and the two
 *   callers disagreed about it (`listScenes` yields `filename`, the view yields a
 *   stripped `name`). Normalising at the boundary keeps that disagreement out of
 *   here.
 * @param {number} maxChars Budget for the whole block. <= 0 renders nothing.
 * @returns {{text: string, visibleCount: number, usedChars: number, totalCount: number}}
 *   `text` is "" when nothing renders — no budget, no scenes, or not even one
 *   line fitting. `usedChars` counts the header/guide/footer scaffolding even
 *   when `text` is "", because that is the budget arithmetic the view reports.
 */
function renderSceneNav(orderedScenes, maxChars) {
  const list = Array.isArray(orderedScenes) ? orderedScenes : [];
  const scaffold = NAV.HEADER.length + NAV.GUIDE.length + NAV.FOOTER.length + NAV.JOINER_CHARS;

  if (!maxChars || maxChars <= 0) {
    return { text: "", visibleCount: 0, usedChars: 0, totalCount: list.length };
  }

  let used = scaffold;
  const lines = [];
  for (const s of list) {
    const line = navLine(s);
    if (used + line.length + 1 > maxChars) break; // top-down fill; the tail drops first
    lines.push(line);
    used += line.length + 1;
  }

  return {
    text: lines.length
      ? `${NAV.HEADER}\n${NAV.GUIDE}\n${lines.join("\n")}\n${NAV.FOOTER}`
      : "",
    visibleCount: lines.length,
    usedChars: used,
    totalCount: list.length,
  };
}

/**
 * Rank DISTILLED scene-body facts against the query and render them into a
 * `<recalled-facts>` block. This is the pivot: per-turn recall surfaces the
 * facts consolidation already distilled into scenes (Key Facts / Decisions
 * bullets), instead of raw episodic turns that only echo the conversation.
 *
 * Pure: the caller (memory_recall.readSceneFacts) owns the fs read and hands in
 * already-parsed facts, mirroring how rankScenes takes normalised rows. Reuses
 * the same buildIdf/relevanceScore scorer as scenes and persona so a fact ranks
 * by discriminating tokens, not raw overlap.
 *
 * @param {Array<{sceneName: string, heat?: number|string, text: string}>} facts
 * @param {string} query
 * @param {{limit?: number, maxChars?: number}} [opts]
 * @returns {{facts: Array, block: string, usedChars: number}}
 */
function rankSceneFacts(facts, query, opts = {}) {
  const limit = Math.max(1, opts.limit ?? 5);
  const maxChars = Math.max(0, opts.maxChars ?? 700);
  const list = (Array.isArray(facts) ? facts : []).filter((f) => f && String(f.text || "").trim());
  if (!list.length || maxChars === 0) return { facts: [], block: "", usedChars: 0 };

  const qTokens = new Set(significantTokens(query || ""));
  const docs = list.map((f, i) => ({ f, i, text: String(f.text) }));

  // No query signal → fall back to heat then document order (fresh scenes first),
  // so the block is still useful on an empty/stopword-only prompt.
  let ordered;
  if (qTokens.size) {
    const { idf, tokens } = buildIdf(docs);
    let scored = docs.map((d) => ({ d, score: relevanceScore(d.text, qTokens, idf, tokens.get(d)) }));
    // idf zero-weights any token present in > COMMON_DF_RATIO of the corpus, which
    // on a SMALL fact pool can zero every query token and score everything 0. Fall
    // back to plain significant-token overlap so ranking still discriminates — the
    // idf path stays primary on the large real corpus where it works.
    if (scored.every((x) => x.score === 0)) {
      scored = docs.map((d) => {
        const dt = tokens.get(d) || new Set(significantTokens(d.text));
        let hit = 0;
        for (const t of qTokens) if (dt.has(t)) hit++;
        return { d, score: hit / qTokens.size };
      });
    }
    ordered = scored
      .sort((x, y) => y.score - x.score || heatOf(y.d.f) - heatOf(x.d.f) || x.d.i - y.d.i)
      .filter((x) => x.score > 0) // an unmatched fact is an echo risk — drop it, don't pad
      .map((x) => x.d);
  } else {
    ordered = docs.slice().sort((a, b) => heatOf(b.f) - heatOf(a.f) || a.i - b.i);
  }

  return renderFactDocs(ordered, limit, maxChars);
}

/**
 * Shared render tail for the `<recalled-facts>` block: dedup, budget-fill (skip
 * don't break), and wrap. Takes docs already ORDERED by whatever scorer (keyword
 * or semantic) chose, so the two rankers cannot drift on rendering.
 */
function renderFactDocs(ordered, limit, maxChars) {
  const chosen = [];
  const seen = new Set();
  let used = 0;
  for (const d of ordered) {
    const text = String(d.f.text).trim();
    const key = text.slice(0, 50).toLowerCase();
    if (seen.has(key)) continue; // same fact carried by two scenes → keep one
    if (used + text.length + 3 > maxChars) continue; // skip, don't break: let a shorter fact behind fit
    seen.add(key);
    used += text.length + 3;
    chosen.push({ sceneName: d.f.sceneName || "", heat: d.f.heat, text });
    if (chosen.length >= limit) break;
  }

  if (!chosen.length) return { facts: [], block: "", usedChars: 0 };
  const body = chosen.map((f) => `- ${f.text}${f.sceneName ? ` (${f.sceneName})` : ""}`).join("\n");
  const block = `<recalled-facts>\nDistilled facts from past sessions, ranked for this turn (full scene: \`tmem scene <name>\`):\n${body}\n</recalled-facts>`;
  return { facts: chosen, block, usedChars: block.length };
}

// A distilled fact and a paraphrase of the question that asks it share few rare
// keywords (measured: keyword ranking surfaced 48% of facts for reworded queries
// vs 95% by embedding cosine). So rank by MEANING when a query vector is available.
// Floor guards the negative-control property: an off-topic query (weather, math)
// must surface NOTHING, not the least-unrelated fact.
//
// 0.55, NOT 0.4. The original 0.4 came from bench/uq_floor_probe.js sweeping the
// candidate grid [0.25, 0.3, 0.35, 0.4] against FOUR off-topic queries — the grid's
// maximum is the value that shipped, so nothing above 0.4 was ever evaluated. The
// assumption in the old comment ("baseline similarity for unrelated text sits well
// under this") is false for this 768-d model: measured on 20 off-topic queries,
// an unrelated query clears 0.4 against a MEDIAN of 29 of the 90 in-scope facts,
// and every one of the 20 produced a non-empty block.
//
// Re-measured 2026-09-04, top-1 cosine, daemon warm:
//   OFF-topic (n=20): min 0.399  p50 0.497  max 0.533
//   ON-topic  (n=10): min 0.519  p50 0.627  max 0.763
// The two populations overlap only in [0.519, 0.533], so 0.55 sits above every
// off-topic top-1 and below all but one on-topic top-1. Trade is explicit and
// pre-registered in bench/RESULT_RECALL_PRECISION.md: off-topic block emission
// 20/20 -> 0/20, on-topic 10/10 -> 9/10 (loses "scene heat là gì" at 0.519).
//
// Re-tune only with bench/negative_control.json in the loop; a sweep whose top
// candidate is the incumbent cannot discover that the incumbent is too low.
//
// PROVISIONAL, AND FITTED TIGHT. Against the full 20-query control the off-topic
// maximum is 0.547, so 0.55 clears it by only 0.003 (the earlier 10-query probe
// read 0.533 and was flattering). The margin is thin because the two populations
// barely separate at all on RAW embeddings — measured gap 0.009. That is a
// property of embedding query and document with no EmbeddingGemma prompt prefix,
// which is what embedding_service.js does today. Measured A/B: adding the prefix
// widens the gap to 0.071 and moves this constant DOWN to ~0.41, while lifting
// Recall@1 73.3% -> 83.3% and Recall@5 96.7% -> 100%. Re-derive here, not by
// intuition — the constant moves down, not up. bench/RESULT_RECALL_PRECISION.md.
const SEMANTIC_FACT_FLOOR = 0.55;

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den ? dot / den : -1;
}

/**
 * Semantic sibling of rankSceneFacts: rank distilled facts by embedding cosine
 * against the query vector instead of keyword overlap. PURE — the caller owns all
 * embedding I/O and hands in `factVecs` parallel to `facts` (a vector per fact,
 * or null/undefined for a fact that could not be embedded). Unlike the keyword
 * path it does NOT hard-drop a zero-keyword-overlap fact; it drops only facts
 * below SEMANTIC_FACT_FLOOR so an off-topic query yields an empty block.
 *
 * @param {Array<{sceneName: string, heat?: number|string, text: string}>} facts
 * @param {number[]} queryVec
 * @param {Array<number[]|null>} factVecs  parallel to `facts`
 * @param {{limit?: number, maxChars?: number, floor?: number}} [opts]
 */
function rankSceneFactsSemantic(facts, queryVec, factVecs, opts = {}) {
  const limit = Math.max(1, opts.limit ?? 5);
  const maxChars = Math.max(0, opts.maxChars ?? 700);
  const floor = opts.floor ?? SEMANTIC_FACT_FLOOR;
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length || maxChars === 0 || !queryVec) return { facts: [], block: "", usedChars: 0 };

  const scored = list
    .map((f, i) => ({ d: { f, i, text: String(f.text || "") }, score: cosineSim(queryVec, factVecs && factVecs[i]) }))
    .filter((x) => x.d.text.trim() && x.score >= floor)
    .sort((x, y) => y.score - x.score || heatOf(y.d.f) - heatOf(x.d.f) || x.d.i - y.d.i)
    .map((x) => x.d);

  return renderFactDocs(scored, limit, maxChars);
}

module.exports = {
  CHARS_PER_TOKEN, NAV, heatEmoji, truncate, navLine, sceneText, byHeatDesc, rankScenes, renderSceneNav,
  rankSceneFacts, rankSceneFactsSemantic, SEMANTIC_FACT_FLOOR,
  // Exported so the atom floor in memory_recall.js scores similarity with the
  // SAME function the fact floor uses. Two hand-rolled cosines would be two
  // things to keep in agreement for no benefit.
  cosineSim,
};
