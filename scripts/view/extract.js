#!/usr/bin/env node
/**
 * `tmem view` — extraction layer. All I/O, no arithmetic.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Two jobs, and only two.
 *
 * 1. BE STRUCTURALLY INCAPABLE OF WRITING. The visualiser reads a live store the
 *    agent is still writing to. "We only run SELECTs" is a promise; a promise is
 *    not a guarantee. Every handle here is opened with `{ readOnly: true }`, so
 *    SQLite itself answers a stray write with "attempt to write a readonly
 *    database" — verified against the real store, including `vectors.db` where
 *    `allowExtension` is also required. There is exactly one place a database is
 *    opened ({@link openReadOnly}); adding a second one without the flag is the
 *    only way to lose this property, which is why it is a single function.
 *
 * 2. NEVER REPORT AN ABSENCE AS A ZERO. This is the bug the whole `view` tree was
 *    built around: a store whose `sqlite-vec` extension did not load reported
 *    "0 vectors", got averaged into a coverage percentage, and produced a false
 *    "0% embedding coverage" alarm — twice. So no reader here returns a count it
 *    did not actually count. Missing capability is `unmeasured` with a reason
 *    naming what was missing; an attempted read that blew up is `error`. The
 *    contract's {@link module:contract.source} throws if a non-ok status carries
 *    a number, so the failure mode cannot be reintroduced by accident.
 *
 * Everything else — ratios, quantiles, classification, gaps — belongs to
 * transform.js. If you find yourself dividing in this file, you are in the wrong
 * file.
 *
 * Cost: a full pass over the real store (49 stores / ~5.5k records / 216 scenes)
 * runs well under a second, so callers may re-extract per request; there is no
 * cache here, deliberately, because a cache is a way to show stale state in a
 * tool whose entire selling point is that it is live.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { DatabaseSync } = require("node:sqlite");

const {
  STATUS, SCOPE, ok, unmeasured, errored, storeSizeBytes,
} = require("./contract.js");

const {
  memoryBaseDir, globalDir, projectDir,
  META_START, META_END,
} = require("../memory_writer.js");

const { parsePersona } = require("../persona_projection.js");

/* ------------------------------------------------------------------ *
 * Store root resolution
 *
 * Every path below is derived from a `rootDir` argument that defaults to
 * `memory_writer.memoryBaseDir()`, so production behaviour is byte-identical to
 * before this option existed. The reason it exists: without it the visualiser can
 * only ever be pointed at the user's real store, which makes both the view tests
 * and any read-only isolation proof impossible to run against a fixture.
 *
 * The layout (`global/`, `projects/<slug>/`) is restated here rather than imported
 * because memory_writer's helpers hardcode `os.homedir()`. `assertLayoutMatchesWriter`
 * guards that restatement against drift: if memory_writer ever changes where a
 * store lives, this fails loudly at require time instead of silently reading an
 * empty directory and reporting a store-less system.
 * ------------------------------------------------------------------ */

/** @param {string} [rootDir] @returns {{root: string, global: string, projects: string}} */
function rootPaths(rootDir) {
  const root = rootDir ? path.resolve(rootDir) : memoryBaseDir();
  return { root, global: path.join(root, "global"), projects: path.join(root, "projects") };
}

/** @param {string} slug @param {string} [rootDir] */
function storeDirFor(slug, rootDir) {
  const p = rootPaths(rootDir);
  return slug === "global" ? p.global : path.join(p.projects, slug);
}

