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
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
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

  close() {
    this.db.close();
  }
}

function toFtsQuery(query) {
  const tokens = [];
  for (const word of query.split(/\s+/)) {
    const clean = word.replace(/[^\w-]/g, "");
    if (clean) tokens.push(`"${clean}"`);
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

module.exports = { MemoryStore, toFtsQuery };
