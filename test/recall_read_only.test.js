// test/recall_read_only.test.js
//
// The READ path must never create schema. Opening a store read-write on recall
// turned an honest "unmeasured" store into a manufactured "measured 0%": the
// constructor ran PRAGMA journal_mode=WAL + CREATE TABLE/CREATE VIRTUAL TABLE on
// open, so recalling against a missing or never-synced store SILENTLY CREATED it.
//
// These tests pin the fix: constructors take { readOnly } and recall opens every
// store read-only, degrading a missing / schemaless / failed store to "contributes
// nothing" — per store, never taking down its sibling, never throwing out of
// recall() (on_user_prompt.js injects the result into every turn).
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { MemoryStore } = require("../scripts/memory_store.js");
const { VectorStore } = require("../scripts/vector_store.js");
const { recall, recallAsync } = require("../scripts/memory_recall.js");

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `recall-ro-${tag}-`));
}

// Fixture store dir under a fake HOME, so recall's globalDir()/projectDir() (which
// key off os.homedir()) resolve into a temp tree — never ~/.memory-tencentdb.
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

function seed(store, id, content) {
  store.upsert({
    // Non-persona type on purpose: these fixtures assert that recall SURFACES a
    // seeded atom (read-only degradation, sibling-store independence), and the
    // per-turn recall path now drops persona-type atoms (they are a session clock,
    // delivered once at SessionStart). Seeding "persona" here would make the atom
    // vanish for a reason unrelated to what each test is pinning.
    id, content, type: "episodic", priority: 50, scene_name: "t",
    metadata: {}, timestamps: ["2026-01-01T00:00:00Z"],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    sessionKey: "t", sessionId: "t",
  });
}

// Seed a real (read-write) store, then settle it to DELETE journal mode so a later
// read-only open leaves ZERO sidecars (a read-only reader of a WAL-mode db creates
// an empty -wal/-shm; converting to DELETE removes that noise so byte-for-byte
// assertions test the db content, not transient WAL bookkeeping).
function seedSettled(dbPath, records) {
  const store = new MemoryStore(dbPath);
  for (const [id, content] of records) seed(store, id, content);
  store.close();
  const c = new DatabaseSync(dbPath);
  c.exec("PRAGMA journal_mode=DELETE");
  c.close();
}

function snapshotDir(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) {
      out[f] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  }
  return out;
}

function tableNames(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all();
  db.close();
  return rows.map((r) => r.name);
}

