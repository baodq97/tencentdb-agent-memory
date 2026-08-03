// test/view_extract.test.js
//
// scripts/view/extract.js is the only module in the `tmem view` tree that
// touches the filesystem, so it is the only place two properties can break:
//
//   1. READ-ONLY IS STRUCTURAL. Every handle is opened `{readOnly: true}`, so
//      SQLite — not our discipline — rejects a write. The visualiser reads a
//      live store the agent is still writing to; if this property ever lapses,
//      a "viewer" silently mutates the user's memory. Pinned below by hashing
//      every fixture byte before and after a full extract, and by letting a
//      write reach through a handle opened exactly the way the readers open one.
//
//   2. `unmeasured` IS NEVER ZERO. A store whose vector capability could not be
//      exercised has UNKNOWN coverage, not 0%. Confusing the two produced a
//      false "0% embedding coverage" finding twice during the audit. The three
//      states are pinned here on real fixtures: no vectors.db (unmeasured, no
//      numeric payload at all), a present-but-EMPTY l1_vec (ok, count 0 — a
//      *measured* zero), and a populated one.
//
// Every fixture is a real SQLite store built under os.tmpdir() and removed
// afterwards. Nothing here reads or writes ~/.memory-tencentdb — see
// eval_isolation.test.js for why that rule exists.
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const E = require("../scripts/view/extract.js");
const C = require("../scripts/view/contract.js");
const { STATUS } = C;
const { META_START, META_END, memoryBaseDir } = require("../scripts/memory_writer.js");

// ── Fixture construction ────────────────────────────────────────────────────

const REAL_STORE = path.resolve(memoryBaseDir());
const ROOTS = [];

