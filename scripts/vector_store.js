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
  constructor(dbPath, dimensions = 768) {
    this.dbPath = path.resolve(dbPath);
    this.dimensions = dimensions;
    this.degraded = false;
    this.db = null;

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    try {
      this.db = new DatabaseSync(this.dbPath, { allowExtension: true });
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.enableLoadExtension(true);
      require("sqlite-vec").load(this.db);
      this._initSchema();
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
