// test/recall_two_clock.test.js
//
// WS1 — two-clock recall (delta-per-turn, not blob-per-turn).
//
// The persona is a SESSION-scoped clock: the tier-0 core is injected ONCE per
// session by on_session_start.js. Persona-type L1 atoms are the raw material
// that core is consolidated from, so re-injecting them in the per-turn
// <memories> block is pure redundancy — measured at 46-71% of recall hits. The
// per-turn clock should carry only the query-relevant NON-persona delta plus the
// scene-nav index.
//
// Second half: toFtsQuery ORed every raw token with no stopword removal, so a
// meta prompt like "push đi" or "what is the port" fired a query full of
// content-free words and pulled back noise. Cleaning the query is the root fix
// for off-target recall.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { MemoryStore, toFtsQuery } = require("../scripts/memory_store.js");
const { recall } = require("../scripts/memory_recall.js");

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `recall-2clock-${tag}-`));
}

// Fixture store under a fake HOME so recall's globalDir() resolves into a temp
// tree, never ~/.memory-tencentdb.
function withFakeHome(fn) {
  const home = tmpdir("home");
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function seed(store, id, content, type) {
  store.upsert({
    id, content, type, priority: 50, scene_name: "t",
    metadata: {}, timestamps: ["2026-01-01T00:00:00Z"],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    sessionKey: "t", sessionId: "t",
  });
}

// Seed a real store then settle it to DELETE journal mode so a later read-only
// open leaves no WAL sidecars.
function seedSettled(dbPath, records) {
  const store = new MemoryStore(dbPath);
  for (const [id, content, type] of records) seed(store, id, content, type);
  store.close();
  const c = new DatabaseSync(dbPath);
  c.exec("PRAGMA journal_mode=DELETE");
  c.close();
}

function seedGlobal(home) {
  const gDir = path.join(home, ".memory-tencentdb", "global");
  fs.mkdirSync(gDir, { recursive: true });
  seedSettled(path.join(gDir, "index.db"), [
    // A persona atom the meta prompt "push đi" matches token-for-token. It is the
    // kind of standing preference already carried by the tier-0 core at SessionStart.
    ["p1", "When the user says push đi, open a pull request, never push straight to main", "persona"],
    // A fact atom the meta prompt does NOT match — surfaced only by its own query.
    ["e1", "serve.js binds to port 3000 in development", "episodic"],
  ]);
  return gDir;
}

// ── 1. per-turn recall must NOT re-inject persona-type atoms ──────────────────
test("a meta prompt returns zero persona-type L1 atoms in the per-turn block", () => {
  withFakeHome((home) => {
    seedGlobal(home);
    const out = recall("push đi", "");
    // The persona atom matches the query, but persona is a session clock: it must
    // not reappear in the per-turn <memories> block.
    assert.doesNotMatch(out, /\[persona\]/,
      `per-turn recall must not inject persona-type atoms, got:\n${out}`);
  });
});

// ── 2. a fact prompt recalls its DISTILLED scene fact (the pivot) ─────────────
// Raw episodic atoms are echoes and no longer surface per-turn; the fact a prompt
// asks for is recalled from the scene body consolidation distilled it into.
test("a fact prompt surfaces its distilled scene fact, not a raw episodic echo", () => {
  withFakeHome((home) => {
    seedGlobal(home);
    // The fact lives in a scene body (what consolidation produces), not as a raw
    // episodic atom. Recall must surface it via the <recalled-facts> block.
    const gScenes = path.join(home, ".memory-tencentdb", "global", "scene_blocks");
    fs.mkdirSync(gScenes, { recursive: true });
    fs.writeFileSync(path.join(gScenes, "serve-config.md"), [
      "-----META-START-----",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "summary: serve.js configuration",
      "heat: 4",
      "-----META-END-----",
      "",
      "## Key Facts",
      "- serve.js binds to port 3000 in development.",
    ].join("\n"));

    const out = recall("what port does serve.js bind", "");
    assert.match(out, /port 3000/, `the distilled fact must recall, got:\n${out}`);
    assert.match(out, /recalled-facts/, "and be delivered via the <recalled-facts> block");
    assert.doesNotMatch(out, /\[episodic\]/, "raw episodic atoms must not surface per-turn");
  });
});

// ── 3. toFtsQuery strips content-free stopwords instead of ORing junk ─────────
test("toFtsQuery drops EN/VI stopwords and short noise, keeps content tokens", () => {
  const q = toFtsQuery("what is the deploy port");
  assert.doesNotMatch(q, /"what"/i, "the EN stopword 'what' must be dropped");
  assert.doesNotMatch(q, /"is"/i, "the EN stopword 'is' must be dropped");
  assert.doesNotMatch(q, /"the"/i, "the EN stopword 'the' must be dropped");
  assert.match(q, /"deploy"/, "a content token must survive");
  assert.match(q, /"port"/, "a content token must survive");

  // Vietnamese stopwords too.
  const vq = toFtsQuery("cho tôi xem port của serve");
  assert.doesNotMatch(vq, /"của"/, "the VI stopword 'của' must be dropped");
  assert.doesNotMatch(vq, /"tôi"/, "the VI stopword 'tôi' must be dropped");
  assert.match(vq, /"port"/);
  assert.match(vq, /"serve"/);

  // Fail-open: a degenerate all-stopword / empty query yields an empty FTS query,
  // never a throw (recall runs on the hook hot path).
  assert.equal(toFtsQuery("the is of to"), "");
  assert.equal(toFtsQuery(""), "");
  assert.doesNotThrow(() => toFtsQuery("!!! ??? ..."));
});