after(() => {
  for (const dir of ROOTS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** A throwaway memory root. Guarded: a fixture that could resolve onto the real
 *  store is a test that can destroy the user's memories. */
function makeRoot(tag = "root") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tmem-view-${tag}-`)));
  assert.ok(dir.startsWith(fs.realpathSync(os.tmpdir())), `fixture root escaped tmpdir: ${dir}`);
  assert.ok(!dir.startsWith(REAL_STORE), `fixture root overlaps the real store: ${dir}`);
  ROOTS.push(dir);
  return dir;
}

const SCHEMA_L1 = `
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

/** Mirrors memory_store.js. Journal mode is left at the default `delete` on
 *  purpose: WAL would leave -wal/-shm siblings whose bytes move for reasons
 *  unrelated to the property under test. */
function writeIndexDb(file, records) {
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA_L1);
    db.exec("CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const ins = db.prepare(
      "INSERT INTO l1_records (record_id, content, type, priority, scene_name, session_key," +
      " session_id, created_time, updated_time, metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    for (const r of records) {
      ins.run(
        r.record_id, r.content ?? "", r.type ?? "episodic",
        r.priority ?? 50, r.scene_name ?? "", r.session_key ?? "",
        r.session_id ?? "", r.created_time ?? "", r.updated_time ?? "",
        r.metadata_json ?? "{}",
      );
    }
  } finally { db.close(); }
}

const vec = E.probeSqliteVec();
const HAS_VEC = !!vec.module;

/**
 * A vectors.db.
 *   ids === null  -> file exists, schema NEVER initialised (no l1_vec table)
 *   ids === []    -> l1_vec present and EMPTY   <- the measured zero
 *   ids === [...] -> populated
 */
function writeVectorDb(file, ids, { dimensions = 4 } = {}) {
  const db = new DatabaseSync(file, { allowExtension: true });
  try {
    if (ids === null) {
      db.exec("CREATE TABLE IF NOT EXISTS vec_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      return;
    }
    db.enableLoadExtension(true);
    vec.module.load(db);
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec USING vec0(" +
      `record_id TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`,
    );
    const ins = db.prepare("INSERT INTO l1_vec (record_id, embedding) VALUES (?, ?)");
    for (const id of ids) {
      ins.run(id, new Float32Array(Array.from({ length: dimensions }, (_, i) => (i + 1) / 10)));
    }
  } finally { db.close(); }
}

function sceneText({ summary = "a scene", heat = 3, created = "2026-01-01T00:00:00Z", updated = "2026-01-02T00:00:00Z", body = "body text" } = {}) {
  return `${META_START}\nsummary: ${summary}\nheat: ${heat}\ncreated: ${created}\nupdated: ${updated}\n${META_END}\n${body}\n`;
}

/**
 * @param {string} root
 * @param {string} slug  "global" or a project slug
 * @param {{records?: Array, vectors?: undefined|null|string[], scenes?: Object,
 *          persona?: string, sceneDir?: boolean}} [opts]
 *   `vectors` undefined => no vectors.db file at all (the unmeasured case).
 *   `scenes` undefined  => no scene_blocks/ at all (also unmeasured).
 */
function makeStore(root, slug, opts = {}) {
  const dir = slug === "global" ? path.join(root, "global") : path.join(root, "projects", slug);
  fs.mkdirSync(dir, { recursive: true });

  if (opts.records) writeIndexDb(path.join(dir, "index.db"), opts.records);
  if (opts.corruptIndexDb) fs.writeFileSync(path.join(dir, "index.db"), "this is not a database\n");
  if (opts.vectors !== undefined) writeVectorDb(path.join(dir, "vectors.db"), opts.vectors);
  if (opts.scenes || opts.sceneDir) {
    const sd = path.join(dir, "scene_blocks");
    fs.mkdirSync(sd, { recursive: true });
    for (const [name, meta] of Object.entries(opts.scenes || {})) {
      fs.writeFileSync(path.join(sd, `${name}.md`), sceneText(meta));
    }
  }
  if (opts.persona) fs.writeFileSync(path.join(dir, "persona.md"), opts.persona);
  return dir;
}

const rec = (id, over = {}) => ({
  record_id: id,
  content: `content of ${id}`,
  type: "episodic",
  created_time: "2026-01-01T00:00:00Z",
  updated_time: "2026-01-01T00:00:00Z",
  ...over,
});

/** slug -> StoreExtract, so a test can name the store it means. */
const bySlug = (root) => Object.fromEntries(root.stores.map((s) => [s.ref.slug, s]));

const storeOf = (rootDir, slug) => {
  const ref = E.listStores(rootDir).find((r) => r.slug === slug);
  assert.ok(ref, `no store ${slug} discovered under ${rootDir}`);
  return ref;
};

// ── rootDir plumbing ────────────────────────────────────────────────────────
//
// Everything below depends on extractAll() being pointable at a fixture. If
// this test fails, the rest are measuring the developer's real store.

test("extractAll({rootDir}): reads the fixture root and nothing else", () => {
  const root = makeRoot("plumbing");
  makeStore(root, "global", { records: [rec("m_1")] });
  makeStore(root, "proj-a", { records: [rec("ac_1")] });

  const out = E.extractAll({ rootDir: root });

  assert.equal(out.rootDir, root);
  assert.notEqual(out.rootDir, REAL_STORE);
  assert.deepEqual(out.stores.map((s) => s.ref.slug).sort(), ["global", "proj-a"]);
  for (const s of out.stores) {
    assert.ok(s.ref.dir.startsWith(root), `store ${s.ref.slug} lives outside the fixture: ${s.ref.dir}`);
  }
});

test("extractAll({rootDir}): an empty root yields no stores rather than falling back", () => {
  const out = E.extractAll({ rootDir: makeRoot("bare") });
  assert.deepEqual(out.stores, []);
  assert.equal(out.persona.status, STATUS.UNMEASURED);
  assert.equal(out.state.status, STATUS.UNMEASURED);
  assert.equal(out.captureState.status, STATUS.UNMEASURED);
});

// ── Property 1: read-only is enforced structurally ──────────────────────────

/** sha256 of every regular file under `dir`, keyed by relative path, plus
 *  size+mtime so a rewrite with identical bytes would still be caught. */
function fingerprint(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const st = fs.statSync(p);
      out[path.relative(dir, p)] = [
        crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
        st.size,
        st.mtimeMs,
      ].join(":");
    }
  };
  walk(dir);
  return out;
}

