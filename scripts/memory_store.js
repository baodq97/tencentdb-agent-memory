#!/usr/bin/env node
/**
 * FTS5 storage engine for self-consolidation memory.
 *
 * Manages L1 memory records in SQLite with FTS5 full-text search.
 * No vector search, no paid embeddings — FTS5 keyword search only.
 *
 * Usage:
 *   node scripts/memory_store.js --help
 *   node scripts/memory_store.js init --db path/to/index.db
 *   node scripts/memory_store.js search --db path/to/index.db --query "dark mode"
 *   node scripts/memory_store.js upsert --db path/to/index.db --json '{"id":"m_1",...}'
 */
"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
// EN + VI stopword set, shared with the grounding check and the scene-nav ranker
// rather than a third copy. Reused here to clean the FTS query — see toFtsQuery.
const { STOPWORDS } = require("./grounding.js");

/**
 * FTS5 bareword boolean operators. Kept as quoted literals (never dropped as
 * stopwords) so a query like "TypeScript AND Python" cannot silently turn into a
 * boolean AND against the index — the same neutralisation the surrounding quoting
 * already does. `and`/`or` are ALSO in STOPWORDS, so this exemption is what keeps
 * them present as searchable literals.
 */
const FTS5_OPERATORS = new Set(["and", "or", "not", "near"]);

// The single source of truth for "which atom types get an l1 vector". Recall's
// keepDistilledAtoms (memory_recall.js) drops persona (session clock) and episodic
// (echoes) from <memories>, and the vector arm is the ONLY reader of these vectors
// — so embedding those types produces vectors nothing ever uses. Worse, measured
// on the real store: 98% of vectors were episodic, so every KNN returned 10/10
// episodic neighbours that were then filtered out, leaving the vector arm empty on
// EVERY query. Skipping them here is the write-side half of the same invariant the
// read filter enforces; memory_recall imports isVectorEligible so the two cannot
// drift. Not embedding a type also means `tmem sync` prunes its stale vectors.
const NON_RECALL_TYPES = new Set(["episodic", "persona"]);
function isVectorEligible(type) { return !NON_RECALL_TYPES.has(String(type || "")); }

const SCHEMA_VERSION = 1;

const CREATE_L1_RECORDS = `
CREATE TABLE IF NOT EXISTS l1_records (
    record_id   TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    type        TEXT DEFAULT '',
    priority    INTEGER DEFAULT 50,
    scene_name  TEXT DEFAULT '',
    session_key TEXT DEFAULT '',
    session_id  TEXT DEFAULT '',
    timestamp_str   TEXT DEFAULT '',
    timestamp_start TEXT DEFAULT '',
    timestamp_end   TEXT DEFAULT '',
    created_time    TEXT DEFAULT '',
    updated_time    TEXT DEFAULT '',
    metadata_json   TEXT DEFAULT '{}'
)`;

