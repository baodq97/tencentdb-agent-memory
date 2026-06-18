#!/usr/bin/env node
/**
 * Storage engine for the contributor-intelligence feature.
 * Separate DB from the user's own memory — never touches memory/index.db.
 */
"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;

const DIMENSIONS = Object.freeze([
  "idea", "plan", "solve", "craft",
  "comms", "mentor", "conflict",
  "scope", "ownership", "execution",
]);
const DIM_SET = new Set(DIMENSIONS);

const CREATE_ATOMS = `
CREATE TABLE IF NOT EXISTS subject_atoms (
    record_id     TEXT PRIMARY KEY,
    subject_id    TEXT NOT NULL,
    dimension     TEXT NOT NULL,
    content       TEXT NOT NULL,
    evidence_json TEXT DEFAULT '[]',
    priority      INTEGER DEFAULT 50,
    scene_name    TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '{}',
    created_time  TEXT DEFAULT '',
    updated_time  TEXT DEFAULT ''
)`;

const CREATE_ATOMS_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS subject_atoms_fts USING fts5(
    content,
    record_id UNINDEXED,
    subject_id UNINDEXED,
    dimension UNINDEXED,
    tokenize='unicode61'
)`;

const CREATE_SCENES = `
CREATE TABLE IF NOT EXISTS subject_scenes (
    scene_id     TEXT PRIMARY KEY,
    subject_id   TEXT NOT NULL,
    name         TEXT NOT NULL,
    summary      TEXT DEFAULT '',
    dimension    TEXT DEFAULT '',
    updated_time TEXT DEFAULT ''
)`;

const CREATE_PERSONAS = `
CREATE TABLE IF NOT EXISTS subject_personas (
    subject_id      TEXT PRIMARY KEY,
    summary         TEXT DEFAULT '',
    dimensions_json TEXT DEFAULT '{}',
    notable_json    TEXT DEFAULT '[]',
    updated_time    TEXT DEFAULT ''
)`;

const CREATE_L4 = `
CREATE TABLE IF NOT EXISTS l4_capability (
    capability   TEXT PRIMARY KEY,
    dimension    TEXT DEFAULT '',
    prevalence   REAL DEFAULT 0,
    exemplar     TEXT DEFAULT '',
    summary      TEXT DEFAULT '',
    updated_time TEXT DEFAULT ''
)`;

const CREATE_META = `
CREATE TABLE IF NOT EXISTS store_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)`;

class ContribStore {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(CREATE_ATOMS);
    this.db.exec(CREATE_ATOMS_FTS);
    this.db.exec(CREATE_SCENES);
    this.db.exec(CREATE_PERSONAS);
    this.db.exec(CREATE_L4);
    this.db.exec(CREATE_META);
    this.db.prepare("INSERT OR IGNORE INTO store_meta (key,value) VALUES (?,?)")
      .run("schema_version", String(SCHEMA_VERSION));
    this._backfillFts();
  }

  // Rebuild the FTS index from subject_atoms if it's empty but atoms exist
  // (handles DBs created before the FTS table was added).
  _backfillFts() {
    const atoms = this.db.prepare("SELECT COUNT(*) c FROM subject_atoms").get().c;
    const indexed = this.db.prepare("SELECT COUNT(*) c FROM subject_atoms_fts").get().c;
    if (atoms === 0 || indexed > 0) return;
    const ins = this.db.prepare(
      "INSERT INTO subject_atoms_fts (content, record_id, subject_id, dimension) VALUES (?,?,?,?)"
    );
    for (const a of this.db.prepare("SELECT content, record_id, subject_id, dimension FROM subject_atoms").all()) {
      ins.run(a.content, a.record_id, a.subject_id, a.dimension);
    }
  }

  upsertAtom(atom) {
    if (!DIM_SET.has(atom.dimension)) {
      throw new Error(`unknown dimension: ${atom.dimension}`);
    }
    const now = atom.updated_time || "";
    this.db.prepare(`
      INSERT INTO subject_atoms
        (record_id, subject_id, dimension, content, evidence_json, priority, scene_name, metadata_json, created_time, updated_time)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(record_id) DO UPDATE SET
        subject_id=excluded.subject_id, dimension=excluded.dimension,
        content=excluded.content, evidence_json=excluded.evidence_json,
        priority=excluded.priority, scene_name=excluded.scene_name,
        metadata_json=excluded.metadata_json, updated_time=excluded.updated_time
    `).run(
      atom.record_id, atom.subject_id, atom.dimension, atom.content,
      JSON.stringify(atom.evidence || []), atom.priority ?? 50,
      atom.scene_name || "", JSON.stringify(atom.metadata || {}),
      now, now,
    );
    // keep FTS in sync (delete-then-insert handles content updates)
    this.db.prepare("DELETE FROM subject_atoms_fts WHERE record_id=?").run(atom.record_id);
    this.db.prepare(
      "INSERT INTO subject_atoms_fts (content, record_id, subject_id, dimension) VALUES (?,?,?,?)"
    ).run(atom.content, atom.record_id, atom.subject_id, atom.dimension);
    return atom.record_id;
  }

  getAtoms(subjectId, dimension) {
    if (dimension) {
      return this.db.prepare(
        "SELECT * FROM subject_atoms WHERE subject_id=? AND dimension=? ORDER BY updated_time DESC"
      ).all(subjectId, dimension);
    }
    return this.db.prepare(
      "SELECT * FROM subject_atoms WHERE subject_id=? ORDER BY updated_time DESC"
    ).all(subjectId);
  }

  countAtoms(subjectId) {
    if (subjectId) {
      return this.db.prepare("SELECT COUNT(*) c FROM subject_atoms WHERE subject_id=?").get(subjectId).c;
    }
    return this.db.prepare("SELECT COUNT(*) c FROM subject_atoms").get().c;
  }

  searchAtoms(query, opts = {}) {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const limit = opts.limit ?? 10;
    let sql = "SELECT record_id FROM subject_atoms_fts WHERE subject_atoms_fts MATCH ?";
    const params = [fts];
    if (opts.subjectId) { sql += " AND subject_id = ?"; params.push(opts.subjectId); }
    if (opts.dimension) { sql += " AND dimension = ?"; params.push(opts.dimension); }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);
    const ids = this.db.prepare(sql).all(...params).map((r) => r.record_id);
    return ids.map((id) => this.db.prepare("SELECT * FROM subject_atoms WHERE record_id=?").get(id)).filter(Boolean);
  }

  getAtomById(recordId) {
    return this.db.prepare("SELECT * FROM subject_atoms WHERE record_id=?").get(recordId) || null;
  }

  getCursor(subjectId) {
    const row = this.db.prepare("SELECT value FROM store_meta WHERE key=?").get(`cursor:${subjectId}`);
    return row ? row.value : null;
  }

  setCursor(subjectId, iso) {
    this.db.prepare(`
      INSERT INTO store_meta (key, value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(`cursor:${subjectId}`, iso);
  }

  upsertPersona(p) {
    this.db.prepare(`
      INSERT INTO subject_personas (subject_id, summary, dimensions_json, notable_json, updated_time)
      VALUES (?,?,?,?,?)
      ON CONFLICT(subject_id) DO UPDATE SET
        summary=excluded.summary, dimensions_json=excluded.dimensions_json,
        notable_json=excluded.notable_json, updated_time=excluded.updated_time
    `).run(
      p.subject_id, p.summary || "",
      JSON.stringify(p.dimensions || {}), JSON.stringify(p.notable_traits || []),
      p.updated_time || "",
    );
    return p.subject_id;
  }

  getPersona(subjectId) {
    const row = this.db.prepare("SELECT * FROM subject_personas WHERE subject_id=?").get(subjectId);
    if (!row) return null;
    return {
      subject_id: row.subject_id,
      summary: row.summary,
      dimensions: JSON.parse(row.dimensions_json || "{}"),
      notable_traits: JSON.parse(row.notable_json || "[]"),
      updated_time: row.updated_time,
    };
  }

  listPersonas() {
    return this.db.prepare("SELECT subject_id FROM subject_personas")
      .all().map((r) => this.getPersona(r.subject_id));
  }

  computeL4(prevalenceThreshold = 0.6, opts = {}) {
    let personas = this.listPersonas();
    if (opts.subjectIds) personas = personas.filter((p) => opts.subjectIds.includes(p.subject_id));
    if (personas.length < 2) throw new Error("need >=2 personas");
    const persist = opts.persist !== false;
    const total = personas.length;
    const rows = [];
    for (const dim of DIMENSIONS) {
      const present = personas.filter((p) => (p.dimensions[dim] || "").trim() !== "");
      const prevalence = present.length / total;
      if (prevalence < prevalenceThreshold) continue;
      // exemplar: strongest evidence in this dimension = most evidence links
      // across the subject's atoms (ties broken by smallest subject_id).
      let exemplar = "";
      let best = -1;
      for (const p of present.map((p) => p.subject_id).sort()) {
        const links = this.getAtoms(p, dim)
          .reduce((sum, a) => sum + JSON.parse(a.evidence_json || "[]").length, 0);
        if (links > best) { best = links; exemplar = p; }
      }
      rows.push({
        capability: dim, dimension: dim, prevalence,
        exemplar, summary: `${present.length}/${total} subjects`,
      });
    }
    if (persist) {
      const stmt = this.db.prepare(`
        INSERT INTO l4_capability (capability, dimension, prevalence, exemplar, summary, updated_time)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(capability) DO UPDATE SET
          dimension=excluded.dimension, prevalence=excluded.prevalence,
          exemplar=excluded.exemplar, summary=excluded.summary, updated_time=excluded.updated_time
      `);
      for (const r of rows) {
        stmt.run(r.capability, r.dimension, r.prevalence, r.exemplar, r.summary, "");
      }
    }
    return rows;
  }

  getCapabilities() {
    return this.db.prepare(
      "SELECT * FROM l4_capability ORDER BY prevalence DESC, capability ASC"
    ).all();
  }
}

function toFtsQuery(query) {
  const tokens = [];
  for (const word of (query || "").split(/\s+/)) {
    const clean = word.replace(/[^\w-]/g, "");
    if (clean) tokens.push(`"${clean}"`);
  }
  return tokens.join(" OR ");
}

module.exports = { ContribStore, DIMENSIONS, toFtsQuery };
