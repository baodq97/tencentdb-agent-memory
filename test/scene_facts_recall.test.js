// test/scene_facts_recall.test.js
// The pivot: per-turn `<memories>` must recall DISTILLED scene-body facts ranked
// for the query, not raw episodic echoes. This tests the pure ranker/renderer in
// scene_nav.js (rankSceneFacts) and the fs reader in memory_recall.js
// (readSceneFacts + buildFactRecall).
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { rankSceneFacts } = require("../scripts/scene_nav.js");

const FACTS = [
  { sceneName: "embedding-review", heat: 4, text: "The embedding model is EmbeddingGemma-300M, multilingual, downloaded lazily to ~/.memory-tencentdb/models." },
  { sceneName: "release-log", heat: 3, text: "Shipped v0.7.3 fixing the npm launcher shadowing bug." },
  { sceneName: "release-log", heat: 3, text: "The tmem CLI is published on npm as @baodq97/tmem, CLI-only." },
];

test("rankSceneFacts ranks the on-topic distilled fact first", () => {
  const out = rankSceneFacts(FACTS, "what embedding model is used and is it multilingual", { limit: 3, maxChars: 1000 });
  assert.ok(out.facts.length >= 1);
  assert.match(out.facts[0].text, /EmbeddingGemma/);
});

test("rankSceneFacts respects the char budget", () => {
  const out = rankSceneFacts(FACTS, "npm launcher", { limit: 3, maxChars: 80 });
  const total = out.facts.reduce((n, f) => n + f.text.length, 0);
  assert.ok(total <= 80 + 60, `facts total ${total} should fit ~80-char budget`);
});

test("rankSceneFacts renders a labelled block naming the source scene", () => {
  const out = rankSceneFacts(FACTS, "npm tmem published", { limit: 2, maxChars: 1000 });
  assert.ok(out.block.includes("recalled-facts"));
  assert.match(out.block, /\(release-log\)/);
});

test("rankSceneFacts on empty facts returns an empty block", () => {
  const out = rankSceneFacts([], "anything", { limit: 3, maxChars: 1000 });
  assert.strictEqual(out.facts.length, 0);
  assert.strictEqual(out.block, "");
});

test("readSceneFacts extracts Key Facts / Decisions bullets from a scene file", () => {
  const recall = require("../scripts/memory_recall.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "facts-"));
  const sceneDir = path.join(dir, "scene_blocks");
  fs.mkdirSync(sceneDir, { recursive: true });
  fs.writeFileSync(path.join(sceneDir, "demo.md"), [
    "-----META-START-----",
    "created: 2026-08-05T00:00:00.000Z",
    "updated: 2026-08-05T00:00:00.000Z",
    "summary: demo scene",
    "heat: 4",
    "-----META-END-----",
    "",
    "## Key Facts",
    "- The daemon revives itself on the client path when dead.",
    "- Recall reports FTS-only fallback instead of degrading silently.",
    "",
    "## Decisions",
    "- Chose node:sqlite over better-sqlite3 for zero native deps.",
  ].join("\n"));
  const facts = recall.readSceneFacts(dir);
  assert.strictEqual(facts.length, 3);
  assert.ok(facts.every((f) => f.sceneName && f.text));
  assert.ok(facts.some((f) => /node:sqlite/.test(f.text)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Semantic ranking (0.7.5): rank facts by embedding cosine, not keyword ──────
// Measured: a paraphrase of the question shares few rare keywords with the fact,
// so keyword ranking surfaced 48% of facts on reworded queries vs a 95% embedding
// ceiling. These tests pin the pure cosine ranker with stub vectors (no daemon).
const { rankSceneFactsSemantic } = require("../scripts/scene_nav.js");

const SEM_FACTS = [
  { sceneName: "auth", heat: 3, text: "Sessions expire after thirty minutes of inactivity." },
  { sceneName: "billing", heat: 3, text: "Invoices are emailed on the first business day of each month." },
  { sceneName: "infra", heat: 3, text: "The cache is warmed at deploy time to avoid a cold first request." },
];
// queryVec points at dimension 0; vectors chosen so cosine order is auth > infra > billing.
const QVEC = [1, 0, 0];
const SEM_VECS = [
  [0.98, 0.2, 0],  // auth   — cosine ≈ 0.98 (semantically closest; shares NO keyword with query)
  [0, 1, 0],       // billing— cosine 0 (below floor → dropped)
  [0.6, 0.6, 0],   // infra  — cosine ≈ 0.707
];

test("rankSceneFactsSemantic ranks by cosine, not keyword overlap", () => {
  // Query keywords ('token','logout') match NO fact text — only meaning can rank.
  const out = rankSceneFactsSemantic(SEM_FACTS, QVEC, SEM_VECS, { limit: 3, maxChars: 1000 });
  assert.ok(out.facts.length >= 1, "should surface facts by vector similarity");
  assert.match(out.facts[0].text, /Sessions expire/, "highest-cosine fact ranks first");
});

test("rankSceneFactsSemantic drops facts below the floor (negative-control property)", () => {
  const out = rankSceneFactsSemantic(SEM_FACTS, QVEC, SEM_VECS, { limit: 3, maxChars: 1000, floor: 0.4 });
  assert.ok(!out.facts.some((f) => /Invoices/.test(f.text)), "orthogonal (cosine 0) fact must be dropped");
  assert.strictEqual(out.facts.length, 2, "only the two above-floor facts survive");
});

test("rankSceneFactsSemantic yields an empty block when nothing clears the floor", () => {
  const out = rankSceneFactsSemantic(SEM_FACTS, [0, 0, 1], SEM_VECS, { limit: 3, maxChars: 1000, floor: 0.4 });
  assert.strictEqual(out.block, "", "off-topic query surfaces no fact");
});

test("rankSceneFactsSemantic returns empty when no query vector", () => {
  const out = rankSceneFactsSemantic(SEM_FACTS, null, SEM_VECS, { limit: 3, maxChars: 1000 });
  assert.strictEqual(out.facts.length, 0);
});