const CREATE_L1_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
    content,
    record_id UNINDEXED,
    type UNINDEXED,
    priority UNINDEXED,
    scene_name UNINDEXED,
    tokenize='unicode61'
)`;

const CREATE_META = `
CREATE TABLE IF NOT EXISTS store_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
)`;

class MemoryStore {
  constructor(dbPath, { readOnly = false } = {}) {
    this.dbPath = path.resolve(dbPath);
    this.readOnly = readOnly;
    // READ path: open read-only and touch nothing. No mkdir, no WAL pragma, no
    // CREATE TABLE, no schema_version INSERT — so recalling against a missing or
    // never-synced store can never manufacture schema (a would-be "unmeasured"
    // store silently becoming a "measured 0%"). Callers must be ready for the
    // open — or the first query — to throw (see openMemoryStoreRO in
    // memory_recall.js), and degrade that store to "contributes nothing".
    if (readOnly) {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(CREATE_META);
    this.db.exec(CREATE_L1_RECORDS);
    this.db.exec(CREATE_L1_FTS);
    const row = this.db
      .prepare("SELECT value FROM store_meta WHERE key='schema_version'")
      .get();
    if (!row) {
      this.db
        .prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
    }
  }

  upsert(record) {
    const rid = record.id;
    const existing = this.db
      .prepare("SELECT record_id FROM l1_records WHERE record_id=?")
      .get(rid);

    const timestamps = record.timestamps || [];
    const tsStr = timestamps.join(",");
    const tsStart = timestamps[0] || "";
    const tsEnd = timestamps[timestamps.length - 1] || "";
    const metadata = record.metadata || {};

    if (existing) {
      this.db.prepare(`UPDATE l1_records SET
        content=?, type=?, priority=?, scene_name=?,
        session_key=?, session_id=?, timestamp_str=?,
        timestamp_start=?, timestamp_end=?, updated_time=?,
        metadata_json=?
        WHERE record_id=?`).run(
        record.content,
        record.type || "",
        record.priority ?? 50,
        record.scene_name || "",
        record.sessionKey || "",
        record.sessionId || "",
        tsStr, tsStart, tsEnd,
        record.updatedAt || "",
        JSON.stringify(metadata),
        rid
      );
      this.db.prepare("DELETE FROM l1_fts WHERE record_id=?").run(rid);
    } else {
      this.db.prepare(`INSERT INTO l1_records
        (record_id, content, type, priority, scene_name,
         session_key, session_id, timestamp_str,
         timestamp_start, timestamp_end, created_time,
         updated_time, metadata_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        rid,
        record.content,
        record.type || "",
        record.priority ?? 50,
        record.scene_name || "",
        record.sessionKey || "",
        record.sessionId || "",
        tsStr, tsStart, tsEnd,
        record.createdAt || "",
        record.updatedAt || "",
        JSON.stringify(metadata)
      );
    }

    this.db.prepare(
      "INSERT INTO l1_fts (content, record_id, type, priority, scene_name) VALUES (?,?,?,?,?)"
    ).run(
      record.content,
      rid,
      record.type || "",
      record.priority ?? 50,
      record.scene_name || ""
    );

    // Only embed recall-eligible types (see NON_RECALL_TYPES): an episodic/persona
    // vector has no reader, and at 98% of the index it starves the KNN it pollutes.
    if (isVectorEligible(record.type)) this._embedAndStore(rid, record.content);
    return true;
  }

  search(query, limit = 10, typeFilter = "") {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];

    let rows;
    if (typeFilter) {
      rows = this.db.prepare(`SELECT record_id, content, type, priority, scene_name, rank
        FROM l1_fts WHERE l1_fts MATCH ? AND type = ? ORDER BY rank LIMIT ?`)
        .all(ftsQuery, typeFilter, limit);
    } else {
      rows = this.db.prepare(`SELECT record_id, content, type, priority, scene_name, rank
        FROM l1_fts WHERE l1_fts MATCH ? ORDER BY rank LIMIT ?`)
        .all(ftsQuery, limit);
    }

    return rows.map((row) => {
      const rec = this.db
        .prepare("SELECT * FROM l1_records WHERE record_id=?")
        .get(row.record_id);
      return rec || row;
    });
  }

  get(recordId) {
    return this.db.prepare("SELECT * FROM l1_records WHERE record_id=?").get(recordId) || null;
  }

  delete(recordId) {
    this.db.prepare("DELETE FROM l1_records WHERE record_id=?").run(recordId);
    this.db.prepare("DELETE FROM l1_fts WHERE record_id=?").run(recordId);
    return true;
  }

  deleteBatch(recordIds) {
    for (const rid of recordIds) {
      this.db.prepare("DELETE FROM l1_records WHERE record_id=?").run(rid);
      this.db.prepare("DELETE FROM l1_fts WHERE record_id=?").run(rid);
    }
    return recordIds.length;
  }

  count(typeFilter = "") {
    if (typeFilter) {
      return this.db.prepare("SELECT COUNT(*) as c FROM l1_records WHERE type=?").get(typeFilter).c;
    }
    return this.db.prepare("SELECT COUNT(*) as c FROM l1_records").get().c;
  }

  allRecords(typeFilter = "", limit = 1000) {
    if (typeFilter) {
      return this.db.prepare(
        "SELECT * FROM l1_records WHERE type=? ORDER BY updated_time DESC LIMIT ?"
      ).all(typeFilter, limit);
    }
    return this.db.prepare(
      "SELECT * FROM l1_records ORDER BY updated_time DESC LIMIT ?"
    ).all(limit);
  }

  // Incremental read: only records updated strictly after `sinceTs` (an ISO-8601
  // UTC string, so lexical order == chronological order). Ascending so the caller
  // processes oldest-first, matching upstream's last_extraction_updated_time
  // cursor. Empty `sinceTs` degrades to the whole pool (cold-start fallback).
  recordsSince(sinceTs = "", typeFilter = "", limit = 1000) {
    if (!sinceTs) return this.allRecords(typeFilter, limit);
    if (typeFilter) {
      return this.db.prepare(
        "SELECT * FROM l1_records WHERE type=? AND updated_time > ? ORDER BY updated_time ASC LIMIT ?"
      ).all(typeFilter, sinceTs, limit);
    }
    return this.db.prepare(
      "SELECT * FROM l1_records WHERE updated_time > ? ORDER BY updated_time ASC LIMIT ?"
    ).all(sinceTs, limit);
  }

  // Newest updated_time in the store, "" if empty. Used to advance the
  // consolidation watermark once a run has folded everything up to now.
  maxUpdatedTime() {
    const r = this.db.prepare("SELECT MAX(updated_time) AS m FROM l1_records").get();
    return (r && r.m) || "";
  }

  _embedAndStore(recordId, content) {
    try {
      const { getEmbeddingService } = require("./embedding_service.js");
      const { VectorStore } = require("./vector_store.js");
      const embSvc = getEmbeddingService();
      if (!embSvc.isReady()) return;
      embSvc.embed(content).then(vec => {
        if (!vec) return;
        const vecDbPath = path.join(path.dirname(this.dbPath), "vectors.db");
        const vecStore = new VectorStore(vecDbPath);
        vecStore.upsertVec(recordId, vec);
        vecStore.close();
      }).catch(() => {});
    } catch {}
  }

  close() {
    this.db.close();
  }
}