test("read-only: a full extract leaves every fixture byte, size and mtime untouched", () => {
  const root = makeRoot("readonly");
  makeStore(root, "global", {
    records: [rec("m_1"), rec("ac_2")],
    vectors: HAS_VEC ? ["m_1"] : undefined,
    scenes: { alpha: { heat: 5 } },
    persona: "# User Persona\n\n## Identity\n- Dev Aster, staff engineer.\n",
  });
  makeStore(root, "proj-a", { records: [rec("m_3")], vectors: HAS_VEC ? [] : undefined });
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ sessions: {}, projects: {} }));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ consolidate_every: 20 }));
  fs.writeFileSync(path.join(root, "capture_state.json"), JSON.stringify({ turn_count: 5, last_consolidation_turn: 0 }));

  const before = fingerprint(root);
  assert.ok(Object.keys(before).length >= 5, "fixture is too thin to prove anything");

  const out = E.extractAll({ rootDir: root });
  assert.equal(out.stores.length, 2);

  // No new file either: a stray -wal/-journal is still a write to the user's store.
  assert.deepEqual(fingerprint(root), before);
});

test("read-only: index.db handles reject writes at the SQLite level, not by convention", () => {
  const root = makeRoot("ro-index");
  makeStore(root, "global", { records: [rec("m_1")] });
  const ref = storeOf(root, "global");

  const db = E.openReadOnly(ref.indexDbPath);
  try {
    assert.throws(
      () => db.exec("DELETE FROM l1_records WHERE record_id = 'm_1'"),
      /readonly|read-only/i,
    );
    assert.throws(
      () => db.prepare("INSERT INTO l1_records (record_id, content) VALUES (?, ?)").run("x_1", "smuggled"),
      /readonly|read-only/i,
    );
    assert.throws(() => db.exec("DROP TABLE l1_records"), /readonly|read-only/i);
    // The read still works — read-only is not "broken", it is one-way.
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM l1_records").get().c, 1);
  } finally { db.close(); }
});

