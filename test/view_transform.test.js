// test/view_transform.test.js
//
// scripts/view/transform.js is the arithmetic half of `tmem view`, and it is
// PURE: no fs, no node:sqlite, no network. That purity is what these tests
// spend — every fixture below is hand-built in memory, so what is pinned is the
// invariant rather than whatever the author's laptop happened to contain. Live
// totals move (the store grew ~30 records during one conversation), so no test
// here hard-codes one; they pin the classifier, the truth tables, the coverage
// exclusion rule and the gap guards instead.
//
// Nothing here touches ~/.memory-tencentdb, and nothing here requires
// extract.js — the purity test asserts exactly that.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");

const T = require("../scripts/view/transform.js");
const C = require("../scripts/view/contract.js");
const {
  STATUS, SCOPE, GAP_KIND, SEVERITY, HEAT_BUCKETS, HEAT_SCALE, STALE_HOT,
  LOW_SIGNAL, LOW_SIGNAL_CLASSES, LOW_SIGNAL_UNION_CLASSES, LOW_SIGNAL_BASELINE,
  WRITE_PATH, WRITE_PATHS, RECORD_TYPES, DUPLICATE_TIERS,
} = C;

// ── Fixtures (hand-built; transform never reads a byte) ─────────────────────

const rec = (id, over = {}) => ({
  record_id: id,
  content: over.content ?? `content of ${id}`,
  type: "episodic",
  priority: 50,
  scene_name: "",
  session_key: "",
  session_id: "",
  created_time: "2026-01-10T00:00:00Z",
  updated_time: "2026-01-10T00:00:00Z",
  metadata: {},
  ...over,
});

const scene = (name, over = {}) => ({
  name,
  filepath: `/fixture/${name}.md`,
  summary: `summary of ${name}`,
  heat: 3,
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-02T00:00:00Z",
  bytes: 400,
  bodyChars: 300,
  ...over,
});

/**
 * One StoreExtract.
 *   vectors: undefined -> unmeasured (no vectors.db)
 *            []        -> ok, count 0   (present and empty — the measured zero)
 *            [ids]     -> ok, populated
 *            "error"   -> errored read
 */
function storeExtract(slug, {
  scope = slug === "global" ? SCOPE.GLOBAL : SCOPE.PROJECT,
  records = [],
  recordsStatus = STATUS.OK,
  vectors,
  vectorRows,
  scenes = null,
  indexDbBytes = 4096,
  vectorDbBytes = 0,
} = {}) {
  const ref = {
    slug, scope, label: slug,
    dir: `/fixture/${slug}`,
    indexDbPath: `/fixture/${slug}/index.db`,
    vectorDbPath: vectors === undefined ? null : `/fixture/${slug}/vectors.db`,
    sceneDir: `/fixture/${slug}/scene_blocks`,
    changelogPath: null,
    hasIndexDb: recordsStatus !== STATUS.UNMEASURED,
    indexDbBytes,
    vectorDbBytes,
  };

  let recordsRead;
  if (recordsStatus === STATUS.ERROR) recordsRead = C.errored(`index.db unreadable (${ref.indexDbPath}): malformed`, { records: null, total: null, truncated: null });
  else if (recordsStatus === STATUS.UNMEASURED) recordsRead = C.unmeasured("index.db not present", { records: null, total: null, truncated: null });
  else recordsRead = C.ok({ records, total: records.length, truncated: false });

  let vectorsRead;
  if (vectors === undefined) vectorsRead = C.unmeasured("vectors.db not present — embeddings were never written for this store", { recordIds: null, count: null, dimensions: null });
  else if (vectors === "error") vectorsRead = C.errored("l1_vec unreadable", { recordIds: null, count: null, dimensions: null });
  else {
    const ids = new Set(vectors);
    vectorsRead = C.ok({ recordIds: ids, count: vectorRows ?? ids.size, dimensions: ids.size ? 768 : null });
  }

  const scenesRead = scenes === null
    ? C.unmeasured("scene_blocks/ not present", { scenes: null })
    : C.ok({ scenes });

  return { ref, records: recordsRead, vectors: vectorsRead, scenes: scenesRead };
}

/** A RootExtract with sane, measurable root documents. */
function rootExtract(stores, over = {}) {
  return {
    rootDir: "/fixture",
    stores,
    persona: C.unmeasured("persona.md not present at /fixture/global/persona.md — no L3 consolidation has run", {
      text: null, bytes: null, mtime: null, sections: null, bullets: null,
    }),
    state: C.ok({ sessions: {}, projects: {}, pendingSessions: 0, recallDisabledSlugs: [] }),
    config: C.ok({ config: {}, consolidateEvery: 20, sceneNavBudgetTokens: 200 }),
    captureState: C.ok({ turnCount: 10, lastConsolidationTurn: 10, sessions: {} }),
    extractedAt: "2026-02-01T00:00:00Z",
    ...over,
  };
}

const PERSONA_TEXT = "# User Persona\n\n## Identity\n- Dev Aster, staff engineer, Hanoi.\n\n" +
  "## Standing Instructions\n- Never force-push a shared branch.\n- No AI attribution trailers in commits.\n";

const personaRead = () => {
  const { parsePersona } = require("../scripts/persona_projection.js");
  const bullets = [];
  let ordinal = 0;
  for (const s of parsePersona(PERSONA_TEXT)) {
    for (const b of s.bullets) bullets.push({ section: s.name, text: b.text, chars: b.chars, lineNo: ordinal + 4, ordinal: ordinal++ });
  }
  return C.ok({
    text: PERSONA_TEXT,
    bytes: Buffer.byteLength(PERSONA_TEXT),
    mtime: "2026-02-01T00:00:00Z",
    sections: [{ name: "Identity", lineNo: 3 }, { name: "Standing Instructions", lineNo: 6 }],
    bullets,
  });
};

const gapKinds = (snap) => snap.gaps.map((g) => g.kind);

// ───────────────────────────────────────────────────────────────────────────
// Purity — the property every other test in this file spends
// ───────────────────────────────────────────────────────────────────────────