/** Slugs of every project store under `rootDir`. Mirrors memory_writer.listProjectHashes(). */
function listProjectSlugs(rootDir) {
  try {
    return fs.readdirSync(rootPaths(rootDir).projects, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

(function assertLayoutMatchesWriter() {
  const p = rootPaths();
  if (p.global !== globalDir() || path.join(p.projects, "x") !== projectDir("x")) {
    throw new Error(
      "extract.js: store layout has drifted from memory_writer.js — " +
      `expected ${globalDir()} / ${projectDir("x")}, derived ${p.global} / ${path.join(p.projects, "x")}`,
    );
  }
}());

/**
 * Cap on rows pulled from one store. The real store's largest is ~1.5k rows, so
 * this never fires today; it exists so a pathological store degrades into a
 * truncated-but-honest read (`truncated: true`) instead of an OOM. transform
 * needs whole-corpus statistics, so the cap is set well above the working set
 * rather than at a page size.
 */
const DEFAULT_RECORD_LIMIT = 50000;

/** Columns the visualiser depends on. `SELECT *` is used so an older store with
 *  extra/missing columns degrades field-by-field rather than failing the query. */
const RECORD_FIELDS = Object.freeze([
  "record_id", "content", "type", "priority", "scene_name",
  "session_key", "session_id", "created_time", "updated_time",
]);

/* ------------------------------------------------------------------ *
 * SQLite: the single read-only door
 * ------------------------------------------------------------------ */

/**
 * The ONLY place this module opens a database. `readOnly` is not a convention
 * here, it is the invariant: with it set, SQLite rejects INSERT/UPDATE/DELETE at
 * the engine level, which is what makes "the visualiser cannot mutate the store"
 * checkable rather than merely intended.
 *
 * `allowExtension` is opt-in because it is only needed for `vectors.db` (loading
 * `sqlite-vec`), and a capability nothing needs should not be handed to every
 * handle. Note that a read-only handle can still LOAD an extension — the two
 * flags are orthogonal.
 *
 * @param {string} file
 * @param {{allowExtension?: boolean}} [opts]
 * @returns {DatabaseSync}
 */
function openReadOnly(file, { allowExtension = false } = {}) {
  return new DatabaseSync(file, { readOnly: true, allowExtension });
}

function closeQuietly(db) {
  if (!db) return;
  try { db.close(); } catch { /* a failed close on a read-only handle changes nothing */ }
}

/* ------------------------------------------------------------------ *
 * sqlite-vec capability probe
 * ------------------------------------------------------------------ */

const PLUGIN_CACHE_DIR = path.join(
  os.homedir(), ".claude", "plugins", "cache",
  "tencentdb-agent-memory", "tencentdb-agent-memory"
);

let _vecModule = null; // memoised probe result; the answer cannot change mid-process

/**
 * Resolve the `sqlite-vec` binding, or explain why not.
 *
 * `sqlite-vec` is a dependency of the *plugin*, not of this repo's checkout, so
 * where it lives depends on how the visualiser was launched: from the installed
 * plugin its `node_modules` is adjacent, from a bare repo clone there may be no
 * `node_modules` at all. Rather than let that accident of cwd masquerade as
 * "this store has no vectors", we try the normal resolution first and then the
 * installed plugin's cache (newest version first), and on total failure return
 * the list of paths tried so the UI can say *why* the reading is missing.
 *
 * @returns {{module: Object|null, from: string|null, reason: string|null}}
 */
function probeSqliteVec() {
  if (_vecModule) return _vecModule;
  const tried = [];

  try {
    _vecModule = { module: require("sqlite-vec"), from: "require.resolve", reason: null };
    return _vecModule;
  } catch (e) {
    tried.push(`require("sqlite-vec"): ${e.code || e.message}`);
  }

  let versions = [];
  try {
    versions = fs.readdirSync(PLUGIN_CACHE_DIR)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch (e) {
    tried.push(`${PLUGIN_CACHE_DIR}: ${e.code || e.message}`);
  }

  for (const v of versions) {
    const nodeModules = path.join(PLUGIN_CACHE_DIR, v, "node_modules");
    try {
      const req = createRequire(path.join(nodeModules, "noop.js"));
      _vecModule = { module: req("sqlite-vec"), from: nodeModules, reason: null };
      return _vecModule;
    } catch (e) {
      tried.push(`${nodeModules}: ${e.code || e.message}`);
    }
  }

  _vecModule = { module: null, from: null, reason: tried.join("; ") };
  return _vecModule;
}

/* ------------------------------------------------------------------ *
 * Store discovery
 * ------------------------------------------------------------------ */

const _labelCache = new Map();

/**
 * Best-effort display name for a project slug.
 *
 * A slug is the project root path with every `/` and `:` flattened to `-`
 * (memory_reader.slugForPath), which is lossy: `-home-dev-personal-projects-orchard-kg`
 * could split at a dozen places, and `tencentdb-agent-memory` is proof that the
 * naive "text after the last dash" is wrong. memory_reader already owns the
 * inversion — `pathFromSlugProbe()` walks the tree taking the longest real
 * directory at each step, with backtracking, and has a test pinning that
 * behaviour — so we reuse it rather than grow a second, less-tested answer to
 * the same question.
 *
 * It returns null once the project directory is deleted, which is common in a
 * store this old; then the trailing segment is the best guess available, and a
 * wrong-but-recognisable label beats showing a 90-character slug.
 *
 * @param {string} slug
 * @returns {string}
 */
function labelForSlug(slug) {
  if (_labelCache.has(slug)) return _labelCache.get(slug);

  let label;
  let resolved = null;
  try {
    const { pathFromSlugProbe } = require("../memory_reader.js");
    resolved = pathFromSlugProbe(slug);
  } catch { /* fall through to the textual guess */ }

  if (resolved) {
    label = path.basename(resolved) || resolved;
  } else {
    const parts = String(slug).split("-").filter(Boolean);
    label = parts.length ? parts[parts.length - 1] : String(slug);
  }

  _labelCache.set(slug, label);
  return label;
}

/**
 * Discover every store under `~/.memory-tencentdb`: the single `global/` store
 * plus one per directory in `projects/`.
 *
 * Discovery is `fs.existsSync` only — no database is opened — so this stays
 * cheap enough to call on every request, and a store that exists but is
 * unreadable is still *listed* (its contents then report the failure). A store
 * missing from the list would be invisible; a store listed with an errored read
 * is a finding.
 *
 * @returns {import("./contract.js").StoreRef[]}
 */
function listStores(rootDir) {
  const refs = [];

  const mk = (slug, scope, label, dir) => {
    const indexDbPath = path.join(dir, "index.db");
    const vectorDbPath = path.join(dir, "vectors.db");
    const changelogPath = path.join(dir, "changelog.jsonl");
    // One stat per database, here rather than in transform: transform must do no
    // I/O, or it stops being testable against fixtures. `statBytes` returns 0 for
    // an absent file, which doubles as the existence check.
    const indexDbBytes = statBytes(indexDbPath);
    const vectorDbBytes = statBytes(vectorDbPath);
    return {
      slug,
      scope,
      label,
      dir,
      indexDbPath,
      vectorDbPath: fs.existsSync(vectorDbPath) ? vectorDbPath : null,
      sceneDir: path.join(dir, "scene_blocks"),
      changelogPath: fs.existsSync(changelogPath) ? changelogPath : null,
      hasIndexDb: fs.existsSync(indexDbPath),
      indexDbBytes,
      vectorDbBytes,
    };
  };

  const g = rootPaths(rootDir).global;
  if (fs.existsSync(g)) refs.push(mk("global", SCOPE.GLOBAL, "global", g));

  for (const slug of listProjectSlugs(rootDir)) {
    refs.push(mk(slug, SCOPE.PROJECT, labelForSlug(slug), storeDirFor(slug, rootDir)));
  }

  return refs;
}

/** Size of a file in bytes; 0 when it does not exist or cannot be stat'ed. A
 *  missing file really does occupy zero bytes, so this zero is a measurement,
 *  not the kind of absence the Source machinery exists to protect. */
function statBytes(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

// `storeSizeBytes` used to be defined here and re-derived inline in transform.js.
// It now lives in contract.js — the module both readers already import — and is
// re-exported unchanged so existing callers (and the test that pins it) keep
// working. It is pure arithmetic over two numbers on the ref, so it belongs
// wherever both sides can reach it without dragging I/O along.

/* ------------------------------------------------------------------ *
 * Readers
 * ------------------------------------------------------------------ */

const NO_RECORDS = { records: null, total: null, truncated: null };

/**
 * All L1 rows of one store, plus the true row count.
 *
 * `ok` with `total: 0` is a real, trustworthy zero — an initialised store nobody
 * has written to. A store with no `index.db` at all is `unmeasured`: the index is
 * built lazily on first write, so its absence is a state of the world, not a
 * failure to read.
 *
 * @param {import("./contract.js").StoreRef} ref
 * @param {{limit?: number}} [opts]
 * @returns {import("./contract.js").RecordsRead}
 */
function readRecords(ref, { limit = DEFAULT_RECORD_LIMIT } = {}) {
  if (!ref.hasIndexDb) {
    return unmeasured(`index.db not present at ${ref.indexDbPath}`, NO_RECORDS);
  }

  let db = null;
  try {
    db = openReadOnly(ref.indexDbPath);
    const total = db.prepare("SELECT COUNT(*) AS c FROM l1_records").get().c;
    // rowid order == insertion order: stable across runs, and free (no index scan
    // on updated_time, which is TEXT and unindexed).
    const rows = db.prepare("SELECT * FROM l1_records ORDER BY rowid LIMIT ?").all(limit);
    const records = rows.map(toL1Record);
    return ok({ records, total, truncated: records.length < total });
  } catch (e) {
    return errored(`index.db unreadable (${ref.indexDbPath}): ${e.message}`, NO_RECORDS);
  } finally {
    closeQuietly(db);
  }
}

/** Row -> {@link L1Record}. Column names are preserved from memory_store.js on
 *  purpose: two names for one column is how a rename becomes a silent null. */
function toL1Record(row) {
  const rec = {};
  for (const f of RECORD_FIELDS) rec[f] = row[f] == null ? "" : row[f];
  rec.priority = Number.isFinite(row.priority) ? row.priority : 50;
  // Unparsable metadata is `{}` per the contract, and does NOT demote the read:
  // one malformed blob should not cost us 5,000 legible records.
  rec.metadata = safeJson(row.metadata_json, {});
  return rec;
}

/**
 * Parse a JSON blob into a plain object, or `fallback`.
 *
 * The array exclusion is the whole subtlety. `typeof [] === "object"`, so a
 * `metadata_json` of `"[1,2,3]"` would otherwise land on the record as an ARRAY
 * while every other malformed blob becomes `{}` — the contract says
 * `@property {Object} metadata`, and a field whose shape depends on the blob is
 * how `metadata.foo` becomes `undefined` for one row in five thousand, six
 * months from now, in a caller that has no reason to suspect the reader. A JSON
 * array is not object-shaped metadata; it takes the same route as unparsable
 * text. `null` is excluded for the same reason (`typeof null === "object"`).
 */
function safeJson(text, fallback) {
  if (typeof text !== "string" || !text) return fallback;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
  } catch { return fallback; }
}

const NO_VECTORS = { recordIds: null, count: null, dimensions: null };

/**
 * The set of record_ids that have an embedding in `l1_vec`.
 *
 * THE reading that motivated the contract. Four distinct ways this can fail to
 * produce a number, and all four are reported as themselves rather than as zero:
 *
 *   - no `vectors.db`            -> unmeasured (embeddings were never enabled here)
 *   - `sqlite-vec` unresolvable  -> unmeasured (our capability is missing, not their data)
 *   - extension load failed      -> unmeasured (ditto, but a different cause, so a different reason)
 *   - no `l1_vec` table          -> unmeasured (file exists, schema never initialised)
 *
 * Only an actual query failure against an initialised table is `error`. Coverage
 * for any of these stores is not 0% — it is unknown, and the UI must say so.
 *
 * THE THREE-WAY SPLIT THIS ENABLES, and the reason `ok` with `count: 0` must not
 * be collapsed into `unmeasured`: on the live store the population is
 * 24 stores unmeasured (no vectors.db at all) · 21 stores `ok` with count 0 ·
 * 4 stores `ok` with vectors. That middle group is the finding — the embedding
 * machinery is installed, the extension loads, the `l1_vec` table exists, and
 * nothing was ever written to it, so those stores silently serve FTS-only recall
 * while passing every "does vectors.db exist?" health check. transform can read
 * that split straight off `status` + `count` with no recount:
 *   status !== "ok"          -> never set up (or unreadable)
 *   status === "ok", count 0 -> set up and empty      <- the interesting one
 *   status === "ok", count>0 -> working
 *
 * Note that `sqlite-vec extension failed to load` has NOT been observed on this
 * machine — the module resolves from the plugin cache even from a bare repo
 * checkout, so all 24 unmeasured readings here come from the missing-file branch.
 * That branch is reasoned-correct, not observed-correct; treat it accordingly if
 * it ever starts firing.
 *
 * @param {import("./contract.js").StoreRef} ref
 * @returns {import("./contract.js").VectorIdsRead}
 */
function readVectorIds(ref) {
  if (!ref.vectorDbPath) {
    return unmeasured("vectors.db not present — embeddings were never written for this store", NO_VECTORS);
  }

  const vec = probeSqliteVec();
  if (!vec.module) {
    return unmeasured(`sqlite-vec module could not be resolved (${vec.reason})`, NO_VECTORS);
  }

  let db = null;
  try {
    db = openReadOnly(ref.vectorDbPath, { allowExtension: true });
  } catch (e) {
    return errored(`vectors.db could not be opened (${ref.vectorDbPath}): ${e.message}`, NO_VECTORS);
  }

  try {
    db.enableLoadExtension(true);
    vec.module.load(db);
  } catch (e) {
    closeQuietly(db);
    return unmeasured(`sqlite-vec extension failed to load: ${e.message}`, NO_VECTORS);
  }

  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='l1_vec'")
      .get();
    if (!table) {
      return unmeasured("vectors.db exists but has no l1_vec table — vector schema never initialised", NO_VECTORS);
    }

    const ids = new Set();
    for (const row of db.prepare("SELECT record_id FROM l1_vec").all()) {
      ids.add(String(row.record_id));
    }

    // Dimensionality is read from the data, not assumed from VectorStore's
    // `dimensions = 768` default: a store embedded by an older model would
    // otherwise be silently mislabelled. Unknown (empty table, or a build of
    // sqlite-vec without vec_length) stays null under an `ok` read — the ids
    // were still measured.
    let dimensions = null;
    try {
      const d = db.prepare("SELECT vec_length(embedding) AS d FROM l1_vec LIMIT 1").get();
      if (d && Number.isFinite(d.d)) dimensions = d.d;
    } catch { /* dimension is a nicety; its absence does not invalidate the id set */ }

    return ok({ recordIds: ids, count: ids.size, dimensions });
  } catch (e) {
    return errored(`l1_vec unreadable (${ref.vectorDbPath}): ${e.message}`, NO_VECTORS);
  } finally {
    closeQuietly(db);
  }
}

const NO_SCENES = { scenes: null };

/**
 * L2 scene blocks of one store.
 *
 * Each file is read exactly once — `parseSceneMeta()` reads the whole file to
 * pull four header fields, and we need `bodyChars` from the same text, so a
 * second read would double the I/O for nothing. The META block format is shared
 * with memory_writer via its exported delimiters, so the parse cannot drift from
 * the writer.
 *
 * A single unreadable scene file fails the WHOLE read (`error`). {@link SceneFile}
 * has no per-file status, so the alternative is silently dropping a scene, and a
 * scene count that quietly shrinks is precisely the class of lie this tool exists
 * to catch.
 *
 * @param {import("./contract.js").StoreRef} ref
 * @returns {import("./contract.js").ScenesRead}
 */
function readScenes(ref) {
  if (!fs.existsSync(ref.sceneDir)) {
    return unmeasured(`scene_blocks/ not present at ${ref.sceneDir} — no consolidation has run for this store`, NO_SCENES);
  }

  let files;
  try {
    files = fs.readdirSync(ref.sceneDir).filter((f) => f.endsWith(".md")).sort();
  } catch (e) {
    return errored(`scene_blocks/ unreadable (${ref.sceneDir}): ${e.message}`, NO_SCENES);
  }

  const scenes = [];
  for (const filename of files) {
    const filepath = path.join(ref.sceneDir, filename);
    try {
      const stat = fs.statSync(filepath);
      const text = fs.readFileSync(filepath, "utf-8");
      const { meta, body } = splitSceneMeta(text);
      scenes.push({
        name: filename.replace(/\.md$/, ""),
        filepath,
        summary: meta.summary || "",
        heat: toFiniteNumber(meta.heat, 0),
        created: meta.created || "",
        updated: meta.updated || "",
        bytes: stat.size,
        bodyChars: body.length,
      });
    } catch (e) {
      return errored(`scene file unreadable (${filepath}): ${e.message}`, NO_SCENES);
    }
  }

  return ok({ scenes });
}

/** Split a scene file into its META block fields and the body after it. A file
 *  with no META block is all body — legible content, just unlabelled. */
function splitSceneMeta(text) {
  const start = text.indexOf(META_START);
  const end = text.indexOf(META_END);
  if (start === -1 || end === -1 || end < start) return { meta: {}, body: text };

  const meta = {};
  for (const line of text.slice(start + META_START.length, end).trim().split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(end + META_END.length).replace(/^\n+/, "") };
}

function toFiniteNumber(v, fallback) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const NO_PERSONA = { text: null, bytes: null, mtime: null, sections: null, bullets: null };

/**
 * The L3 persona document.
 *
 * Bullet text, order AND line numbers all come from
 * `persona_projection.parsePersona()` — the same parser the runtime injector uses
 * — so the visualiser can never disagree with the projection it is drawing.
 *
 * Line numbers used to be recovered here by a second pass that mirrored the
 * parser's start-of-bullet rule and cross-checked itself, discarding EVERY line
 * number if the mirror disagreed about one. That was the right safety valve for a
 * mirror, but the mirror should not have existed: parsePersona already walks the
 * lines and now records `lineNo` (1-based, the line the `- ` marker opens on)
 * while it does. A number produced by the parser cannot disagree with the parser.
 * `lineNo` is defended below only against absence — an older projection module
 * without the field yields 0 (unknown), which is what the UI already renders as
 * "no deep link" — not against being wrong.
 *
 * @param {string} [dir] Store directory holding persona.md. Defaults to `global/`,
 *   the only store the consolidator writes a persona to today.
 * @returns {import("./contract.js").PersonaRead}
 */
function readPersonaDoc(dir = globalDir()) {
  const file = path.join(dir, "persona.md");
  if (!fs.existsSync(file)) {
    return unmeasured(`persona.md not present at ${file} — no L3 consolidation has run`, NO_PERSONA);
  }

  let text;
  let stat;
  try {
    stat = fs.statSync(file);
    text = fs.readFileSync(file, "utf-8");
  } catch (e) {
    return errored(`persona.md unreadable (${file}): ${e.message}`, NO_PERSONA);
  }

  let parsed;
  try {
    parsed = parsePersona(text);
  } catch (e) {
    return errored(`persona.md could not be parsed: ${e.message}`, NO_PERSONA);
  }

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  lines.forEach((line, i) => {
    const m = /^(#{2,6})\s+(.*)$/.exec(line);
    if (m) sections.push({ name: m[2].trim(), lineNo: i + 1 });
  });

  const bullets = [];
  let ordinal = 0;
  for (const section of parsed) {
    for (const b of section.bullets) {
      bullets.push({
        section: section.name,
        text: b.text,
        chars: b.chars,
        lineNo: Number.isInteger(b.lineNo) && b.lineNo > 0 ? b.lineNo : 0,
        ordinal,
      });
      ordinal += 1;
    }
  }

  return ok({
    text,
    bytes: Buffer.byteLength(text, "utf-8"),
    mtime: stat.mtime.toISOString(),
    sections,
    bullets,
  });
}

/* ------------------------------------------------------------------ *
 * Root-level JSON documents
 * ------------------------------------------------------------------ */

/**
 * Read + parse a JSON file at the memory root, distinguishing "not there" from
 * "there and broken". The writer paths (`updateState`, `saveConfig`,
 * `saveCaptureState`) all swallow parse errors and return `{}`; that is right for
 * a hot path and wrong for a diagnostic, because a corrupt state.json is exactly
 * the kind of thing this view should surface.
 *
 * @returns {{status: string, reason: string|null, value: Object|null}}
 */
function readRootJson(filename, rootDir) {
  const file = path.join(rootPaths(rootDir).root, filename);
  if (!fs.existsSync(file)) {
    return { status: STATUS.UNMEASURED, reason: `${filename} not present at ${file}`, value: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not a JSON object");
    return { status: STATUS.OK, reason: null, value: parsed };
  } catch (e) {
    return { status: STATUS.ERROR, reason: `${filename} unreadable (${file}): ${e.message}`, value: null };
  }
}

const NO_STATE = { sessions: null, projects: null, pendingSessions: null, recallDisabledSlugs: null };

/**
 * `state.json` — per-session consolidation status and per-project flags.
 *
 * `pendingSessions` counts sessions whose status is anything other than
 * `completed`; on the live store that is the overwhelming majority (451 of 457),
 * which is a finding for transform to interpret, not for extract to soften.
 *
 * @returns {import("./contract.js").StateRead}
 */
function readStateDoc(rootDir) {
  const r = readRootJson("state.json", rootDir);
  if (r.status !== STATUS.OK) {
    return r.status === STATUS.UNMEASURED ? unmeasured(r.reason, NO_STATE) : errored(r.reason, NO_STATE);
  }
  const sessions = r.value.sessions && typeof r.value.sessions === "object" ? r.value.sessions : {};
  const projects = r.value.projects && typeof r.value.projects === "object" ? r.value.projects : {};

  const pendingSessions = Object.values(sessions)
    .filter((s) => !s || s.status !== "completed").length;
  const recallDisabledSlugs = Object.entries(projects)
    .filter(([, v]) => v && v.recall === false)
    .map(([slug]) => slug);

  return ok({ sessions, projects, pendingSessions, recallDisabledSlugs });
}

const NO_CONFIG = {
  config: null, consolidateEvery: null, sceneNavBudgetTokens: null, personaBudgetTokens: null,
};

/**
 * `config.json` — user-tuned thresholds.
 *
 * `config` is the raw document; the two named fields are the EFFECTIVE values,
 * resolved through the same env > config > default precedence the runtime uses
 * (memory_auto_capture.getConsolidateEvery / getSceneMaxTokens). Echoing only
 * what is persisted would report `null` for the scene-nav budget on a store that
 * is in fact running the 200-token default, and transform would then be unable
 * to split scenes into visible/invisible — an unset knob is not an absent one.
 *
 * The persisted originals stay reachable for the "why does the lens disagree
 * with my config file?" question: `config.consolidate_every` and
 * `config.scene_max_tokens` are the raw keys, absent when never set, and a
 * difference between those and the effective values means an env override
 * (MEMORY_CONSOLIDATE_EVERY / MEMORY_SCENE_MAX_TOKENS) or the built-in default
 * is in force.
 *
 * @returns {import("./contract.js").ConfigRead}
 */
function readConfigDoc(rootDir) {
  const r = readRootJson("config.json", rootDir);
  // A missing config.json is normal — every knob has a default — so the effective
  // values are still measurable and this stays `ok` with an empty raw document.
  if (r.status === STATUS.ERROR) return errored(r.reason, NO_CONFIG);

  let consolidateEvery = null;
  let sceneNavBudgetTokens = null;
  let personaBudgetTokens = null;
  try {
    const ac = require("../memory_auto_capture.js");
    consolidateEvery = ac.getConsolidateEvery();
    sceneNavBudgetTokens = ac.getSceneMaxTokens();
    // `persona-max-tokens` governs the TIER-0 projection — the once-per-session
    // preamble the SessionStart hook injects, which resolves it the same way
    // (on_session_start.js: getPersonaMaxTokens() * CHARS_PER_TOKEN). Read here for
    // the same reason as the scene-nav budget: transform draws "what the agent
    // actually receives", and a hardcoded default would draw it for a user who
    // never touched the knob while lying to the one who did.
    //
    // Tier 1 deliberately has NO knob (memory_recall.PERSONA_TIER1_MAX_CHARS is
    // pinned to DEFAULT_TIER1_MAX_CHARS because it is paid every turn), so there
    // is nothing to read for it and transform keeps using the default.
    personaBudgetTokens = ac.getPersonaMaxTokens();
  } catch { /* fall through: raw config is still worth returning */ }

  return ok({ config: r.value || {}, consolidateEvery, sceneNavBudgetTokens, personaBudgetTokens });
}

const NO_CAPTURE = { turnCount: null, lastConsolidationTurn: null, sessions: null };

/**
 * `capture_state.json` — the auto-capture turn counter.
 *
 * The gap between `turnCount` and `lastConsolidationTurn` measured against
 * `consolidateEvery` is the consolidation backlog; computing it is transform's
 * job, reading the two numbers honestly is ours.
 *
 * @returns {import("./contract.js").CaptureStateRead}
 */
function readCaptureStateDoc(rootDir) {
  const r = readRootJson("capture_state.json", rootDir);
  if (r.status !== STATUS.OK) {
    return r.status === STATUS.UNMEASURED ? unmeasured(r.reason, NO_CAPTURE) : errored(r.reason, NO_CAPTURE);
  }
  return ok({
    turnCount: toFiniteNumber(r.value.turn_count, 0),
    lastConsolidationTurn: toFiniteNumber(r.value.last_consolidation_turn, 0),
    sessions: r.value.sessions && typeof r.value.sessions === "object" ? r.value.sessions : {},
  });
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

/**
 * Everything readable about one store. Readers are independent by design: a
 * store with a corrupt `index.db` still reports its scenes, and a store with no
 * vector capability still reports its records.
 *
 * @param {import("./contract.js").StoreRef} ref
 * @param {{recordLimit?: number}} [opts]
 * @returns {import("./contract.js").StoreExtract}
 */
function extractStore(ref, { recordLimit = DEFAULT_RECORD_LIMIT } = {}) {
  return {
    ref,
    records: readRecords(ref, { limit: recordLimit }),
    vectors: readVectorIds(ref),
    scenes: readScenes(ref),
  };
}

/**
 * One full pass over `~/.memory-tencentdb`.
 *
 * Sequential on purpose. The work is SQLite reads of a few MB each and the whole
 * pass is sub-second; concurrency would buy nothing measurable and would make
 * failure attribution (which store errored, and why) harder to keep exact.
 *
 * `rootDir` defaults to `memory_writer.memoryBaseDir()`, i.e. the user's real
 * store — production callers pass nothing and behave exactly as before. It exists
 * so the view can be pointed at a fixture: without it, every test of the
 * visualiser and every read-only isolation proof has to run against the live
 * store, which is both slow and the one thing this tool must not disturb.
 * `rootDir` is resolved, never created — extract does not make directories, so an
 * absent root reports zero stores rather than conjuring an empty one.
 *
 * @param {{recordLimit?: number, rootDir?: string}} [opts]
 * @returns {import("./contract.js").RootExtract}
 */
function extractAll({ recordLimit = DEFAULT_RECORD_LIMIT, rootDir } = {}) {
  const paths = rootPaths(rootDir);
  const stores = listStores(rootDir).map((ref) => extractStore(ref, { recordLimit }));
  return {
    rootDir: paths.root,
    stores,
    persona: readPersonaDoc(paths.global),
    state: readStateDoc(rootDir),
    config: readConfigDoc(rootDir),
    captureState: readCaptureStateDoc(rootDir),
    extractedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * CLI — a self-check, not a product surface.
 * `node scripts/view/extract.js` prints the provenance summary that the
 * definition-of-done asks for, including a live proof that the handles reject
 * writes. Kept here so the guarantee is re-verifiable in one command instead of
 * being trusted.
 * ------------------------------------------------------------------ */
function main() {
  const t0 = process.hrtime.bigint();
  const root = extractAll();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  let records = 0;
  let scenes = 0;
  let bytes = 0;
  let vecEmpty = 0;
  let vecWorking = 0;
  const byStatus = { ok: 0, unmeasured: 0, error: 0 };
  const reasons = new Map();

  for (const s of root.stores) {
    if (s.records.status === STATUS.OK) records += s.records.total;
    if (s.scenes.status === STATUS.OK) scenes += s.scenes.scenes.length;
    bytes += storeSizeBytes(s.ref);
    byStatus[s.vectors.status] += 1;
    if (s.vectors.status === STATUS.OK) (s.vectors.count > 0 ? vecWorking++ : vecEmpty++);
    if (s.vectors.status !== STATUS.OK) {
      const key = s.vectors.reason.replace(/\(.*?\)/g, "(…)").replace(/ at \/.*$/, " at …");
      reasons.set(key, (reasons.get(key) || 0) + 1);
    }
  }

  console.log(`root            ${root.rootDir}`);
  console.log(`stores          ${root.stores.length}`);
  console.log(`records         ${records}`);
  console.log(`scenes          ${scenes}`);
  console.log(`db bytes        ${bytes}`);
  console.log(`vectors         ok=${byStatus.ok} unmeasured=${byStatus.unmeasured} error=${byStatus.error}`);
  console.log(`                ${byStatus.unmeasured + byStatus.error} never set up · ${vecEmpty} set up and empty · ${vecWorking} working`);
  for (const [reason, n] of reasons) console.log(`                ${n}x ${reason}`);
  console.log(`persona         ${root.persona.status}` +
    (root.persona.status === STATUS.OK
      ? ` (${root.persona.bullets.length} bullets, ${root.persona.sections.length} sections, ${root.persona.bytes} bytes)`
      : ` (${root.persona.reason})`));
  console.log(`state           ${root.state.status}` +
    (root.state.status === STATUS.OK ? ` (${root.state.pendingSessions} pending sessions)` : ""));
  console.log(`config          ${root.config.status}` +
    (root.config.status === STATUS.OK
      ? ` (consolidateEvery=${root.config.consolidateEvery}, sceneNavBudgetTokens=${root.config.sceneNavBudgetTokens})`
      : ""));
  console.log(`captureState    ${root.captureState.status}` +
    (root.captureState.status === STATUS.OK
      ? ` (turn ${root.captureState.turnCount}, last consolidation ${root.captureState.lastConsolidationTurn})`
      : ""));
  console.log(`sqlite-vec      ${probeSqliteVec().from || `UNAVAILABLE: ${probeSqliteVec().reason}`}`);
  console.log(`elapsed         ${ms.toFixed(1)} ms`);

  // Read-only proof: reach through a handle opened exactly the way every reader
  // opens one, and let SQLite answer.
  const target = listStores().find((r) => r.hasIndexDb);
  if (target) {
    const db = openReadOnly(target.indexDbPath);
    try {
      db.exec("DELETE FROM l1_records WHERE record_id = '__extract_readonly_probe__'");
      console.log("readonly proof  FAILED — the write was accepted");
      process.exitCode = 1;
    } catch (e) {
      console.log(`readonly proof  rejected by SQLite: ${e.message}`);
    } finally {
      closeQuietly(db);
    }
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_RECORD_LIMIT,
  rootPaths,
  openReadOnly,
  probeSqliteVec,
  listStores,
  labelForSlug,
  storeSizeBytes,
  readRecords,
  readVectorIds,
  readScenes,
  readPersonaDoc,
  readStateDoc,
  readConfigDoc,
  readCaptureStateDoc,
  extractStore,
  extractAll,
};
