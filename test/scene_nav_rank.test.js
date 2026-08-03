"use strict";
// R2 — query-ranked scene navigation.
//
// THE PROBLEM THESE TESTS PIN. The real store holds 219 scenes and the nav block
// has an 800-char budget, which fits 78 of them. The other 141 were not merely
// unlikely to appear — they were unreachable, because the order was heat-desc and
// nothing else, so the block was BYTE-IDENTICAL on every turn of every session.
// ~557 chars/turn of context that no prompt could redirect is not context, it is
// a tax. Heat cannot fix it on its own either: 180 of the 219 scenes are heat 4
// or 5, so 82% of the store is tied for first and the sort collapses into
// directory order.
//
// So the invariants below are: the slice MOVES with the query, an empty query
// moves NOTHING (the fallback must be byte-identical to the old behaviour), and
// the budget still holds. scene_nav.js is pure, so every fixture here is
// hand-built and nothing touches ~/.memory-tencentdb.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  NAV, heatEmoji, navLine, sceneText, byHeatDesc, rankScenes, renderSceneNav,
} = require("../scripts/scene_nav.js");

const scene = (name, summary, heat = 5) => ({ name, heat, summary });

/** Shaped like the live store: mostly heat 4-5, so heat alone cannot separate. */
function corpus() {
  return [
    scene("vector-index-sync", "sqlite-vec embedding sync and orphaned vector rows", 5),
    scene("vietnamese-fts-recall", "FTS5 tokenizer fixes for Vietnamese diacritics", 5),
    scene("persona-projection", "tiered persona duty-cycle and per-turn budget", 4),
    scene("hook-timeout-budget", "UserPromptSubmit latency and the 8s hook ceiling", 5),
    scene("scene-consolidation", "L1 atoms rolled into L2 scene blocks by the consolidator", 4),
    scene("cli-launcher-drift", "tmem launcher version resolution and self-heal", 2),
  ];
}

const names = (list) => list.map((s) => s.name);

// ── ranking ────────────────────────────────────────────────────────────────

test("rankScenes: the query decides the slice, not the directory listing", () => {
  const scenes = corpus();
  const vec = names(rankScenes(scenes, "why are vector embeddings orphaned in sqlite-vec"));
  const vi = names(rankScenes(scenes, "Vietnamese diacritics broke the FTS tokenizer"));

  assert.equal(vec[0], "vector-index-sync");
  assert.equal(vi[0], "vietnamese-fts-recall");
  assert.notDeepEqual(vec, vi, "two different prompts must not produce the same block");
});

test("rankScenes: a low-heat scene the query names outranks a heat-5 scene it does not", () => {
  // This is the whole point of demoting heat to a tiebreak. `cli-launcher-drift`
  // is the COLDEST scene in the fixture (heat 2, behind four scene-5s); a prompt
  // about the launcher must still surface it first.
  const ranked = names(rankScenes(corpus(), "tmem launcher self-heal picked the wrong version"));
  assert.equal(ranked[0], "cli-launcher-drift");
});

test("rankScenes: heat breaks ties, and only ties", () => {
  // Neither scene matches the query, so relevance is 0 for both and the input
  // order (heat desc, as buildSceneNav hands it over) must survive untouched.
  const scenes = [scene("alpha", "one", 5), scene("beta", "two", 4), scene("gamma", "three", 3)];
  assert.deepEqual(names(rankScenes(scenes, "completely unrelated kubernetes ingress")), ["alpha", "beta", "gamma"]);

  // Same text, different heat → identical relevance, so heat decides. Padded
  // with the wider corpus on purpose: the idf table zero-weights any token
  // carried by more than a quarter of the group, so a two-row group scores
  // every query at 0 and would pass this assertion for the wrong reason.
  const tied = [
    scene("cold-observability", "grafana dashboard notes", 2),
    scene("hot-observability", "grafana dashboard notes", 5),
    ...corpus(),
  ];
  assert.deepEqual(names(rankScenes(tied, "grafana dashboard")).slice(0, 2),
    ["hot-observability", "cold-observability"]);
});

test("rankScenes: an empty or absent query is an exact no-op", () => {
  const scenes = corpus();
  for (const q of ["", "   ", null, undefined]) {
    assert.deepEqual(rankScenes(scenes, q), scenes,
      "the pre-R2 ordering must be reproduced byte-for-byte when there is nothing to rank by");
  }
});

test("rankScenes: never mutates its input and never returns the same array", () => {
  const scenes = corpus();
  const before = names(scenes);
  const out = rankScenes(scenes, "vector embeddings");
  assert.notEqual(out, scenes);
  assert.deepEqual(names(scenes), before);
});

test("rankScenes: degenerate inputs rank rather than throw", () => {
  assert.deepEqual(rankScenes(null, "q"), []);
  assert.deepEqual(rankScenes(undefined, "q"), []);
  assert.deepEqual(rankScenes([], "q"), []);
  // Rows with nothing to score on are still returned, in arrival order.
  const blanks = [{ name: "", heat: 1, summary: "" }, { name: "", heat: 1, summary: "" }];
  assert.equal(rankScenes(blanks, "anything").length, 2);
});