test("purity: transform.js contains no filesystem, sqlite or network require", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "view", "transform.js"), "utf-8");
  // The one `require("./extract.js")` in the file is inside main(), behind
  // `require.main === module`; it is allowed and is proven inert below.
  const forbidden = [
    /require\(["']node:fs["']\)/, /require\(["']fs["']\)/,
    /require\(["']node:sqlite["']\)/,
    /require\(["']node:http["']\)/, /require\(["']http["']\)/,
    /require\(["']node:child_process["']\)/,
    /require\(["']node:os["']\)/,
  ];
  for (const re of forbidden) {
    assert.equal(re.test(src), false, `transform.js gained a ${re} — purity is what makes it testable`);
  }
});

test("purity: importing and running transform loads no I/O module", () => {
  const snap = T.transformRoot(rootExtract([
    storeExtract("global", { records: [rec("m_1")], vectors: ["m_1"], scenes: [scene("alpha")] }),
  ]));
  assert.equal(typeof snap.snapshotId, "string");

  const loaded = Object.keys(require.cache);
  for (const re of [/view[\\/]extract\.js$/, /memory_store\.js$/, /vector_store\.js$/, /memory_recall\.js$/]) {
    assert.equal(loaded.some((k) => re.test(k)), false, `transform pulled in ${re}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Schema version — the id must say which rules produced it
// ───────────────────────────────────────────────────────────────────────────

test("schema version: every snapshot id carries it, so a pre-bump file is self-identifying", () => {
  // Pinned deliberately. This branch moved READER_FIRST_FLAME_AT 50 -> 4, dropped
  // the SCENE_ORPHANED/SCENE_DANGLING gap kinds and grew SceneStats/Totals — all
  // changes of *meaning*, which is what this number tracks. Anyone changing the
  // contract's semantics again should have to change this line too.
  assert.equal(C.SCHEMA_VERSION, 2);
  assert.equal(C.SNAPSHOT_ID_SPEC.prefix, `s${C.SCHEMA_VERSION}-`);

  // The retired kinds really are gone — the bump above is not cosmetic.
  assert.equal(Object.values(C.GAP_KIND).includes("scene_orphaned"), false);
  assert.equal(Object.values(C.GAP_KIND).includes("scene_dangling"), false);

  const snap = T.transformRoot(rootExtract([
    storeExtract("global", { records: [rec("m_1")], vectors: ["m_1"], scenes: [scene("alpha")] }),
  ]));
  assert.equal(snap.schemaVersion, C.SCHEMA_VERSION);
  assert.ok(snap.snapshotId.startsWith(C.SNAPSHOT_ID_SPEC.prefix), `${snap.snapshotId} lost its version prefix`);
  assert.ok(C.isSnapshotId(snap.snapshotId));

  // The envelope agrees with the payload; a client checks one number, not two.
  assert.equal(C.apiOk(null).schemaVersion, C.SCHEMA_VERSION);
  assert.equal(C.apiError("x", "y").schemaVersion, C.SCHEMA_VERSION);

  // Ids from an older contract stay *readable* (they are quoted in bug reports
  // and ack events) but are no longer mistakable for current output.
  assert.ok(C.isSnapshotId("s1-b41d81cf395452e7"));
  assert.equal("s1-b41d81cf395452e7".startsWith(C.SNAPSHOT_ID_SPEC.prefix), false);
});

// ───────────────────────────────────────────────────────────────────────────
// Snapshot retention (cli.js, the I/O layer — transform stays pure)
//
// The one test in this file that spawns a process and touches a filesystem,
// because the code under test *deletes files*. It runs against a throwaway
// --root under os.tmpdir(); it never goes near ~/.memory-tencentdb.
// ───────────────────────────────────────────────────────────────────────────

test("tmem view --snapshot: keeps the newest 10 snapshots and touches nothing else", () => {
  const os = require("node:os");
  const { spawnSync } = require("node:child_process");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-prune-"));
  const viewDir = path.join(root, "view");
  fs.mkdirSync(viewDir, { recursive: true });

  // 14 plausible snapshots, oldest first, one minute apart.
  const hex = (i) => String(i).padStart(16, "0");
  const made = [];
  for (let i = 0; i < 14; i++) {
    const p = path.join(viewDir, `snapshot-s2-${hex(i)}.json`);
    fs.writeFileSync(p, "{}\n");
    const t = new Date(Date.UTC(2026, 0, 1, 0, i));
    fs.utimesSync(p, t, t);
    made.push(path.basename(p));
  }

  // Everything else that legitimately lives in view/ — and one near-miss name.
  const decoys = ["events.jsonl", "server-info.json", "server-stopped", "snapshot-README.md", "snapshot-s2-nothex.json"];
  for (const d of decoys) fs.writeFileSync(path.join(viewDir, d), "keep me");
  fs.mkdirSync(path.join(viewDir, "snapshot-s2-0000000000000099.json"), { recursive: true }); // a directory, not a file

  const cli = path.join(__dirname, "..", "scripts", "cli.js");
  const res = spawnSync(process.execPath, [cli, "view", "--snapshot", "--root", root], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);

  const left = fs.readdirSync(viewDir).filter((n) => /^snapshot-s\d+-[0-9a-f]{16}\.json$/.test(n)).sort();
  const leftFiles = left.filter((n) => fs.statSync(path.join(viewDir, n)).isFile());

  // 14 old + 1 new = 15; the 5 oldest go, the newest 10 stay.
  assert.equal(leftFiles.length, 10, `expected 10 snapshots, got ${leftFiles.length}: ${leftFiles.join(", ")}`);
  for (const gone of made.slice(0, 5)) assert.equal(leftFiles.includes(gone), false, `${gone} should have been pruned`);
  for (const kept of made.slice(5)) assert.equal(leftFiles.includes(kept), true, `${kept} was pruned too eagerly`);

  // The file this run just wrote is never a pruning candidate, whatever its mtime.
  const written = /wrote\s+(\S+snapshot-s\d+-[0-9a-f]{16}\.json)/.exec(res.stdout);
  assert.ok(written, `no 'wrote' line in:\n${res.stdout}`);
  assert.ok(fs.existsSync(written[1]));
  assert.ok(path.basename(written[1]).startsWith(`snapshot-s${C.SCHEMA_VERSION}-`), written[1]);

  // Nothing that is not a snapshot was considered.
  for (const d of decoys) assert.ok(fs.existsSync(path.join(viewDir, d)), `pruning removed ${d}`);
  assert.ok(fs.statSync(path.join(viewDir, "snapshot-s2-0000000000000099.json")).isDirectory());

  fs.rmSync(root, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Vector states — the three-way split
// ───────────────────────────────────────────────────────────────────────────

test("vectorStateFor: the full (status, count) truth table", () => {
  const V = T.VECTOR_STATE;
  assert.deepEqual(T.VECTOR_STATES.slice().sort(), ["empty", "populated", "unmeasured"]);

  // Nothing read at all.
  assert.equal(T.vectorStateFor(null), V.UNMEASURED);
  assert.equal(T.vectorStateFor(undefined), V.UNMEASURED);
  // Read failed or capability absent — count is null by contract.
  assert.equal(T.vectorStateFor({ status: STATUS.UNMEASURED, count: null }), V.UNMEASURED);
  assert.equal(T.vectorStateFor({ status: STATUS.ERROR, count: null }), V.UNMEASURED);
  // Measured zero: installed, loadable, and empty. THE finding.
  assert.equal(T.vectorStateFor({ status: STATUS.OK, count: 0 }), V.EMPTY);
  assert.equal(T.vectorStateFor({ status: STATUS.OK, count: null }), V.EMPTY);
  // Measured non-zero.
  assert.equal(T.vectorStateFor({ status: STATUS.OK, count: 1 }), V.POPULATED);
  assert.equal(T.vectorStateFor({ status: STATUS.OK, count: 1831 }), V.POPULATED);
});

test("vector states: unmeasured / empty / populated stay three distinct populations", () => {
  const snap = T.transformRoot(rootExtract([
    storeExtract("never-setup", { records: [rec("m_1"), rec("m_2")] }),                  // no vectors.db
    storeExtract("setup-empty", { records: [rec("m_3")], vectors: [] }),                  // measured zero
    storeExtract("working", { records: [rec("m_4"), rec("m_5")], vectors: ["m_4"] }),
  ]));

  const t = snap.totals;
  assert.deepEqual(t.vectorStates, { unmeasured: 1, empty: 1, populated: 1 });
  assert.deepEqual(t.vectorStateSlugs.empty, ["setup-empty"]);
  assert.deepEqual(t.vectorStateRecords, { unmeasured: 2, empty: 1, populated: 2 });

  // The store that was never set up must not be reported as 0% coverage...
  const never = snap.stores.find((s) => s.slug === "never-setup");
  assert.equal(never.vectors.status, STATUS.UNMEASURED);
  assert.equal(never.vectors.ratio, null);
  assert.equal(never.vectors.withVector, null);
  assert.equal(never.vectors.withoutVector, null);
  // ...while the empty one legitimately is 0%, because it was measured.
  const empty = snap.stores.find((s) => s.slug === "setup-empty");
  assert.equal(empty.vectors.status, STATUS.OK);
  assert.equal(empty.vectors.ratio, 0);
  assert.equal(empty.vectors.withoutVector, 1);
});

test("coverage: unmeasured stores leave the denominator and are reported beside it", () => {
  const snap = T.transformRoot(rootExtract([
    storeExtract("measured", { records: [rec("m_1"), rec("m_2"), rec("m_3"), rec("m_4")], vectors: ["m_1", "m_2"] }),
    storeExtract("storeless", { records: Array.from({ length: 96 }, (_, i) => rec(`m_x${i}`)) }),
  ]));

  const cov = snap.totals.coverage.vectors;
  C.validateCoverage(cov, "totals.coverage.vectors");
  assert.equal(cov.measuredStores, 1);
  assert.equal(cov.measuredRecords, 4);
  assert.equal(cov.covered, 2);
  assert.equal(cov.ratio, 0.5);
  assert.equal(cov.unmeasuredStores, 1);
  assert.equal(cov.unmeasuredRecords, 96);
  assert.equal(cov.partial, true);
  assert.ok(cov.unmeasuredReasons.some((r) => /vectors\.db not present/.test(r)));

  // The blended answer (2/100 = 2%) is the false alarm this shape prevents.
  assert.notEqual(cov.ratio, 0.02);
  assert.equal(cov.measuredRecords + cov.unmeasuredRecords, snap.totals.records);
});

test("coverage: an errored store enters the caveat, never the denominator", () => {
  const snap = T.transformRoot(rootExtract([
    storeExtract("ok-store", { records: [rec("m_1")], vectors: ["m_1"] }),
    storeExtract("broken", { recordsStatus: STATUS.ERROR }),
  ]));

  const cov = snap.totals.coverage.vectors;
  assert.equal(cov.measuredStores, 1);
  assert.equal(cov.measuredRecords, 1);
  assert.equal(cov.ratio, 1);
  assert.equal(cov.erroredStores, 1);
  assert.equal(cov.partial, true);
  assert.equal(snap.totals.erroredStores, 1);
  assert.equal(snap.totals.readableStores, 1);
  // Contract §4: an errored store contributes to NO aggregate.
  assert.equal(snap.totals.records, 1);
});

test("coverage: every metric a transform emits satisfies validateCoverage", () => {
  const snap = T.transformRoot(rootExtract([
    storeExtract("global", { records: [rec("m_1"), rec("ac_2"), rec("weird_3")], vectors: ["m_1"] }),
    storeExtract("p1", { records: [rec("ac_9")] }),
    storeExtract("p2", { recordsStatus: STATUS.ERROR }),
    storeExtract("p3", { records: [rec("m_7")], vectors: "error" }),
  ]));

  const keys = Object.keys(snap.totals.coverage);
  assert.deepEqual(keys.sort(), ["vectors", ...WRITE_PATHS.map((wp) => `vectors:${wp}`)].sort());
  for (const [metric, cov] of Object.entries(snap.totals.coverage)) {
    C.validateCoverage(cov, metric);
    assert.ok(cov.covered <= cov.measuredRecords);
    assert.equal(cov.partial, cov.unmeasuredStores > 0);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Low-signal classification
// ───────────────────────────────────────────────────────────────────────────

// The lens and the write-side noise gate must classify with ONE function, not two
// that agree today. `test/noise_gate.test.js` used to pin the two copies equal
// over a battery of inputs; identity is the stronger pin, because a battery only
// covers the inputs somebody thought of.
test("classifyLowSignal: transform re-exports low_signal.js, it does not re-implement it", () => {
  const lowSignal = require("../scripts/low_signal.js");
  assert.equal(T.classifyLowSignal, lowSignal.classifyLowSignal,
    "transform.js has grown its own copy of the classifier again");

  // And the reason it can be imported at all: low_signal.js does no I/O either,
  // so the purity transform.js is tested on survives the dependency. (Its own
  // docstring mentions `require("../low_signal.js")` in prose, so this checks what
  // must NOT be there rather than the exact list.)
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "low_signal.js"), "utf-8");
  for (const re of [/require\(["'](node:)?fs["']\)/, /require\(["']node:sqlite["']\)/,
    /require\(["'](node:)?http["']\)/, /require\(["'](node:)?child_process["']\)/]) {
    assert.equal(re.test(src), false, `low_signal.js gained a ${re} and would break transform's purity`);
  }
  assert.ok(/require\(["']\.\/view\/contract\.js["']\)/.test(src));
});

test("classifyLowSignal: crafted records land in the intended classes", () => {
  const cls = T.classifyLowSignal;

  // The worst single offender in the real store: a sub-agent completion notice
  // the Stop hook swept up as if it were a user turn.
  assert.deepEqual(cls("<task-notification>agent finished</task-notification>"), ["taskNotification", "slashOrTag"]);
  // A slash command: control plane, not conversation.
  assert.deepEqual(cls("/memory-consolidate"), ["slashOrTag"]);
  assert.deepEqual(cls("<system-reminder>whatever</system-reminder>"), ["slashOrTag"]);
  // The echo a skill invocation prints.
  assert.deepEqual(cls("base directory for this skill: /home/dev/.claude/skills/x"), ["skillEcho"]);
  assert.deepEqual(cls("Base Directory For This Skill: /x"), ["skillEcho"]);
  // A record truncated at the 500-char capture ceiling: its point is gone.
  assert.deepEqual(cls("a".repeat(LOW_SIGNAL.PASTE_DUMP_MIN_CHARS)), ["pasteDump"]);
  assert.deepEqual(cls("a".repeat(LOW_SIGNAL.PASTE_DUMP_MIN_CHARS - 1)), []);
  // Assent tokens, EN and VI.
  assert.deepEqual(cls("ok"), ["continuation"]);
  assert.deepEqual(cls("tiếp tục"), ["continuation"]);
  assert.deepEqual(cls("được"), ["continuation"]);
  assert.deepEqual(cls("go ahead"), ["continuation"]);
  assert.deepEqual(cls(""), ["empty"]);
  assert.deepEqual(cls("   \n  "), ["empty"]);

  // Clean prose is clean, at any length.
  assert.deepEqual(cls("Prefers Vietnamese in chat and English in every committed artifact."), []);
  assert.deepEqual(cls("fix the recall budget bug"), []);
  // SHORT IS NOT NOISE — the `tooShort` class was evaluated and rejected during
  // the audit (it moved the union 38.6% -> 55.3% with nothing having changed).
  assert.deepEqual(cls("push -> create pr"), []);
  assert.deepEqual(cls("tạo agent riêng review change cái đi"), []);
  // An assent token is only low-signal as an OPENER of a short record.
  assert.deepEqual(cls("okay so the reason the recall budget blew up is the scene nav block"), []);

  for (const c of [].concat(...["ok", "/x", "<y>", ""].map(cls))) {
    assert.ok(LOW_SIGNAL_CLASSES.includes(c), `classifier emitted unknown class ${c}`);
  }
});

test("low-signal: a record matching three classes is counted ONCE in the union", () => {
  const triple = "<task-notification>" + "z".repeat(LOW_SIGNAL.PASTE_DUMP_MIN_CHARS);
  const classes = T.classifyLowSignal(triple);
  assert.deepEqual(classes, ["taskNotification", "slashOrTag", "pasteDump"]);
  assert.equal(T.isLowSignalUnion(classes), true);

  const s = T.summariseStore(storeExtract("global", { records: [rec("ac_1", { content: triple })] }));
  // Per-class counts sum above the number of affected records, by design...
  assert.equal(Object.values(s.lowSignal).reduce((a, b) => a + b, 0), 3);
  // ...and the union — the only number quotable as a share — counts the record once.
  assert.equal(s.lowSignalUnion, 1);
  assert.equal(s.records, 1);
});

test("low-signal: the union share is per-record, not per-class-hit", () => {
  const records = [
    rec("ac_1", { content: "<task-notification>" + "z".repeat(600) }), // 3 classes
    rec("ac_2", { content: "/tmem view" }),                             // 1 class
    rec("m_3", { content: "Reviews diffs bottom-up, reading tests before implementation." }),
    rec("m_4", { content: "Never force-push a shared branch." }),
  ];
  const snap = T.transformRoot(rootExtract([storeExtract("global", { records })]));
  const ls = snap.totals.lowSignal;
  assert.equal(ls.records, 4);
  assert.equal(ls.unionRecords, 2);
  assert.equal(ls.ratio, 0.5);
  assert.deepEqual(ls.unionClasses.slice().sort(), [...LOW_SIGNAL_UNION_CLASSES].sort());
  assert.ok(Object.values(ls.perClass).reduce((a, b) => a + b, 0) > ls.unionRecords);
});

test("validateLowSignalUnion: the pinned headline cannot be silently redefined", () => {
  const pinned = [...LOW_SIGNAL_UNION_CLASSES];
  assert.equal(C.validateLowSignalUnion(pinned), true);
  assert.equal(C.validateLowSignalUnion(pinned, LOW_SIGNAL_BASELINE.ratio), true);

  // Adding a class to the union without re-pinning the baseline is the exact
  // move that turned 38.6% into 55.3% with nothing about the store changed.
  assert.throws(() => C.validateLowSignalUnion([...pinned, "tooShort"]), /not in LOW_SIGNAL_UNION_CLASSES/);
  assert.throws(() => C.validateLowSignalUnion(pinned.slice(1)), /missing pinned class/);
  assert.throws(
    () => C.validateLowSignalUnion(pinned, LOW_SIGNAL_BASELINE.ratio + LOW_SIGNAL_BASELINE.TOLERANCE + 0.001),
    /drifted from the pinned/,
  );
  // Within tolerance is not drift.
  assert.equal(C.validateLowSignalUnion(pinned, LOW_SIGNAL_BASELINE.ratio + LOW_SIGNAL_BASELINE.TOLERANCE - 0.001), true);
});

test("LOW_SIGNAL_BASELINE: the pin is self-consistent (ratio == unionRecords/records)", () => {
  assert.equal(LOW_SIGNAL_BASELINE.ratio, LOW_SIGNAL_BASELINE.unionRecords / LOW_SIGNAL_BASELINE.records);
  assert.ok(Math.abs(LOW_SIGNAL_BASELINE.ratio - 0.3861) < 0.0001);
  assert.equal(LOW_SIGNAL_BASELINE.TOLERANCE, 0.02);
  for (const k of Object.keys(LOW_SIGNAL_BASELINE.perClass)) {
    assert.ok(LOW_SIGNAL_CLASSES.includes(k), `baseline names unknown class ${k}`);
  }
});

test("checkLowSignalBaseline: drift becomes a datum, never a 500", () => {
  const near = T.checkLowSignalBaseline(LOW_SIGNAL_BASELINE.ratio + 0.002); // ~the live reading
  assert.equal(near.withinTolerance, true);
  assert.equal(near.message, null);
  assert.ok(Math.abs(near.deltaPoints - 0.2) < 1e-6);
  assert.equal(near.tolerancePoints, 2);

  const far = T.checkLowSignalBaseline(0.9);
  assert.equal(far.withinTolerance, false);
  assert.match(far.message, /drifted from the pinned/);
  assert.equal(far.observed, 0.9);
  assert.equal(far.pinned, LOW_SIGNAL_BASELINE.ratio);
});

// ───────────────────────────────────────────────────────────────────────────
// Heat — a live bug being measured, not fixed
// ───────────────────────────────────────────────────────────────────────────

test("heatBucketKey: the writer's 1-5 scale, plus an offScale catch-all", () => {
  assert.equal(T.heatBucketKey(0), "historical");
  assert.equal(T.heatBucketKey(1), "historical");
  assert.equal(T.heatBucketKey(2), "recent");
  assert.equal(T.heatBucketKey(3), "recent");
  assert.equal(T.heatBucketKey(4), "active");
  assert.equal(T.heatBucketKey(5), "hot");
  assert.equal(T.heatBucketKey(6), "offScale");
  assert.equal(T.heatBucketKey(500), "offScale");
  assert.equal(T.heatBucketKey(NaN), "historical");
  assert.deepEqual(HEAT_BUCKETS.map((b) => b.key), ["historical", "recent", "active", "hot", "offScale"]);
});

test("readerHeatEmoji: the reader's ladder now fires on the writer's scale", () => {
  // The real scene_nav.heatEmoji(), not a copy. It used to return "" for every
  // heat value in the store — that emptiness WAS the finding, and R2 fixed it by
  // moving the ladder onto the 1-5 scale the consolidator documents.
  for (const h of [0, 1, 2, 3]) assert.equal(T.readerHeatEmoji(h), "");
  assert.equal(T.readerHeatEmoji(HEAT_SCALE.READER_FIRST_FLAME_AT), " 🔥");
  assert.equal(T.readerHeatEmoji(4), " 🔥");
  assert.equal(T.readerHeatEmoji(5), " 🔥🔥");
  // Two rungs only: the cue marks "active this week", it does not re-rank.
  assert.equal(T.readerHeatEmoji(1000), " 🔥🔥");
});

test("heat: the live 1-5 distribution no longer emits HEAT_SCALE_MISMATCH", () => {
  // Shaped like the live distribution ({2:9, 3:30, 4:50, 5:130}) without pinning
  // its counts, which move with every consolidation. Before R2 this store tripped
  // the gap in full; the ladder now reaches it.
  const scenes = [
    ...Array.from({ length: 2 }, (_, i) => scene(`h2_${i}`, { heat: 2 })),
    ...Array.from({ length: 3 }, (_, i) => scene(`h3_${i}`, { heat: 3 })),
    ...Array.from({ length: 5 }, (_, i) => scene(`h4_${i}`, { heat: 4 })),
    ...Array.from({ length: 13 }, (_, i) => scene(`h5_${i}`, { heat: 5 })),
  ];
  const snap = T.transformRoot(rootExtract([storeExtract("global", { records: [rec("m_1")], scenes })]));

  assert.equal(snap.gaps.find((x) => x.kind === GAP_KIND.HEAT_SCALE_MISMATCH), undefined);
  assert.equal(snap.totals.heat.buckets.offScale, 0);
  // The lens still draws four distinctions where the reader draws two.
  assert.deepEqual(snap.totals.heat.buckets, { historical: 0, recent: 5, active: 5, hot: 13, offScale: 0 });
});

test("heat: a store written entirely below the reader's first rung still emits the mismatch", () => {
  // The gap did not go away, it went quiet. A store whose whole heat population
  // sits under READER_FIRST_FLAME_AT gets no cue on any scene, which is the same
  // failure the 50-rung ladder produced — just from the writer's side.
  const scenes = [
    ...Array.from({ length: 4 }, (_, i) => scene(`h1_${i}`, { heat: 1 })),
    ...Array.from({ length: 6 }, (_, i) => scene(`h3_${i}`, { heat: 3 })),
  ];
  const snap = T.transformRoot(rootExtract([storeExtract("global", { records: [rec("m_1")], scenes })]));

  const g = snap.gaps.find((x) => x.kind === GAP_KIND.HEAT_SCALE_MISMATCH);
  assert.ok(g, "no scene can render a cue, so the disagreement must be reported");
  assert.equal(g.severity, SEVERITY.WARN);
  assert.equal(g.unmeasured, false);
  assert.equal(g.evidence.observedMin, 1);
  assert.equal(g.evidence.observedMax, 3);
  assert.equal(g.evidence.readerFirstFlameAt, HEAT_SCALE.READER_FIRST_FLAME_AT);
  assert.equal(g.evidence.scenesWithACue, 0);
  assert.equal(snap.totals.heat.scenesWithACue, 0);
});

test("heat: the mirror-image mismatch — a writer above the documented scale", () => {
  const snap = T.transformRoot(rootExtract([storeExtract("global", {
    records: [rec("m_1")],
    scenes: [scene("hot", { heat: 120 }), scene("cool", { heat: 3 })],
  })]));

  const g = snap.gaps.find((x) => x.kind === GAP_KIND.HEAT_SCALE_MISMATCH);
  assert.ok(g);
  assert.match(g.title, /above the documented/);
  assert.equal(g.evidence.offScale, 1);
  assert.equal(g.evidence.observedMax, 120);
  assert.equal(snap.totals.heat.scenesWithACue, 1);
});

test("heat: no scenes -> no heat mismatch gap (nothing was measured to disagree)", () => {
  const snap = T.transformRoot(rootExtract([storeExtract("global", { records: [rec("m_1")] })]));
  assert.equal(gapKinds(snap).includes(GAP_KIND.HEAT_SCALE_MISMATCH), false);
});

// ───────────────────────────────────────────────────────────────────────────
// Scene navigation + stale hot
// ───────────────────────────────────────────────────────────────────────────

test("sceneNavVisibility: heat-descending fill that BREAKS on overflow, not skips", () => {
  const scenes = [
    scene("short-a", { heat: 5, summary: "a" }),
    scene("very-long-name-that-eats-the-budget", { heat: 4, summary: "x".repeat(80) }),
    scene("short-b", { heat: 3, summary: "b" }),
  ];
  const tight = T.sceneNavVisibility(scenes, 140);
  assert.equal(tight.visible, 1);
  // short-b would have fitted; the long line in front of it hides everything behind.
  assert.equal(tight.invisible, 2);
  assert.equal(tight.status, STATUS.OK);

  const roomy = T.sceneNavVisibility(scenes, 4000);
  assert.equal(roomy.visible, 3);
  assert.equal(roomy.invisible, 0);
  assert.ok(roomy.usedChars <= 4000);

  // A disabled nav budget makes every scene invisible — an honest 0, not a crash.
  // Measured, and measured for the global store too: nothing renders for anyone.
  assert.deepEqual(T.sceneNavVisibility(scenes, 0),
    { status: STATUS.OK, reason: null, visible: 0, invisible: 3, usedChars: 0, budgetChars: 0 });
  assert.deepEqual(T.sceneNavVisibility(scenes, null),
    { status: STATUS.OK, reason: null, visible: 0, invisible: 3, usedChars: 0, budgetChars: null });
  assert.deepEqual(T.sceneNavVisibility(scenes, 0, { scope: SCOPE.GLOBAL }),
    { status: STATUS.OK, reason: null, visible: 0, invisible: 3, usedChars: 0, budgetChars: 0 });
  assert.equal(T.sceneNavVisibility([], 800).visible, 0);
});

// The point of contract.js is that the lens does not invent its own arithmetic.
// This is the pin: whatever `sceneNavVisibility` reports must be what the REAL
// renderer — the one memory_recall.buildSceneNav() injects with — returns for the
// same list at the same budget. A hand-rolled estimate would show up here as a
// disagreement long before it showed up as a wrong number on a dashboard.
test("sceneNavVisibility: the renderer is the source of truth, not a second estimate", () => {
  const { renderSceneNav, navLine, NAV } = require("../scripts/scene_nav.js");

  // Realistic shape: live summaries average 164 chars, the renderer cuts them to
  // 80, so a line runs ~130 and an 800-char block holds about five of them.
  const scenes = Array.from({ length: 40 }, (_, i) =>
    scene(`scene-block-name-${i}`, { heat: 5 - (i % 4), summary: "s".repeat(164) }));

  for (const budget of [140, 300, 800, 2000, 40000]) {
    const ordered = scenes.slice().sort((a, b) => (Number(b.heat) || 0) - (Number(a.heat) || 0));
    const rendered = renderSceneNav(
      ordered.map((s) => ({ name: s.name, heat: s.heat, summary: s.summary })), budget);
    const got = T.sceneNavVisibility(scenes, budget);
    assert.equal(got.visible, rendered.visibleCount, `visible disagrees with the renderer at ${budget} chars`);
    assert.equal(got.usedChars, rendered.usedChars, `usedChars disagrees with the renderer at ${budget} chars`);
    assert.equal(got.visible + got.invisible, scenes.length);
  }

  // And the shape that makes ~5 the right answer at the default budget: the cut
  // is the renderer's, not a number this file re-derived.
  assert.equal(NAV.SUMMARY_MAX_CHARS, 80);
  assert.ok(navLine(scenes[0]).length > 110 && navLine(scenes[0]).length < 145,
    `a rendered line should run ~130 chars, got ${navLine(scenes[0]).length}`);
  assert.equal(T.sceneNavVisibility(scenes, 800).visible, 5);
});

test("scenes: written-but-invisible is a finding", () => {
  const scenes = Array.from({ length: 40 }, (_, i) => scene(`scene-${i}`, { heat: 5, summary: "x".repeat(70) }));
  const records = [rec("m_1"), rec("m_2")];
  // A PROJECT store: its scenes render first in its own nav block, so the count
  // is exact. (Global is the one that cannot be measured standalone — below.)
  const snap = T.transformRoot(rootExtract([storeExtract("proj-a", { records, scenes })]));

  const s = snap.stores[0];
  assert.equal(s.scenes.count, 40);
  assert.equal(s.scenes.navStatus, STATUS.OK);
  assert.ok(s.scenes.invisibleInNav > 0);
  assert.equal(s.scenes.visibleInNav + s.scenes.invisibleInNav, 40);
  assert.ok(gapKinds(snap).includes(GAP_KIND.SCENE_INVISIBLE));

  // The totals sum PER-PROJECT blocks. With one project it is that project's
  // block; with several it is a reachability count, never one block's line count.
  assert.equal(snap.totals.scenesVisibleInNav, s.scenes.visibleInNav);
  assert.equal(snap.totals.scenesInvisibleInNav, s.scenes.invisibleInNav);
  assert.equal(snap.totals.scenesNavUnmeasured, 0);
});

test("scenes: the totals are a sum over per-project blocks, not one block's contents", () => {
  // Three projects, each with its own `<scene-navigation>` and its own budget. No
  // session ever renders more than one of them, so the sum below is "reachable in
  // some project", and it is legitimately larger than any single block.
  const many = (n, tag) => Array.from({ length: n }, (_, i) =>
    scene(`${tag}-scene-block-name-${i}`, { heat: 5, summary: "s".repeat(164) }));
  const snap = T.transformRoot(rootExtract([
    storeExtract("proj-a", { records: [rec("m_1")], scenes: many(30, "a") }),
    storeExtract("proj-b", { records: [rec("m_2")], scenes: many(30, "b") }),
    storeExtract("proj-c", { records: [rec("m_3")], scenes: many(30, "c") }),
  ]));

  const perStore = snap.stores.map((s) => s.scenes.visibleInNav);
  assert.deepEqual(perStore, [5, 5, 5], "each block holds about five lines at 800 chars");
  assert.equal(snap.totals.scenes, 90);
  assert.equal(snap.totals.scenesVisibleInNav, 15);
  assert.equal(snap.totals.scenesInvisibleInNav, 75);
  // The sum is NOT what one turn sees. Whoever reads it as such gets 15 where the
  // agent gets 5 — the same misreading in the other direction as reading 219
  // scenes as one queue.
  assert.ok(snap.totals.scenesVisibleInNav > Math.max(...perStore));
});

test("scenes: global nav visibility is unmeasured, never a plausible number", () => {
  // Global scenes render AFTER the active project's, in the same block, so how
  // many appear is a different answer per project. Computed as if global rendered
  // alone it was an upper bound presented as a measurement.
  const scenes = Array.from({ length: 12 }, (_, i) => scene(`g-${i}`, { heat: 5, summary: "s".repeat(164) }));
  const snap = T.transformRoot(rootExtract([
    storeExtract("global", { records: [rec("m_1")], scenes }),
    storeExtract("proj-a", { records: [rec("m_2")], scenes: [scene("p-0", { heat: 5 })] }),
  ]));

  const g = snap.stores.find((s) => s.slug === "global");
  assert.equal(g.scenes.count, 12);
  assert.equal(g.scenes.navStatus, STATUS.UNMEASURED);
  assert.match(g.scenes.navReason, /active project/);
  // Contract §1: an unmeasured reading carries nulls, not zeros.
  assert.equal(g.scenes.visibleInNav, null);
  assert.equal(g.scenes.invisibleInNav, null);
  assert.equal(g.scenes.navUsedChars, null);
  // The budget IS known; it is the split that is not.
  assert.equal(g.scenes.navBudgetChars, 800);

  // The 12 leave both totals and land in the caveat, exactly as an unmeasured
  // store's records leave a Coverage denominator.
  const t = snap.totals;
  assert.equal(t.scenes, 13);
  assert.equal(t.scenesVisibleInNav, 1);
  assert.equal(t.scenesInvisibleInNav, 0);
  assert.equal(t.scenesNavUnmeasured, 12);
  assert.equal(t.scenesNavUnmeasuredReasons.length, 1);

  // Reported as an absence, not dropped — and `unmeasured` caps it below critical.
  const g0 = snap.gaps.find((x) => x.kind === GAP_KIND.SCENE_INVISIBLE && x.subject.slug === "global");
  assert.ok(g0, "a store whose visibility cannot be measured must still say so");
  assert.equal(g0.unmeasured, true);
  assert.equal(g0.severity, SEVERITY.WARN);
  assert.equal(g0.evidence.invisibleInNav, undefined, "no invented number in the evidence");
});

// ── A deleted join, and the test shape that hid it ──────────────────────────
//
// This test used to also pin `orphanScenes` / `danglingSceneNames`, which
// compared `l1_records.scene_name` against scene filenames. It was green, and
// the feature it protected was meaningless: no writer in this repo maintains
// that link (auto-capture stamps the constant "auto-capture" on 96.5% of rows,
// the consolidator names scene files independently and never writes back), so
// the two gaps fired on 218 of 219 scene files and ~130 record names at once —
// both directions near-total, the signature of a broken join rather than a store
// in bad shape. The UI rendered that as "218 topic summaries have no memories
// left under them": confident, alarming, wrong.
//
// The reason the test could not catch it is worth keeping: THE FIXTURE AUTHORED
// BOTH SIDES OF THE LINK. It hand-wrote `rec("m_1", {scene_name: "scene-0"})`
// against a file named `scene-0`, so it proved the comparison computes — never
// that the relationship exists. A fixture that constructs a relationship can
// only test the arithmetic over it; whether production ever creates it is a
// question only the writers can answer. The same shape recurs anywhere a test
// supplies both endpoints of a join, a foreign key, or an id correspondence.
//
// So what is pinned now is the ABSENCE: that the kinds stay deleted, and that
// summariseScenes takes what it takes and no more — a vestigial `sceneNamesUsed`
// argument is how a deleted idea gets quietly rebuilt.

test("scene join: the removed kinds stay removed, and cannot be reconstructed via gap()", () => {
  assert.equal(GAP_KIND.SCENE_ORPHANED, undefined);
  assert.equal(GAP_KIND.SCENE_DANGLING, undefined);
  for (const kind of C.GAP_KINDS) {
    assert.equal(/orphan|dangl/.test(kind) && /scene/.test(kind), false, `scene-join kind ${kind} is back`);
  }
  // `gap()` is the only constructor, so an undeclared kind cannot re-enter the payload.
  for (const kind of ["scene_orphaned", "scene_dangling"]) {
    assert.throws(
      () => C.gap({ kind, severity: SEVERITY.WARN, subject: { slug: "s" }, title: "t" }),
      /unknown kind/,
    );
  }
  // VECTORS_ORPHANED survives and must not be swept up by the above: that join
  // (l1_vec.record_id -> l1_records.record_id) IS written and read by the sync path.
  assert.equal(GAP_KIND.VECTORS_ORPHANED, "vectors_orphaned");
});

test("scene join: a fixture that constructs the link still produces no finding about it", () => {
  // Deliberately the old fixture shape — record scene_names that do and do not
  // match filenames — as the regression probe. Nothing may be said about it.
  const scenes = [scene("scene-0", { heat: 5, summary: "s" }), scene("scene-1", { heat: 4, summary: "s" })];
  const records = [rec("m_1", { scene_name: "scene-0" }), rec("m_2", { scene_name: "no-such-scene" })];
  const snap = T.transformRoot(rootExtract([storeExtract("global", { records, scenes })]));

  const s = snap.stores[0];
  assert.deepEqual(
    Object.keys(s.scenes).sort(),
    ["count", "heatBuckets", "heatValues", "navBudgetChars", "navUsedChars", "navStatus", "navReason",
      "invisibleInNav", "staleHot", "visibleInNav"].sort(),
    "SceneStats grew or lost a field — if it is a scene_name join, it is not measurable",
  );
  for (const g of snap.gaps) {
    assert.equal(/scene_name|orphan|dangl/.test(JSON.stringify(g)), false, `${g.kind} still talks about the scene_name join`);
  }
  // The record-side column is still carried through to the row view untouched —
  // it is displayable free text, just not a foreign key.
  assert.deepEqual(T.buildRecordRows(storeExtract("s", { records })).map((r) => r.scene), ["scene-0", "no-such-scene"]);
});

test("summariseScenes: takes a ScenesRead and options, and nothing else", () => {
  // Arity is the pin: the removed third parameter carried the record-side scene
  // names for the deleted join, and re-adding it is the first step back.
  assert.equal(T.summariseScenes.length, 2);

  const st = T.summariseScenes(C.ok({ scenes: [scene("a", { heat: 5 })] }), { now: Date.now(), navBudgetChars: 800 });
  assert.equal(st.count, 1);
  assert.equal("orphanScenes" in st, false);
  assert.equal("danglingSceneNames" in st, false);
});

test("scenes: stale hot is heat >= 4 that the file's own mtime refutes", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  const fresh = scene("fresh", { heat: 5, updated: "2026-05-30T00:00:00Z" });
  const stale = scene("stale", { heat: 5, updated: "2025-06-01T00:00:00Z" });
  const coldOld = scene("cold-old", { heat: 2, updated: "2020-01-01T00:00:00Z" });

  const st = T.summariseScenes(C.ok({ scenes: [fresh, stale, coldOld] }), { now, navBudgetChars: 800 });
  assert.equal(st.staleHot, 1);
  assert.equal(STALE_HOT.MIN_HEAT, 4);
  assert.equal(STALE_HOT.MAX_AGE_DAYS, 90);

  // An unmeasured scene read produces no scene stats at all — not zeroed ones.
  assert.equal(T.summariseScenes(C.unmeasured("scene_blocks/ not present", { scenes: null }), { now, navBudgetChars: 800 }), null);
});

// ───────────────────────────────────────────────────────────────────────────
// Duplicates + quantiles
// ───────────────────────────────────────────────────────────────────────────

test("duplicateGroups: counts non-first members, and blanks never form a group", () => {
  const records = [
    rec("m_1", { content: "same thing" }),
    rec("m_2", { content: "same thing" }),
    rec("m_3", { content: "  same thing  " }),
    rec("m_4", { content: "Same Thing." }),
    rec("m_5", { content: "unique" }),
    rec("m_6", { content: "" }),
    rec("m_7", { content: "   " }),
  ];

  const exact = T.duplicateGroups(records, T.exactKey);
  assert.equal(exact.groups, 1);
  assert.equal(exact.records, 2); // 3 members, 2 deletable

  const norm = T.duplicateGroups(records, T.normalisedKey);
  assert.equal(norm.groups, 1);
  assert.equal(norm.records, 3); // "Same Thing." folds in

  // Blank content is an `empty` low-signal finding; letting every blank collapse
  // into one giant duplicate group would double-count it as a louder second one.
  assert.equal(exact.groupIndexById.has("m_6"), false);
  assert.equal(exact.groupIndexById.has("m_7"), false);
});

test("normalisedKey / exactKey: the gap between the tiers is the finding", () => {
  assert.equal(T.exactKey("  hello  "), "hello");
  assert.equal(T.exactKey(null), "");
  assert.equal(T.normalisedKey("Hello   World!!"), "hello world");
  assert.equal(T.normalisedKey("hello world"), T.normalisedKey("HELLO\n\tWORLD..."));
  assert.notEqual(T.exactKey("Hello world"), T.exactKey("hello world"));
});

test("quantiles: nearest-rank, no interpolation — every value names a real record", () => {
  const q = T.quantiles([10, 20, 30, 40]);
  assert.equal(q.n, 4);
  assert.equal(q.min, 10);
  assert.equal(q.max, 40);
  assert.equal(q.p50, 20);
  assert.equal(q.mean, 25);
  for (const k of ["min", "p50", "p75", "p90", "p95", "p99", "max"]) {
    assert.ok([10, 20, 30, 40].includes(q[k]), `${k} = ${q[k]} names no real record`);
  }
  assert.deepEqual(T.quantiles([]), { min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0, n: 0 });
});

// ───────────────────────────────────────────────────────────────────────────
// Gaps
// ───────────────────────────────────────────────────────────────────────────

test("gap(): an unmeasured finding can never be critical", () => {
  assert.throws(
    () => C.gap({ kind: GAP_KIND.VECTORS_UNMEASURABLE, severity: SEVERITY.CRITICAL, unmeasured: true, subject: { slug: "x" }, title: "t" }),
    /unmeasured and cannot be critical/,
  );
  assert.throws(() => C.gap({ kind: "not_a_kind", severity: SEVERITY.WARN, subject: { slug: "x" }, title: "t" }), /unknown kind/);
  assert.throws(() => C.gap({ kind: GAP_KIND.VECTORS_MISSING, severity: "fatal", subject: { slug: "x" }, title: "t" }), /unknown severity/);

  // Same finding, honestly ranked, is fine — and the id is stable across refreshes.
  const g = C.gap({ kind: GAP_KIND.VECTORS_UNMEASURABLE, severity: SEVERITY.WARN, unmeasured: true, subject: { scope: "project", slug: "p1", id: null, label: "p1" }, title: "t" });
  assert.equal(g.id, "vectors_unmeasurable:p1");
});

test("gaps: no emitted gap violates the unmeasured/critical guard, and ordering puts knowledge first", () => {
  const snap = T.transformRoot(rootExtract([
    storeExtract("global", { records: [rec("m_1"), rec("m_2")], vectors: [], scenes: [scene("a", { heat: 5 })] }),
    storeExtract("unmeasurable", { records: [rec("m_3")] }),
    storeExtract("broken", { recordsStatus: STATUS.ERROR }),
    storeExtract("dupes", { records: [rec("m_4", { content: "dup" }), rec("m_5", { content: "dup" })], vectors: ["m_4", "m_5"] }),
  ]), { persona: personaRead() });

  assert.ok(snap.gaps.length > 0);
  const rank = { critical: 3, warn: 2, info: 1 };
  let prev = null;
  for (const g of snap.gaps) {
    assert.ok(C.GAP_KINDS.includes(g.kind));
    assert.ok(C.SEVERITIES.includes(g.severity));
    assert.equal(typeof g.unmeasured, "boolean");
    assert.equal(g.unmeasured && g.severity === SEVERITY.CRITICAL, false, `${g.kind} is unmeasured AND critical`);
    assert.equal(g.id, `${g.kind}:${g.subject.id || g.subject.slug || g.subject.scope || "root"}`);
    assert.equal(typeof g.title, "string");
    // Evidence leaves stay numeric-or-string so the UI renders a table, no special cases.
    for (const [k, v] of Object.entries(g.evidence)) {
      assert.ok(["number", "string", "boolean"].includes(typeof v) || v === null, `evidence.${k} is a ${typeof v}`);
    }
    if (prev) {
      // measured before unmeasured, then severity descending
      assert.ok(Number(prev.unmeasured) <= Number(g.unmeasured));
      if (prev.unmeasured === g.unmeasured) assert.ok(rank[prev.severity] >= rank[g.severity]);
    }
    prev = g;
  }

  const kinds = gapKinds(snap);
  assert.ok(kinds.includes(GAP_KIND.STORE_UNREADABLE));
  assert.ok(kinds.includes(GAP_KIND.VECTORS_UNMEASURABLE));
  assert.ok(kinds.includes(GAP_KIND.VECTORS_MISSING));
  assert.ok(kinds.includes(GAP_KIND.DUPLICATE_RECORDS));

  // The unmeasurable store is reported as an absence of knowledge...
  const un = snap.gaps.find((g) => g.kind === GAP_KIND.VECTORS_UNMEASURABLE);
  assert.equal(un.unmeasured, true);
  assert.equal(un.severity, SEVERITY.WARN);
  // ...and is excluded from the defect count.
  assert.equal(snap.totals.unmeasuredGaps >= 1, true);
  const measuredGaps = snap.gaps.filter((g) => !g.unmeasured).length;
  assert.equal(Object.values(snap.totals.gapsBySeverity).reduce((a, b) => a + b, 0), measuredGaps);
});

test("gaps: an installed-but-empty l1_vec outranks a partially synced one", () => {
  const empty = T.transformRoot(rootExtract([storeExtract("s", { records: [rec("m_1")], vectors: [] })]));
  const partial = T.transformRoot(rootExtract([storeExtract("s", { records: [rec("m_1"), rec("m_2"), rec("m_3")], vectors: ["m_1"] })]));

  const eg = empty.gaps.find((g) => g.kind === GAP_KIND.VECTORS_MISSING);
  assert.equal(eg.severity, SEVERITY.CRITICAL);
  assert.equal(eg.unmeasured, false); // it is MEASURED — that is why it may be critical
  assert.equal(eg.evidence.vectorState, "empty");
  assert.match(eg.title, /present and empty/);

  const pg = partial.gaps.find((g) => g.kind === GAP_KIND.VECTORS_MISSING);
  assert.equal(pg.severity, SEVERITY.WARN);
  assert.equal(pg.evidence.vectorState, "populated");
});

test("gaps: an unmeasurable store with zero records produces no gap at all", () => {
  const snap = T.transformRoot(rootExtract([storeExtract("empty-store", { records: [] })]));
  assert.equal(gapKinds(snap).includes(GAP_KIND.VECTORS_UNMEASURABLE), false);
});

test("gaps: orphan vectors are counted from the row count, never negative", () => {
  const snap = T.transformRoot(rootExtract([
    storeExtract("s", { records: [rec("m_1")], vectors: ["m_1"], vectorRows: 7 }),
  ]));
  const s = snap.stores[0];
  assert.equal(s.vectors.orphanVectors, 6);
  assert.equal(s.vectors.vectorRows, 7);
  const g = snap.gaps.find((x) => x.kind === GAP_KIND.VECTORS_ORPHANED);
  assert.equal(g.severity, SEVERITY.INFO);
});

test("gaps: capture backlog fires only against a known threshold", () => {
  const behind = T.transformRoot(rootExtract([storeExtract("s", { records: [rec("m_1")] })], {
    captureState: C.ok({ turnCount: 100, lastConsolidationTurn: 40, sessions: {} }),
    config: C.ok({ config: {}, consolidateEvery: 20, sceneNavBudgetTokens: 200 }),
  }));
  const g = behind.gaps.find((x) => x.kind === GAP_KIND.CAPTURE_BACKLOG);
  assert.ok(g);
  assert.equal(g.evidence.behind, 60);
  assert.equal(g.severity, SEVERITY.WARN); // >= 2x the threshold

  // Unreadable capture state cannot produce a backlog number out of thin air.
  const unknown = T.transformRoot(rootExtract([storeExtract("s", { records: [rec("m_1")] })], {
    captureState: C.unmeasured("capture_state.json not present", { turnCount: null, lastConsolidationTurn: null, sessions: null }),
  }));
  assert.equal(gapKinds(unknown).includes(GAP_KIND.CAPTURE_BACKLOG), false);
});

test("gaps: a corrupt root document is reported, an absent one is not a defect", () => {
  const broken = T.transformRoot(rootExtract([storeExtract("s", { records: [] })], {
    state: C.errored("state.json unreadable (/fixture/state.json): bad json", { sessions: null, projects: null, pendingSessions: null, recallDisabledSlugs: null }),
  }));
  const g = broken.gaps.find((x) => x.kind === GAP_KIND.CONFIG_UNREADABLE);
  assert.ok(g);
  assert.equal(g.subject.id, "state.json");

  const absent = T.transformRoot(rootExtract([storeExtract("s", { records: [] })]));
  assert.equal(gapKinds(absent).includes(GAP_KIND.CONFIG_UNREADABLE), false);
});

test("gaps: a missing persona is unmeasured, an unprojected one is a defect", () => {
  const none = T.transformRoot(rootExtract([storeExtract("s", { records: [] })]));
  const pm = none.gaps.find((g) => g.kind === GAP_KIND.PERSONA_MISSING);
  assert.ok(pm);
  assert.equal(pm.unmeasured, true);
  assert.notEqual(pm.severity, SEVERITY.CRITICAL);
  assert.equal(none.persona.status, STATUS.UNMEASURED);
  assert.equal(none.persona.projection, null);

  const withPersona = T.transformRoot(rootExtract([storeExtract("s", { records: [] })], { persona: personaRead() }));
  assert.equal(withPersona.persona.status, STATUS.OK);
  assert.equal(gapKinds(withPersona).includes(GAP_KIND.PERSONA_MISSING), false);
  const proj = withPersona.persona.projection;
  assert.equal(proj.totalBullets, withPersona.persona.bullets.length);
  assert.equal(Object.values(proj.byTier).reduce((a, b) => a + b, 0), proj.totalBullets);
  for (const b of withPersona.persona.bullets) {
    assert.ok(C.INJECTION_TIERS.includes(b.tier));
    assert.ok(C.DUTY_CLASSES.includes(b.duty));
    assert.ok(b.tierReason.length > 0, "a projection verdict must be auditable");
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Snapshot identity + whole-snapshot shape
// ───────────────────────────────────────────────────────────────────────────

test("computeSnapshotId: stable for equal state, sensitive to the changes that matter", () => {
  const base = () => [
    { slug: "global", status: STATUS.OK, records: 10, newestRecordAt: "2026-01-01T00:00:00Z", scenes: { count: 3 } },
    { slug: "p1", status: STATUS.OK, records: 4, newestRecordAt: "2026-01-02T00:00:00Z", scenes: { count: 1 } },
  ];
  const persona = { status: STATUS.OK, bytes: 100, mtime: "2026-01-01T00:00:00Z" };

  const id = T.computeSnapshotId(base(), persona);
  assert.ok(C.isSnapshotId(id), `${id} is not a well-formed snapshot id`);
  assert.equal(T.computeSnapshotId(base(), persona), id);
  // Discovery order is filesystem-dependent; the id must not be.
  assert.equal(T.computeSnapshotId(base().reverse(), persona), id);

  const moreRecords = base(); moreRecords[0].records = 11;
  assert.notEqual(T.computeSnapshotId(moreRecords, persona), id);

  const newerRecord = base(); newerRecord[0].newestRecordAt = "2026-01-03T00:00:00Z";
  assert.notEqual(T.computeSnapshotId(newerRecord, persona), id);

  const moreScenes = base(); moreScenes[1].scenes = { count: 2 };
  assert.notEqual(T.computeSnapshotId(moreScenes, persona), id);

  // An unreadable store becoming readable IS a state change.
  const broke = base(); broke[1] = { slug: "p1", status: STATUS.ERROR };
  assert.notEqual(T.computeSnapshotId(broke, persona), id);

  assert.notEqual(T.computeSnapshotId(base(), { status: STATUS.OK, bytes: 101, mtime: persona.mtime }), id);
  assert.notEqual(T.computeSnapshotId(base(), C.unmeasured("no persona", {})), id);
});

test("transformRoot: a synthetic root yields a Snapshot whose every Source and Coverage validates", () => {
  const snap = T.transformRoot(rootExtract([
    storeExtract("global", {
      records: [rec("m_1"), rec("ac_2"), rec("legacy_3", { type: "weird-type" })],
      vectors: ["m_1"],
      scenes: [scene("alpha", { heat: 5 }), scene("beta", { heat: 2 })],
      vectorDbBytes: 8192,
    }),
    storeExtract("p-never-setup", { records: [rec("ac_9")], scenes: [scene("gamma", { heat: 4 })] }),
    storeExtract("p-empty-vec", { records: [rec("m_8")], vectors: [] }),
    storeExtract("p-errored", { recordsStatus: STATUS.ERROR }),
    storeExtract("p-vec-error", { records: [rec("m_7")], vectors: "error" }),
  ]), { persona: personaRead(), now: Date.parse("2026-06-01T00:00:00Z"), extractMs: 12 });

  assert.equal(snap.schemaVersion, C.SCHEMA_VERSION);
  assert.ok(C.isSnapshotId(snap.snapshotId));
  assert.equal(snap.generatedAt, "2026-06-01T00:00:00.000Z");
  assert.equal(snap.rootDir, "/fixture");
  assert.equal(snap.timing.extractMs, 12);
  assert.ok(snap.timing.transformMs >= 0);

  for (const [metric, cov] of Object.entries(snap.totals.coverage)) C.validateCoverage(cov, `coverage.${metric}`);
  for (const k of ["state", "config", "captureState"]) C.validateSource(snap.health[k], `health.${k}`);
  C.validateSource(snap.persona, "persona");

  for (const s of snap.stores) {
    C.validateSource(s, `store ${s.slug}`);
    C.validateSource(s.vectors, `store ${s.slug}.vectors`);
    if (s.status === STATUS.ERROR) {
      // An errored store contributes to no aggregate but must still get a row.
      assert.equal(s.records, null);
      assert.equal(s.vectors.status, STATUS.UNMEASURED);
      continue;
    }
    assert.equal(typeof s.records, "number");
    assert.deepEqual(Object.keys(s.byType).sort(), [...RECORD_TYPES].sort());
    assert.deepEqual(Object.keys(s.byWritePath).sort(), [...WRITE_PATHS].sort());
    assert.deepEqual(Object.keys(s.lowSignal).sort(), [...LOW_SIGNAL_CLASSES].sort());
    assert.deepEqual(Object.keys(s.duplicates).sort(), [...DUPLICATE_TIERS].sort());
    assert.ok(T.VECTOR_STATES.includes(s.vectorState));
    if (s.vectors.status !== STATUS.OK) {
      for (const k of ["withVector", "withoutVector", "ratio", "orphanVectors"]) {
        assert.equal(s.vectors[k], null, `unmeasured vectors leaked a number in ${k}`);
      }
    }
  }

  // Sorted for the UI: global first, then records descending.
  assert.equal(snap.stores[0].slug, "global");
  // Unknown record types are bucketed, never dropped.
  assert.equal(snap.stores[0].byType.other, 1);
  assert.equal(snap.stores[0].byWritePath[WRITE_PATH.AUTO], 1);
  assert.equal(snap.stores[0].byWritePath[WRITE_PATH.AWAITED], 1);
  assert.equal(snap.stores[0].byWritePath[WRITE_PATH.UNKNOWN], 1);
  assert.equal(snap.totals.stores, 5);
  assert.equal(snap.totals.sizeBytes, 4096 * 5 + 8192);
});

test("transformRoot: a totally empty root does not invent numbers", () => {
  const snap = T.transformRoot(rootExtract([]));
  assert.equal(snap.totals.stores, 0);
  assert.equal(snap.totals.records, 0);
  assert.equal(snap.totals.scenes, 0);
  assert.equal(snap.totals.coverage.vectors.ratio, 0);
  assert.equal(snap.totals.coverage.vectors.partial, false);
  assert.equal(snap.totals.lowSignal.ratio, 0);
  C.validateCoverage(snap.totals.coverage.vectors);
  assert.ok(C.isSnapshotId(snap.snapshotId));
});

test("transformRoot: tolerates a malformed root rather than throwing at the HTTP layer", () => {
  for (const bad of [undefined, null, {}, { stores: [] }]) {
    const snap = T.transformRoot(bad);
    assert.equal(snap.totals.stores, 0);
    assert.ok(C.isSnapshotId(snap.snapshotId));
    C.validateSource(snap.health.config, "health.config");
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Record rows
// ───────────────────────────────────────────────────────────────────────────

test("buildRecordRows: hasVector is null — never false — when the reading was not ok", () => {
  const unmeasuredStore = storeExtract("s", { records: [rec("m_1"), rec("m_2")] });
  for (const row of T.buildRecordRows(unmeasuredStore)) {
    assert.equal(row.hasVector, null, "a store with no vector reading must not report `false`");
  }

  const measured = storeExtract("s", { records: [rec("m_1"), rec("m_2")], vectors: ["m_1"] });
  const rows = T.buildRecordRows(measured);
  assert.deepEqual(rows.map((r) => r.hasVector), [true, false]);
  assert.deepEqual(rows.map((r) => r.writePath), [WRITE_PATH.AWAITED, WRITE_PATH.AWAITED]);

  // Row labels come from the SAME classifier that produced the totals.
  const noisy = storeExtract("s", { records: [rec("ac_1", { content: "/tmem view" }), rec("ac_2", { content: "dup" }), rec("ac_3", { content: "dup" })] });
  const noisyRows = T.buildRecordRows(noisy);
  assert.deepEqual(noisyRows[0].lowSignal, ["slashOrTag"]);
  assert.equal(noisyRows[0].duplicateGroup, -1);
  assert.equal(noisyRows[1].duplicateGroup, noisyRows[2].duplicateGroup);
  assert.notEqual(noisyRows[1].duplicateGroup, -1);

  assert.deepEqual(T.buildRecordRows(storeExtract("s", { recordsStatus: STATUS.ERROR })), []);
  assert.deepEqual(T.buildRecordRows(null), []);
});
