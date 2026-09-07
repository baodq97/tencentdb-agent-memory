#!/usr/bin/env node
/**
 * sqlite-vec vector storage for hybrid recall.
 *
 * Separate vectors.db file alongside index.db (FTS5).
 * Uses vec0 virtual table with cosine distance metric.
 * Graceful degradation: if sqlite-vec fails to load, all ops return empty.
 */
"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const RRF_K = 60;

class VectorStore {
  constructor(dbPath, dimensions = 768, { readOnly = false } = {}) {
    this.dbPath = path.resolve(dbPath);
    this.dimensions = dimensions;
    this.readOnly = readOnly;
    this.degraded = false;
    this.db = null;

    // READ path (readOnly): open read-only and touch nothing — no mkdir, no WAL
    // pragma, no CREATE VIRTUAL TABLE. A missing file, a store with no l1_vec
    // table, or a failed sqlite-vec load all fall through to degraded=true here
    // (or on the first searchVec/count), so the read path can never create the
    // l1_vec schema. The writer path (readOnly=false) is byte-for-byte unchanged.
    if (!readOnly) {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }

    try {
      if (readOnly) {
        this.db = new DatabaseSync(this.dbPath, { readOnly: true, allowExtension: true });
        this.db.enableLoadExtension(true);
        require("sqlite-vec").load(this.db);
      } else {
        this.db = new DatabaseSync(this.dbPath, { allowExtension: true });
        this.db.exec("PRAGMA journal_mode=WAL");
        this.db.enableLoadExtension(true);
        require("sqlite-vec").load(this.db);
        this._initSchema();
      }
    } catch {
      this.degraded = true;
      this.db = null;
    }
  }