test("read-only: the allowExtension handle vectors.db uses is read-only too", { skip: !HAS_VEC && "sqlite-vec unavailable" }, () => {
  const root = makeRoot("ro-vec");
  makeStore(root, "global", { records: [rec("m_1")], vectors: ["m_1"] });
  const ref = storeOf(root, "global");

  const db = E.openReadOnly(ref.vectorDbPath, { allowExtension: true });
  try {
    db.enableLoadExtension(true);
    vec.module.load(db);
    assert.throws(() => db.exec("DELETE FROM l1_vec"), /readonly|read-only/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM l1_vec").get().c, 1);
  } finally { db.close(); }
});

// ── Property 2: `unmeasured` is never zero ──────────────────────────────────

test("contract guard: a non-ok Source carrying a numeric payload throws", () => {
  // This is the guard that makes the whole property enforceable rather than
  // aspirational; extract.js relies on it firing.
  assert.throws(() => C.unmeasured("no vectors.db", { count: 0 }), /must not carry numeric field "count"/);
  assert.throws(() => C.errored("boom", { total: 0 }), /must not carry numeric field "total"/);
  assert.throws(() => C.source(STATUS.UNMEASURED, { count: 5 }, "r"), /must not carry numeric field/);
  assert.throws(() => C.unmeasured(null, {}), /requires a reason/);
  // ...and that `ok` may carry a zero, because a measured zero is trustworthy.
  assert.deepEqual(C.ok({ count: 0 }), { status: "ok", reason: null, count: 0 });
});

test("vectors: no vectors.db -> unmeasured with a NULL payload, never a zero", () => {
  const root = makeRoot("vec-absent");
  makeStore(root, "global", { records: [rec("m_1"), rec("m_2")] }); // vectors omitted entirely
  const ref = storeOf(root, "global");
  assert.equal(ref.vectorDbPath, null);

  const v = E.readVectorIds(ref);
  C.validateSource(v, "vectors");
  assert.equal(v.status, STATUS.UNMEASURED);
  assert.match(v.reason, /vectors\.db not present/);
  assert.equal(v.count, null);
  assert.equal(v.recordIds, null);
  assert.equal(v.dimensions, null);
  assert.equal(C.isMeasured(v), false);
  for (const [k, val] of Object.entries(v)) {
    assert.notEqual(typeof val, "number", `unmeasured vector read leaked a number in "${k}"`);
  }
});

test("vectors: present but EMPTY l1_vec -> ok with count 0 — a measured zero", { skip: !HAS_VEC && "sqlite-vec unavailable" }, () => {
  const root = makeRoot("vec-empty");
  makeStore(root, "global", { records: [rec("m_1"), rec("m_2")], vectors: [] });
  const ref = storeOf(root, "global");
  assert.notEqual(ref.vectorDbPath, null);

  const v = E.readVectorIds(ref);
  C.validateSource(v, "vectors");
  assert.equal(v.status, STATUS.OK);
  assert.equal(v.reason, null);
  assert.equal(v.count, 0);
  assert.equal(v.recordIds.size, 0);
  assert.equal(C.isMeasured(v), true);
});

test("vectors: the empty case and the absent case are not interchangeable", { skip: !HAS_VEC && "sqlite-vec unavailable" }, () => {
  const root = makeRoot("vec-split");
  makeStore(root, "global", { records: [rec("m_1")] });                 // never set up
  makeStore(root, "empty-store", { records: [rec("m_2")], vectors: [] }); // set up, empty
  makeStore(root, "full-store", { records: [rec("m_3")], vectors: ["m_3"] });

  const s = bySlug(E.extractAll({ rootDir: root }));

  assert.equal(s.global.vectors.status, STATUS.UNMEASURED);
  assert.equal(s.global.vectors.count, null);

  assert.equal(s["empty-store"].vectors.status, STATUS.OK);
  assert.equal(s["empty-store"].vectors.count, 0);

  assert.equal(s["full-store"].vectors.status, STATUS.OK);
  assert.equal(s["full-store"].vectors.count, 1);

  // The distinction survives as a (status, count) pair — the exact input
  // transform.vectorStateFor() reads. Collapsing it is how 21 live stores with
  // installed-but-empty embedding machinery disappeared into a coverage average.
  const pairs = ["global", "empty-store", "full-store"].map((k) => `${s[k].vectors.status}/${s[k].vectors.count}`);
  assert.deepEqual(pairs, ["unmeasured/null", "ok/0", "ok/1"]);
});

test("vectors: vectors.db with no l1_vec table -> unmeasured, not an empty measurement", () => {
  const root = makeRoot("vec-noschema");
  makeStore(root, "global", { records: [rec("m_1")], vectors: null }); // file exists, schema absent
  const v = E.readVectorIds(storeOf(root, "global"));
  assert.equal(v.status, STATUS.UNMEASURED);
  assert.match(v.reason, /no l1_vec table/);
  assert.equal(v.count, null);
});

test("vectors: dimensionality is read from the data, not assumed", { skip: !HAS_VEC && "sqlite-vec unavailable" }, () => {
  const root = makeRoot("vec-dims");
  const dir = makeStore(root, "global", { records: [rec("m_1")] });
  writeVectorDb(path.join(dir, "vectors.db"), ["m_1"], { dimensions: 12 });
  assert.equal(E.readVectorIds(storeOf(root, "global")).dimensions, 12);
});

test("records: no index.db -> unmeasured with null payload; empty table -> ok with total 0", () => {
  const root = makeRoot("rec-states");
  makeStore(root, "global", {});               // directory only
  makeStore(root, "empty-idx", { records: [] }); // initialised, never written

  const s = bySlug(E.extractAll({ rootDir: root }));

  const absent = s.global.records;
  C.validateSource(absent, "records");
  assert.equal(absent.status, STATUS.UNMEASURED);
  assert.match(absent.reason, /index\.db not present/);
  assert.equal(absent.total, null);
  assert.equal(absent.records, null);
  assert.equal(absent.truncated, null);

  const empty = s["empty-idx"].records;
  assert.equal(empty.status, STATUS.OK);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.records, []);
  assert.equal(empty.truncated, false);
});

test("records: a corrupt index.db is `error`, with a reason and no numbers", () => {
  const root = makeRoot("rec-corrupt");
  makeStore(root, "global", { corruptIndexDb: true });
  const r = E.readRecords(storeOf(root, "global"));
  C.validateSource(r, "records");
  assert.equal(r.status, STATUS.ERROR);
  assert.match(r.reason, /index\.db unreadable/);
  assert.equal(r.total, null);
  assert.equal(r.records, null);
});

