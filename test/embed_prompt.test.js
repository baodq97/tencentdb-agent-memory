"use strict";
// The embedding GENERATION: the asymmetric retrieval template, and the machinery
// that stops a vector built by one generation being compared against another.
//
// WHY IT MATTERS. Cosine between a prefixed vector and an unprefixed one is not a
// slightly-wrong number — it is a comparison between embeddings of two different
// strings. Nothing downstream can tell: the KNN returns its k nearest whatever
// they mean, the atom floor scores them, coverage reads 100%, and every health
// check passes. So the invariants below are the only thing between a
// half-migrated store and confident nonsense.
//
// Nothing here touches ~/.memory-tencentdb; the store tests build their own.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const P = require("../scripts/embed_prompt.js");
const { VectorStore } = require("../scripts/vector_store.js");
const recall = require("../scripts/memory_recall.js");

const RECALL = path.join(__dirname, "..", "scripts", "memory_recall.js");

function withTmp(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ── the template ──────────────────────────────────────────────────────

test("query and document are DIFFERENT representations of the same text", () => {
  const t = "sqlite-vec stores embeddings in an l1_vec virtual table";
  assert.notEqual(P.queryText(t), P.docText(t, "vector-index"));
  // The whole point of the asymmetry: a symmetric path would make these equal and
  // the model would never enter its retrieval mode. That is what shipped until
  // 0.8.4 and what cost the on/off separation (0.009 raw vs 0.071 prefixed).
  assert.ok(P.queryText(t).startsWith("task: search result | query: "));
  assert.ok(P.docText(t, "vector-index").startsWith("title: vector-index | text: "));
});

test("an untitled document falls back to the model card's sentinel, not to an empty slot", () => {
  for (const missing of [null, undefined, ""]) {
    assert.ok(P.docText("x", missing).startsWith("title: none | text: "),
      `title ${JSON.stringify(missing)} must render as "none"`);
  }
});

test("the CONTENT is trimmed to fit the budget, never the prefix", () => {
  const long = "đ".repeat(2000); // non-ASCII: the budget is chars, and it is measured on chars
  const q = P.queryText(long);
  const d = P.docText(long, "a-very-long-scene-name-that-eats-into-the-budget");

  assert.equal(q.length, P.MAX_INPUT_CHARS);
  assert.equal(d.length, P.MAX_INPUT_CHARS);
  // A prefix cut in half is a malformed template the model silently mis-reads —
  // the failure mode that motivates trimming from the far end instead.
  assert.ok(q.startsWith(P.QUERY_PREFIX));
  assert.ok(d.startsWith(P.docPrefix("a-very-long-scene-name-that-eats-into-the-budget")));
});

test("a short input is passed through unpadded", () => {
  assert.equal(P.queryText("hi"), P.QUERY_PREFIX + "hi");
});

// ── the fact-vector cache key ─────────────────────────────────────────

test("the fact cache key changes with the generation AND with the scene", () => {
  const text = "consolidation dispatches headless via claude -p";
  const a = recall.factVecKey({ sceneName: "scene-one", text });
  const b = recall.factVecKey({ sceneName: "scene-two", text });

  // Two scenes, same bullet: under the document template the scene name is IN the
  // embedded string, so these are genuinely two different vectors. A key on text
  // alone would hand the second scene the first scene's vector.
  assert.notEqual(a, b);

  // And a bump of EMBED_VERSION must strand every existing entry, which is what
  // makes the cache self-invalidating rather than something to remember to clear.
  const forced = require("node:crypto").createHash("sha1")
    .update(`OTHER-GENERATION scene-one ${text}`).digest("hex");
  assert.notEqual(a, forced);
});

test("the fact LOG id still hashes the TEXT alone — the log must stay comparable", () => {
  // factLogId and factVecKey are deliberately two functions. The vector key moves
  // with the generation (above); the LOG id must not, because recall_log.jsonl is
  // read across weeks and an id that changed with the embedding template would
  // make every historical row incomparable at exactly the moment someone is
  // measuring whether that change helped.
  //
  // Asserted end-to-end against a real logged turn rather than by reading the
  // function: the id in the file is the thing later analysis joins on.
  withTmp("tmem-factid-", (home) => {
    const base = path.join(home, ".memory-tencentdb");
    const scenes = path.join(base, "global", "scene_blocks");
    fs.mkdirSync(scenes, { recursive: true });
    const FACT = "sqlite-vec stores embeddings in an l1_vec virtual table keyed by record_id.";
    fs.writeFileSync(path.join(scenes, "vector-index.md"), [
      "-----META-START-----", "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z", "summary: vector index notes", "heat: 4",
      "-----META-END-----", "", "## Key Facts", `- ${FACT}`,
    ].join("\n"));

    execFileSync("node", ["-e",
      `const { recallAsync, RECALL_SOURCE } = require(${JSON.stringify(RECALL)});
       const unit = () => { const v = new Float32Array(8); v[0] = 1; return v; };
       const embedFn = async () => ({ vector: unit(), reason: "ready" });
       recallAsync("where are embeddings stored", "", 280, 5, RECALL_SOURCE.HOOK, { embedFn })
         .then(() => process.exit(0));`],
      { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf-8" });

    const row = JSON.parse(fs.readFileSync(path.join(base, "recall_log.jsonl"), "utf-8").trim());
    const textOnly = require("node:crypto").createHash("sha1").update(FACT).digest("hex").slice(0, 12);
    assert.deepEqual(row.injectedFactIds, [`fact:vector-index:${textOnly}`]);
  });
});

test("a cache written by another generation reads as EMPTY, not as vectors", () => {
  withTmp("tmem-factcache-", (home) => {
    const base = path.join(home, ".memory-tencentdb");
    fs.mkdirSync(base, { recursive: true });
    const cachePath = path.join(base, "scene_facts_vec.json");

    // Both shapes that exist in the wild: a legacy bare map (pre-0.8.4) and an
    // envelope from some other generation. Neither may be served.
    for (const body of ['{"deadbeef":[1,2,3]}', '{"v":"other-gen","vecs":{"deadbeef":[1,2,3]}}']) {
      fs.writeFileSync(cachePath, body);
      const out = execFileSync("node", ["-e",
        `const r = require(${JSON.stringify(RECALL)});
         process.stdout.write(String(Object.keys(r.loadFactVecCache()).length));`],
        { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf-8" });
      assert.equal(out, "0", `a ${body.slice(0, 12)}… cache must not be served to a new generation`);
    }
  });
});

// ── the store stamp ───────────────────────────────────────────────────

test("vec_meta round-trips, and an empty store counts as current", () => {
  withTmp("tmem-vecmeta-", (dir) => {
    const store = new VectorStore(path.join(dir, "vectors.db"));
    if (store.degraded) { store.close(); return; } // sqlite-vec unavailable here

    // Empty: nothing to be wrong about. Reporting a fresh install as stale would
    // send every new user to a migration they do not need.
    assert.equal(store.isCurrentGeneration(P.EMBED_VERSION), true);

    assert.equal(store.getMeta("embed_version"), null);
    assert.equal(store.setMeta("embed_version", P.EMBED_VERSION), true);
    assert.equal(store.getMeta("embed_version"), P.EMBED_VERSION);
    assert.equal(store.setMeta("embed_version", "later-generation"), true, "setMeta must upsert");
    assert.equal(store.getMeta("embed_version"), "later-generation");
    store.close();
  });
});

test("a populated store with no stamp — every store built before 0.8.4 — is stale", () => {
  withTmp("tmem-vecstamp-", (dir) => {
    const p = path.join(dir, "vectors.db");
    const store = new VectorStore(p);
    if (store.degraded) { store.close(); return; }
    store.upsertVec("m_1", new Float32Array(768).fill(0.1));
    store.close();

    const ro = new VectorStore(p, undefined, { readOnly: true });
    assert.equal(ro.count(), 1, "precondition: the store holds a vector");
    assert.equal(ro.isCurrentGeneration(P.EMBED_VERSION), false);
    ro.close();
  });
});

test("isCurrentGenerationDir: no vectors.db is current, a stale stamp is not", () => {
  withTmp("tmem-gendir-", (dir) => {
    // A store that never ran `tmem sync` has no vectors to be wrong about. Calling
    // it stale would empty <memories> on every fresh install.
    assert.equal(recall.isCurrentGenerationDir(dir), true);

    const store = new VectorStore(path.join(dir, "vectors.db"));
    if (store.degraded) { store.close(); return; }
    store.upsertVec("m_1", new Float32Array(768).fill(0.1));
    store.setMeta("embed_version", "some-older-generation");
    store.close();
    assert.equal(recall.isCurrentGenerationDir(dir), false);

    const store2 = new VectorStore(path.join(dir, "vectors.db"));
    store2.setMeta("embed_version", P.EMBED_VERSION);
    store2.close();
    assert.equal(recall.isCurrentGenerationDir(dir), true);
  });
});

// ── the reason the stamp exists ───────────────────────────────────────

test("a stale store contributes NO atoms — not even through the FTS arm", () => {
  // THE POINT OF THE WHOLE MECHANISM. Dropping only the vector arm would leave
  // the FTS arm delivering that store's atoms, and applyAtomFloor reads an unknown
  // similarity as KEEP — so they would arrive unfloored, which is precisely the
  // 20/20 negative-control leak Wave 1 removed. Measured here through the real
  // recallAsync, not by reading the filter.
  withTmp("tmem-staleatoms-", (home) => {
    const base = path.join(home, ".memory-tencentdb");
    const global = path.join(base, "global");
    fs.mkdirSync(global, { recursive: true });

    const { MemoryStore } = require("../scripts/memory_store.js");
    let store;
    try {
      store = new MemoryStore(path.join(global, "index.db"));
    } catch { return; } // no node:sqlite here
    store.upsert({
      id: "m_stale_1",
      type: "instruction",
      content: "always run the vector sync before benchmarking recall",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.close();

    const run = () => execFileSync("node", ["-e",
      `const { recallAsync, RECALL_SOURCE } = require(${JSON.stringify(RECALL)});
       const unit = () => { const v = new Float32Array(8); v[0] = 1; return v; };
       const embedFn = async () => ({ vector: unit(), reason: "ready" });
       recallAsync("vector sync before benchmarking", "", 280, 5, RECALL_SOURCE.CLI, { embedFn })
         .then((ctx) => { process.stdout.write(ctx || ""); process.exit(0); });`],
      { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf-8" });

    // With no vectors.db the store is "current" (nothing stale to gate on) and the
    // atom reaches the block — the precondition that makes the next half meaningful.
    assert.match(run(), /always run the vector sync/,
      "precondition: this atom must be recallable before the stamp is made stale");

    const vec = new VectorStore(path.join(global, "vectors.db"));
    if (vec.degraded) { vec.close(); return; }
    vec.upsertVec("m_stale_1", new Float32Array(768).fill(0.1));
    vec.setMeta("embed_version", "an-older-generation");
    vec.close();

    assert.doesNotMatch(run(), /always run the vector sync/,
      "a store on an older embedding generation must contribute no atoms at all");
  });
});

// ── the scene-navigation relevance gate ───────────────────────────────────────

test("scene-nav is filtered to the scenes a turn measured as relevant", () => {
  // `<recalled-facts>` and `<memories>` had floors; the two ALWAYS-ON blocks had
  // none, so the negative control was grading the two surfaces that were already
  // gated and ignoring the one that was not. Measured in hook scope over 50
  // queries: scene-nav billed 948 chars on every turn and was 948 of the 1,138
  // characters an off-topic turn received.
  const { buildSceneNav } = recall;
  withTmp("tmem-navgate-", (home) => {
    const scenes = path.join(home, ".memory-tencentdb", "global", "scene_blocks");
    fs.mkdirSync(scenes, { recursive: true });
    for (const name of ["alpha-scene", "beta-scene"]) {
      fs.writeFileSync(path.join(scenes, `${name}.md`), [
        "-----META-START-----", "created: 2026-01-01T00:00:00.000Z",
        "updated: 2026-01-01T00:00:00.000Z", `summary: ${name} summary`, "heat: 4",
        "-----META-END-----", "", "## Key Facts", `- a durable fact belonging to ${name}.`,
      ].join("\n"));
    }

    const run = (keepArg) => execFileSync("node", ["-e",
      `const r = require(${JSON.stringify(RECALL)});
       const keep = ${keepArg};
       process.stdout.write(r.buildSceneNav("", "anything", 200, keep) || "");`],
      { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf-8" });

    const ungated = run("null");
    assert.match(ungated, /alpha-scene/);
    assert.match(ungated, /beta-scene/);

    // A measured subset keeps exactly that subset.
    const one = run('new Set(["alpha-scene"])');
    assert.match(one, /alpha-scene/);
    assert.doesNotMatch(one, /beta-scene/);

    // An EMPTY set is a measured "no scene is about this" — the off-topic answer —
    // and must render nothing. It is not the same as null, which means the turn
    // could not measure relevance at all and renders the index unfiltered.
    assert.equal(run("new Set()"), "");
    assert.notEqual(run("null"), "");
  });
});
