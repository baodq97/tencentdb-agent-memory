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