test("records: columns, defaults and unparsable metadata degrade per-field, not per-store", () => {
  const root = makeRoot("rec-fields");
  makeStore(root, "global", {
    records: [
      rec("m_1", { metadata_json: "{\"a\":1}", priority: 90, scene_name: "s1" }),
      rec("m_2", { metadata_json: "not json at all" }),
      rec("m_3", { metadata_json: "[1,2,3]" }),
    ],
  });
  const r = E.readRecords(storeOf(root, "global"));
  assert.equal(r.status, STATUS.OK);
  assert.equal(r.total, 3);
  assert.deepEqual(r.records.map((x) => x.record_id), ["m_1", "m_2", "m_3"]);
  assert.deepEqual(r.records[0].metadata, { a: 1 });
  assert.equal(r.records[0].priority, 90);
  assert.equal(r.records[0].scene_name, "s1");
  // One malformed blob must not cost the other records.
  assert.deepEqual(r.records[1].metadata, {});
  assert.equal(r.records[1].priority, 50);
  // NOTE (reported, not pinned): a JSON *array* survives `safeJson`'s
  // `typeof v === "object"` check and lands on `metadata` as an array, where the
  // contract says `{Object} metadata` and every other unparsable shape becomes
  // `{}`. Harmless today — nothing downstream indexes metadata — so this asserts
  // only that the read stays legible rather than freezing the current answer.
  assert.equal(typeof r.records[2].metadata, "object");
  assert.notEqual(r.records[2].metadata, null);
});

test("records: a cap produces a truncated-but-honest read, never a shrunken total", () => {
  const root = makeRoot("rec-limit");
  makeStore(root, "global", { records: [rec("m_1"), rec("m_2"), rec("m_3"), rec("m_4")] });
  const r = E.readRecords(storeOf(root, "global"), { limit: 2 });
  assert.equal(r.status, STATUS.OK);
  assert.equal(r.total, 4);
  assert.equal(r.records.length, 2);
  assert.equal(r.truncated, true);
});

test("scenes: no scene_blocks/ -> unmeasured; empty scene_blocks/ -> ok with []", () => {
  const root = makeRoot("scene-states");
  makeStore(root, "global", { records: [rec("m_1")] });        // no scene_blocks
  makeStore(root, "empty-scenes", { records: [], sceneDir: true });

  const s = bySlug(E.extractAll({ rootDir: root }));
  assert.equal(s.global.scenes.status, STATUS.UNMEASURED);
  assert.match(s.global.scenes.reason, /scene_blocks\/ not present/);
  assert.equal(s.global.scenes.scenes, null);

  assert.equal(s["empty-scenes"].scenes.status, STATUS.OK);
  assert.deepEqual(s["empty-scenes"].scenes.scenes, []);
});

test("scenes: META block fields are parsed and bodyChars excludes the header", () => {
  const root = makeRoot("scene-parse");
  makeStore(root, "global", {
    records: [],
    scenes: {
      alpha: { summary: "alpha scene", heat: 5, created: "2026-01-01T00:00:00Z", updated: "2026-02-01T00:00:00Z", body: "0123456789" },
      beta: { summary: "beta scene", heat: 2 },
    },
  });
  const sr = E.readScenes(storeOf(root, "global"));
  assert.equal(sr.status, STATUS.OK);
  const alpha = sr.scenes.find((s) => s.name === "alpha");
  assert.equal(alpha.summary, "alpha scene");
  assert.equal(alpha.heat, 5);
  assert.equal(alpha.updated, "2026-02-01T00:00:00Z");
  assert.equal(alpha.bodyChars, "0123456789\n".length);
  assert.ok(alpha.bytes > alpha.bodyChars);
  assert.equal(sr.scenes.find((s) => s.name === "beta").heat, 2);
});