  _initSchema() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec USING vec0(
        record_id TEXT PRIMARY KEY,
        embedding float[${this.dimensions}] distance_metric=cosine
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  /**
   * Read stored embeddings back, by record id.
   *
   * WHY: recall's atom floor has to score BOTH retrieval arms, but only the
   * vector arm carries a `distance`. An FTS5 hit arrives with a bm25 rank and no
   * notion of semantic distance, and measured on the negative-control set FTS is
   * not a relevance gate on its own — 8 of 20 off-topic queries land a
   * recall-eligible atom through generic shared tokens ("hello", "time", "rule",
   * "hôm nay", "một"). Re-embedding those hits per turn would cost N embeds
   * inside an 8s hook budget; the vectors already exist (coverage is 100% of
   * eligible records), so reading them back is the cheap half of the same answer.
   *
   * Returns a Map of id -> number[]; ids with no stored vector are simply absent,
   * which callers must read as "similarity unknown", never as "similarity zero".
   */
  getVecs(recordIds) {
    const out = new Map();
    if (this.degraded || !this.db || !Array.isArray(recordIds) || !recordIds.length) return out;
    try {
      // Chunked: SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999, and the
      // candidate list grows with topK, so an unchunked IN (...) is a latent
      // failure that would only fire on a large store.
      const CHUNK = 200;
      for (let i = 0; i < recordIds.length; i += CHUNK) {
        const slice = recordIds.slice(i, i + CHUNK);
        const holes = slice.map(() => "?").join(",");
        const rows = this.db.prepare(
          `SELECT record_id, vec_to_json(embedding) AS j FROM l1_vec WHERE record_id IN (${holes})`
        ).all(...slice);
        for (const r of rows) {
          try { out.set(r.record_id, JSON.parse(r.j)); } catch { /* skip unreadable vector */ }
        }
      }
    } catch {
      // Degrade to "no similarity known" — the caller keeps the atom rather than
      // dropping it, so a vec0 surprise can never silently empty the block.
    }
    return out;
  }

  /**
   * `vec_meta` accessors — the schema has existed since the first version and had
   * no reader or writer until the embedding generation needed somewhere to live.
   *
   * WHY A STAMP IS NEEDED AT ALL. Cosine between a vector built from a prefixed
   * string and one built from raw text is not "slightly off", it is a comparison
   * of two different embeddings of two different strings. A half-migrated index
   * therefore does not degrade, it reports confident nonsense — and every consumer
   * here (the KNN search, the atom floor's read-back) takes that number at face
   * value. The stamp is what makes "these vectors are from another generation"
   * detectable instead of invisible.
   *
   * Read-only stores return null from setMeta rather than throwing: the read path
   * must never write, and a caller that stamps opportunistically is not a bug.
   */
  getMeta(key) {
    if (this.degraded || !this.db) return null;
    try {
      const r = this.db.prepare("SELECT value FROM vec_meta WHERE key = ?").get(key);
      return r ? String(r.value) : null;
    } catch {
      return null;
    }
  }

  setMeta(key, value) {
    if (this.degraded || !this.db || this.readOnly) return false;
    try {
      this.db.prepare(
        "INSERT INTO vec_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(key, String(value));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Is this store's index built with the embedding template the running code uses?
   *
   * An EMPTY store counts as current: it has no vectors to be wrong about, and
   * reporting a fresh install as stale would send every new user to a migration
   * they do not need. A store with vectors and NO stamp is pre-0.8.4 and therefore
   * stale by definition — that is the whole population this gate was added for.
   *
   * Note what this does NOT cover: a store holding records but zero vectors. Its
   * atoms reach recall through FTS with no similarity known, which applyAtomFloor
   * keeps. That hole predates this stamp and is a coverage question (`tmem sync`),
   * not a generation one; conflating them here would empty the block on any fresh
   * install before its first sync.
   */
  isCurrentGeneration(currentVersion) {
    if (this.degraded || !this.db) return true;
    if (this.count() === 0) return true;
    return this.getMeta("embed_version") === currentVersion;
  }

  upsertVec(recordId, embedding) {
    if (this.degraded || !this.db) return false;
    try {
      this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?").run(recordId);
      this.db.prepare("INSERT INTO l1_vec (record_id, embedding) VALUES (?, ?)").run(
        recordId,
        new Float32Array(embedding)
      );
      return true;
    } catch {
      return false;
    }
  }

  searchVec(queryEmbedding, topK = 10) {
    if (this.degraded || !this.db) return [];
    try {
      return this.db.prepare(`
        SELECT record_id, distance
        FROM l1_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `).all(new Float32Array(queryEmbedding), topK);
    } catch {
      return [];
    }
  }

  deleteVec(recordId) {
    if (this.degraded || !this.db) return false;
    try {
      this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?").run(recordId);
      return true;
    } catch {
      return false;
    }
  }

  count() {
    if (this.degraded || !this.db) return 0;
    try {
      return this.db.prepare("SELECT COUNT(*) as c FROM l1_vec").get().c;
    } catch {
      return 0;
    }
  }

  /**
   * The set of record_ids that already have a vector. Sync uses this to embed the
   * records that are ACTUALLY missing a vector, by identity — not the newest-N by
   * count, which loops forever when the missing records are not the most recent
   * (measured: a store stuck re-embedding the same 226 newest records, 0 of the
   * 226 truly-missing older ones, every run).
   */
  existingIds() {
    if (this.degraded || !this.db) return new Set();
    try {
      return new Set(this.db.prepare("SELECT record_id FROM l1_vec").all().map((r) => String(r.record_id)));
    } catch {
      return new Set();
    }
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}

/**
 * Reciprocal Rank Fusion — merge multiple ranked lists.
 *
 * @param {Array<Array>} lists - Ranked result lists
 * @param {Function} getId - Extract unique ID from an item
 * @param {number} k - RRF constant (default 60)
 * @returns {Array} Merged list sorted by descending RRF score
 */
function rrfMerge(lists, getId, k = RRF_K) {
  const map = new Map();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const id = getId(item);
      const score = 1 / (k + rank + 1);
      const existing = map.get(id);
      if (existing) {
        existing.rrfScore += score;
      } else {
        map.set(id, { item, rrfScore: score });
      }
    }
  }
  return [...map.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ item, rrfScore }) => ({ ...item, rrfScore }));
}

// ── CLI ──
function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "--help") {
    console.log(`Usage: node vector_store.js <command>

Commands:
  test    Create a vec0 table, upsert, search (in-memory)
  count   --db <path>  Count vectors in DB`);
    return;
  }

  if (cmd === "test") {
    const dbPath = path.join(require("node:os").tmpdir(), `vec_test_${Date.now()}.db`);
    const store = new VectorStore(dbPath, 4);
    if (store.degraded) {
      console.error("sqlite-vec failed to load — cannot run test");
      process.exit(1);
    }
    console.log("VectorStore created (dims=4)");

    store.upsertVec("r1", [1, 0, 0, 0]);
    store.upsertVec("r2", [0, 1, 0, 0]);
    store.upsertVec("r3", [0.7, 0.7, 0, 0]);
    console.log("Upserted 3 vectors, count:", store.count());

    const results = store.searchVec([1, 0, 0, 0], 3);
    console.log("Search [1,0,0,0] top-3:", results.map(r => `${r.record_id} d=${r.distance.toFixed(4)}`));

    const fts = [{ record_id: "r1" }, { record_id: "r3" }];
    const vec = [{ record_id: "r3" }, { record_id: "r1" }];
    const merged = rrfMerge([fts, vec], r => r.record_id);
    console.log("RRF merge:", merged.map(m => `${m.record_id} rrf=${m.rrfScore.toFixed(6)}`));

    store.close();
    fs.unlinkSync(dbPath);
    console.log("All vector_store tests passed");
  } else if (cmd === "count") {
    const args = process.argv.slice(3);
    const i = args.indexOf("--db");
    const dbPath = i !== -1 ? args[i + 1] : "";
    if (!dbPath) { console.error("--db required"); process.exit(1); }
    const store = new VectorStore(dbPath);
    console.log(store.count());
    store.close();
  }
}

if (require.main === module) main();

module.exports = { VectorStore, rrfMerge, RRF_K };