// ── 1. REPRO THE EXACT VULN ──────────────────────────────────────────────────
// vectors.db present but with NO l1_vec table (a never-synced / schemaless store).
// A read-only vector read must leave the file byte-identical: no l1_vec, no -wal,
// no new tables. On the pre-fix code the read-write constructor ran CREATE VIRTUAL
// TABLE l1_vec + PRAGMA journal_mode=WAL on open, so this assertion FAILED — which
// is exactly what makes it a regression test for the bug.
test("vuln repro: read-only vector read cannot create l1_vec schema", () => {
  const dir = tmpdir("vec");
  try {
    const vecDb = path.join(dir, "vectors.db");
    // Non-WAL fixture: a plain db with some unrelated table, but no l1_vec.
    const f = new DatabaseSync(vecDb);
    f.exec("CREATE TABLE vec_meta (key TEXT PRIMARY KEY, value TEXT)");
    f.exec("INSERT INTO vec_meta VALUES ('schema_version','1')");
    f.close();

    const before = snapshotDir(dir);
    assert.ok(!tableNames(vecDb).includes("l1_vec"), "fixture must start with no l1_vec");

    // The read path: open read-only and probe. Must not throw, must not mutate.
    const vs = new VectorStore(vecDb, undefined, { readOnly: true });
    assert.strictEqual(vs.count(), 0, "schemaless vector store contributes nothing");
    assert.deepStrictEqual(vs.searchVec([0.1, 0.2, 0.3], 5), []);
    vs.close();

    const after = snapshotDir(dir);
    assert.deepStrictEqual(after, before, "read path must not write (no -wal, byte-identical)");
    assert.ok(!tableNames(vecDb).includes("l1_vec"), "read path must not create l1_vec");
    assert.deepStrictEqual(Object.keys(after).sort(), ["vectors.db"], "no sidecar files created");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. missing project store → global still contributes ──────────────────────
test("recall against a missing project store returns global results, creates no project index.db", () => {
  withFakeHome((home) => {
    const gDir = path.join(home, ".memory-tencentdb", "global");
    fs.mkdirSync(gDir, { recursive: true });
    seedSettled(path.join(gDir, "index.db"), [["g1", "global recall marker alpha"]]);

    const projectHash = "P--nonexistent--proj";
    const projDir = path.join(home, ".memory-tencentdb", "projects", projectHash);

    const out = recall("alpha", projectHash);
    assert.match(out, /global recall marker alpha/, "global store must still contribute");
    assert.ok(!fs.existsSync(projDir), "missing project store must not be created by recall");
  });
});

// ── 3. schemaless project store → no throw, no l1_fts created ─────────────────
test("recall against a schemaless index.db does not throw and does not create l1_fts", () => {
  withFakeHome((home) => {
    const gDir = path.join(home, ".memory-tencentdb", "global");
    fs.mkdirSync(gDir, { recursive: true });
    seedSettled(path.join(gDir, "index.db"), [["g1", "global recall marker beta"]]);

    const projectHash = "P--schemaless--proj";
    const pDir = path.join(home, ".memory-tencentdb", "projects", projectHash);
    fs.mkdirSync(pDir, { recursive: true });
    const pDb = path.join(pDir, "index.db");
    // schemaless: a real sqlite file with store_meta but NO l1_fts.
    const f = new DatabaseSync(pDb);
    f.exec("CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT)");
    f.close();

    let out;
    assert.doesNotThrow(() => { out = recall("beta", projectHash); }, "recall must never throw");
    assert.match(out, /global recall marker beta/, "sibling global store must still answer");
    assert.ok(!tableNames(pDb).includes("l1_fts"), "read path must not create l1_fts on a schemaless store");
  });
});

// ── 4. failed VECTOR store still lets FTS results return (per-store degradation) ─
test("recallAsync returns FTS results even when the vector store is unusable", async () => {
  await withFakeHome(async (home) => {
    const gDir = path.join(home, ".memory-tencentdb", "global");
    fs.mkdirSync(gDir, { recursive: true });
    seedSettled(path.join(gDir, "index.db"), [["g1", "fts survives gamma"]]);
    // A broken/schemaless vectors.db present alongside — must not sink FTS.
    const f = new DatabaseSync(path.join(gDir, "vectors.db"));
    f.exec("CREATE TABLE vec_meta (key TEXT PRIMARY KEY, value TEXT)");
    f.close();

    const out = await recallAsync("gamma", "");
    assert.match(out, /fts survives gamma/, "FTS must return even when the vector store degrades");
  });
});

// ── 5. writer path unchanged: write read-write, read back read-only ──────────
test("writer path still works and a read-only reopen sees the record", () => {
  const dir = tmpdir("rw");
  try {
    const dbPath = path.join(dir, "index.db");
    const w = new MemoryStore(dbPath); // read-write (default) — must be unchanged
    seed(w, "w1", "written then read delta");
    w.close();

    const r = new MemoryStore(dbPath, { readOnly: true });
    const hits = r.search("delta", 10).map((x) => x.record_id);
    r.close();
    assert.ok(hits.includes("w1"), `read-only reopen must see the written record, got [${hits}]`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 6. recall never writes: checksum the whole store dir before/after ─────────
test("recall does not write to the store dir (checksum unchanged)", () => {
  withFakeHome((home) => {
    const gDir = path.join(home, ".memory-tencentdb", "global");
    fs.mkdirSync(gDir, { recursive: true });
    seedSettled(path.join(gDir, "index.db"), [["g1", "checksum guard epsilon"], ["g2", "second record"]]);

    const before = snapshotDir(gDir);
    const out = recall("epsilon", "");
    assert.match(out, /checksum guard epsilon/);
    const after = snapshotDir(gDir);
    assert.deepStrictEqual(after, before, "recall must not mutate any file in the store dir");
  });
});