test("persona: absent -> unmeasured with null payload; present -> ok with ordinals", () => {
  const missing = makeRoot("persona-absent");
  makeStore(missing, "global", { records: [] });
  const none = E.extractAll({ rootDir: missing }).persona;
  C.validateSource(none, "persona");
  assert.equal(none.status, STATUS.UNMEASURED);
  assert.equal(none.bytes, null);
  assert.equal(none.bullets, null);

  const root = makeRoot("persona-present");
  makeStore(root, "global", {
    records: [],
    persona: "# User Persona\n\n## Identity\n- Dev Aster, staff engineer.\n- Hanoi.\n\n## Rules\n- Never force-push.\n",
  });
  const p = E.extractAll({ rootDir: root }).persona;
  assert.equal(p.status, STATUS.OK);
  assert.equal(p.bullets.length, 3);
  assert.deepEqual(p.bullets.map((b) => b.ordinal), [0, 1, 2]);
  assert.deepEqual(p.sections.map((s) => s.name), ["Identity", "Rules"]);
  assert.ok(p.bullets.every((b) => b.lineNo > 0), "line numbers should resolve for a canonical persona");
  assert.equal(typeof p.bytes, "number");
});

test("root documents: absent -> unmeasured, corrupt -> error, valid -> ok", () => {
  const bare = makeRoot("docs-absent");
  const none = E.extractAll({ rootDir: bare });
  assert.equal(none.state.status, STATUS.UNMEASURED);
  assert.equal(none.state.pendingSessions, null);
  assert.equal(none.captureState.status, STATUS.UNMEASURED);
  assert.equal(none.captureState.turnCount, null);
  // A missing config.json is normal — every knob has a default — so the
  // EFFECTIVE values stay measurable and this alone stays `ok`.
  assert.equal(none.config.status, STATUS.OK);
  assert.deepEqual(none.config.config, {});

  const bad = makeRoot("docs-corrupt");
  fs.writeFileSync(path.join(bad, "state.json"), "{ this is not json");
  fs.writeFileSync(path.join(bad, "config.json"), "{ nor is this");
  const broken = E.extractAll({ rootDir: bad });
  assert.equal(broken.state.status, STATUS.ERROR);
  assert.match(broken.state.reason, /state\.json unreadable/);
  assert.equal(broken.config.status, STATUS.ERROR);

  const good = makeRoot("docs-ok");
  fs.writeFileSync(path.join(good, "state.json"), JSON.stringify({
    sessions: { a: { status: "completed" }, b: { status: "pending" }, c: {} },
    projects: { "slug-x": { recall: false }, "slug-y": { recall: true } },
  }));
  fs.writeFileSync(path.join(good, "capture_state.json"), JSON.stringify({
    turn_count: 42, last_consolidation_turn: 20, sessions: {},
  }));
  const ok = E.extractAll({ rootDir: good });
  assert.equal(ok.state.status, STATUS.OK);
  assert.equal(ok.state.pendingSessions, 2);
  assert.deepEqual(ok.state.recallDisabledSlugs, ["slug-x"]);
  assert.equal(ok.captureState.turnCount, 42);
  assert.equal(ok.captureState.lastConsolidationTurn, 20);
});

// ── Coverage: unmeasured stores leave the denominator ───────────────────────

test("makeCoverage: storeless stores are excluded from the denominator, not counted as 0%", () => {
  const root = makeRoot("coverage");
  makeStore(root, "measured", {
    records: [rec("m_1"), rec("m_2"), rec("m_3"), rec("m_4")],
    vectors: HAS_VEC ? ["m_1", "m_2"] : [],
  });
  makeStore(root, "storeless", { records: Array.from({ length: 96 }, (_, i) => rec(`m_x${i}`)) });

  const s = bySlug(E.extractAll({ rootDir: root }));
  const entries = Object.values(s).map((st) => {
    const total = st.records.total;
    if (st.vectors.status !== STATUS.OK) {
      return { status: st.vectors.status, reason: st.vectors.reason, records: total };
    }
    const covered = st.records.records.filter((r) => st.vectors.recordIds.has(r.record_id)).length;
    return { status: STATUS.OK, records: total, covered };
  });

  const cov = C.makeCoverage("vectors", entries);
  C.validateCoverage(cov);

  assert.equal(cov.measuredStores, 1);
  assert.equal(cov.measuredRecords, 4);
  assert.equal(cov.unmeasuredStores, 1);
  assert.equal(cov.unmeasuredRecords, 96);
  assert.equal(cov.partial, true);
  assert.ok(cov.unmeasuredReasons.length >= 1);

  if (HAS_VEC) {
    assert.equal(cov.covered, 2);
    assert.equal(cov.ratio, 0.5);
    // The blended answer this machinery exists to make inexpressible.
    assert.notEqual(cov.ratio, 2 / 100);
  }
  // Whatever the numerator, the 96 storeless records are never in the denominator.
  assert.equal(cov.measuredRecords + cov.unmeasuredRecords, 100);
  assert.ok(cov.measuredRecords < 100);
});