test("sceneText: name and summary are both scored, so a bare name still matches", () => {
  assert.equal(sceneText({ name: "a", summary: "b" }), "a b");
  assert.equal(sceneText({ name: "a" }), "a");
  assert.equal(sceneText({}), "");
  // A scene with no summary is still reachable by its name alone — and it is the
  // coldest row in the group, so only the name can be lifting it.
  const scenes = [scene("kafka-partition-rebalance", "", 1), ...corpus()];
  assert.equal(names(rankScenes(scenes, "kafka partition rebalance"))[0], "kafka-partition-rebalance");
});

// ── budget ─────────────────────────────────────────────────────────────────

test("renderSceneNav: ranking does not buy scenes any extra budget", () => {
  const scenes = corpus();
  const budget = 300;
  for (const q of ["", "vector embeddings", "vietnamese tokenizer"]) {
    const out = renderSceneNav(rankScenes(scenes, q), budget);
    assert.ok(out.text.length <= budget, `block overflowed the budget for query ${JSON.stringify(q)}`);
    assert.ok(out.usedChars <= budget);
    assert.equal(out.totalCount, scenes.length);
    assert.ok(out.visibleCount < scenes.length, "the fixture must actually exercise the budget");
  }
});

test("renderSceneNav: the top-ranked scene is the one that survives the tightest budget", () => {
  const scenes = corpus();
  // Room for the scaffold plus a single line.
  const budget = NAV.HEADER.length + NAV.GUIDE.length + NAV.FOOTER.length + NAV.JOINER_CHARS + 90;
  const out = renderSceneNav(rankScenes(scenes, "orphaned sqlite-vec embeddings"), budget);
  assert.equal(out.visibleCount, 1);
  assert.ok(out.text.includes("vector-index-sync"));
});

// ── heat cue ───────────────────────────────────────────────────────────────

test("heatEmoji: fires on the 1-5 scale the consolidator actually writes", () => {
  // Before R2 the ladder started at 50 and every one of these returned "" — the
  // cue was dead code on all 219 scenes. skills/memory-consolidate/SKILL.md:
  // heat 4-5 active this week, 2-3 recent, 1 historical → the flame marks 4-5.
  assert.equal(heatEmoji(0), "");
  assert.equal(heatEmoji(1), "");
  assert.equal(heatEmoji(2), "");
  assert.equal(heatEmoji(3), "");
  assert.equal(heatEmoji(4), " 🔥");
  assert.equal(heatEmoji(5), " 🔥🔥");
});

test("heatEmoji: two rungs and no more — every rung is paid per turn", () => {
  // A legacy value from the old 50/100/1000 scale must not reopen a third rung:
  // the ladder is a cue, and ranking is rankScenes's job.
  assert.equal(heatEmoji(50), " 🔥🔥");
  assert.equal(heatEmoji(1000), " 🔥🔥");
});

test("navLine: the cue reaches the rendered line", () => {
  assert.ok(navLine(scene("s", "sum", 5)).includes("🔥"));
  assert.ok(navLine(scene("s", "sum", 4)).includes("🔥"));
  assert.ok(!navLine(scene("s", "sum", 3)).includes("🔥"));
  // Unparseable heat still renders a line rather than throwing.
  assert.ok(navLine({ name: "s", heat: undefined, summary: "" }).startsWith("- s (heat=0"));
});

// ── byHeatDesc — the fallback order, in one place ──
//
// rankScenes is an exact no-op for an empty query, so this ordering IS what the
// agent sees on a prompt that matches nothing, and view/transform.js has to
// reproduce it exactly for `visibleInNav` to count the block that actually
// renders. It used to be spelled by hand at both call sites, with different
// coercion: `parseInt(x, 10) || 0` in memory_recall.js, `Number(x) || 0` in
// transform.js.

test("byHeatDesc: heat descending, stable within a heat, input untouched", () => {
  const input = [scene("a", "", 2), scene("b", "", 5), scene("c", "", 5), scene("d", "", 4)];
  const out = byHeatDesc(input);
  assert.deepEqual(names(out), ["b", "c", "d", "a"]);
  assert.deepEqual(names(input), ["a", "b", "c", "d"], "the caller's array must not be mutated");
  assert.notEqual(out, input);
});

test("byHeatDesc: coerces heat the way the RENDERER reads it — parseInt, not Number", () => {
  // navLine prints parseInt(heat), so an order built on Number could disagree
  // with the numbers printed on the lines it ordered.
  // Under `Number` these coerce to NaN->0 and 4.7, which would put both BELOW
  // the heat-3 row; under parseInt they read 5 and 4, as printed.
  const rows = [{ name: "three", heat: 3 }, { name: "junk", heat: "5x" }, { name: "flt", heat: "4.7" }];
  assert.deepEqual(names(byHeatDesc(rows)), ["junk", "flt", "three"]);
  assert.ok(navLine({ name: "num", heat: "5x", summary: "" }).includes("heat=5"));
  assert.ok(navLine({ name: "flt", heat: "4.7", summary: "" }).includes("heat=4"));
});

test("byHeatDesc: junk in, an array out — the nav must never throw at the caller", () => {
  assert.deepEqual(byHeatDesc(undefined), []);
  assert.deepEqual(byHeatDesc(null), []);
  assert.deepEqual(names(byHeatDesc([{ name: "x" }, { name: "y", heat: 3 }])), ["y", "x"]);
});