/**
 * Turn a raw prompt into an FTS5 MATCH expression.
 *
 * Cleaning the query is the root fix for off-target recall: this used to OR EVERY
 * raw token with no stopword removal, so a prompt like "what is the port" fired
 * `"what" OR "is" OR "the" OR "port"` — three content-free words each pulling back
 * whatever record happened to contain them. Now content-free noise is dropped:
 *   - single-character tokens (a stray letter carries no signal), and
 *   - EN/VI stopwords (the shared STOPWORDS set), matched case-insensitively.
 * FTS5 operator words are exempt (see FTS5_OPERATORS) so they stay quoted literals.
 *
 * WHAT IS PRESERVED. NFKC-normalize, then keep Unicode letters/numbers
 * (\p{L}\p{N}) + underscore/hyphen. ASCII \w would strip Vietnamese diacritics
 * (e.g. "tiếng"→"ting"), breaking recall. ORIGINAL CASE is preserved in the output
 * token (only the stopword COMPARISON lowercases), so operator literals like "AND"
 * survive untouched.
 *
 * FAIL-OPEN. A null/empty/all-stopword/all-punctuation query yields "" — never a
 * throw — and callers treat "" as "no FTS query, contribute nothing" (see
 * MemoryStore.search), so recall degrades to empty instead of crashing on the
 * hook hot path.
 */
function toFtsQuery(query) {
  const tokens = [];
  for (const word of String(query == null ? "" : query).normalize("NFKC").split(/\s+/)) {
    const clean = word.replace(/[^\p{L}\p{N}_-]/gu, "");
    if (!clean) continue;
    const lower = clean.toLowerCase();
    // Operator words are load-bearing literals; everything else must clear the
    // noise gate (length >= 2, not a stopword) to reach the query.
    if (!FTS5_OPERATORS.has(lower)) {
      if (clean.length < 2) continue;
      if (STOPWORDS.has(lower)) continue;
    }
    tokens.push(`"${clean}"`);
  }
  return tokens.join(" OR ");
}

// ── CLI ──
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`Usage: node memory_store.js <command> [options]

Commands:
  init    --db <path>                    Initialize a new index database
  search  --db <path> --query <q>        Search memories
  upsert  --db <path> --json <json>      Upsert a memory record
  count   --db <path> [--type <t>]       Count records`);
    return;
  }

  function flag(name) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : "";
  }

  const dbPath = flag("--db");
  if (!dbPath) { console.error("--db required"); process.exit(1); }

  if (cmd === "init") {
    const store = new MemoryStore(dbPath);
    console.log(`Initialized: ${dbPath}`);
    store.close();
  } else if (cmd === "search") {
    const store = new MemoryStore(dbPath);
    const results = store.search(flag("--query"), parseInt(flag("--limit") || "10"), flag("--type"));
    console.log(JSON.stringify(results, null, 2));
    store.close();
  } else if (cmd === "upsert") {
    const store = new MemoryStore(dbPath);
    const record = JSON.parse(flag("--json"));
    store.upsert(record);
    console.log(`Upserted: ${record.id}`);
    store.close();
  } else if (cmd === "count") {
    const store = new MemoryStore(dbPath);
    console.log(store.count(flag("--type")));
    store.close();
  }
}

if (require.main === module) main();

module.exports = { MemoryStore, toFtsQuery, isVectorEligible, NON_RECALL_TYPES };