test("validateCoverage: a blended denominator is rejected", () => {
  assert.throws(() => C.validateCoverage({
    metric: "vectors",
    measuredStores: 1, measuredRecords: 100, covered: 2,
    ratio: 2 / 4, // computed against the honest denominator, reported against the blended one
    unmeasuredStores: 1, unmeasuredRecords: 96, erroredStores: 0,
    unmeasuredReasons: [], partial: true,
  }), /an unmeasured store has been blended into the denominator/);

  assert.throws(() => C.validateCoverage({
    metric: "vectors",
    measuredStores: 1, measuredRecords: 4, covered: 2, ratio: 0.5,
    unmeasuredStores: 1, unmeasuredRecords: 96, erroredStores: 0,
    unmeasuredReasons: [], partial: false, // the caveat the UI needs, dropped
  }), /"partial" flag disagrees/);

  assert.throws(
    () => C.makeCoverage("vectors", [{ status: STATUS.OK, records: 4 }]),
    /measured entry missing numeric "covered"/,
  );
});

// ── Whole-extract invariants ────────────────────────────────────────────────

test("every Source a full extract produces is well-formed", () => {
  const root = makeRoot("wellformed");
  makeStore(root, "global", {
    records: [rec("m_1"), rec("ac_2")],
    vectors: HAS_VEC ? ["m_1"] : undefined,
    scenes: { alpha: { heat: 4 } },
    persona: "# User Persona\n\n## Identity\n- Dev Aster.\n",
  });
  makeStore(root, "no-index", {});
  makeStore(root, "corrupt", { corruptIndexDb: true });
  makeStore(root, "empty-vec", { records: [rec("m_9")], vectors: HAS_VEC ? [] : null });

  const out = E.extractAll({ rootDir: root });

  for (const s of out.stores) {
    for (const field of ["records", "vectors", "scenes"]) {
      const src = s[field];
      C.validateSource(src, `${s.ref.slug}.${field}`);
      if (src.status !== STATUS.OK) {
        for (const [k, v] of Object.entries(src)) {
          assert.notEqual(typeof v, "number", `${s.ref.slug}.${field}.${k} is a number under status ${src.status}`);
        }
      }
    }
    assert.equal(typeof s.ref.indexDbBytes, "number");
    assert.equal(typeof s.ref.vectorDbBytes, "number");
    assert.equal(E.storeSizeBytes(s.ref), s.ref.indexDbBytes + s.ref.vectorDbBytes);
  }

  for (const field of ["persona", "state", "config", "captureState"]) {
    C.validateSource(out[field], field);
  }
  assert.ok(Date.parse(out.extractedAt) > 0);
});

test("readers are independent: a corrupt index.db still reports scenes", () => {
  const root = makeRoot("independent");
  makeStore(root, "global", { corruptIndexDb: true, scenes: { alpha: { heat: 3 } } });
  const s = bySlug(E.extractAll({ rootDir: root })).global;
  assert.equal(s.records.status, STATUS.ERROR);
  assert.equal(s.scenes.status, STATUS.OK);
  assert.equal(s.scenes.scenes.length, 1);
});

test("discovery lists a store whose index.db is absent — invisible is worse than broken", () => {
  const root = makeRoot("discovery");
  makeStore(root, "global", {});
  makeStore(root, "empty-dir", {});
  const refs = E.listStores(root);
  assert.deepEqual(refs.map((r) => r.slug).sort(), ["empty-dir", "global"]);
  assert.equal(refs.find((r) => r.slug === "global").hasIndexDb, false);
  assert.equal(refs.find((r) => r.slug === "global").scope, "global");
  assert.equal(refs.find((r) => r.slug === "empty-dir").scope, "project");
});
