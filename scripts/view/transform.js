#!/usr/bin/env node
/**
 * `tmem view` — transform layer. All arithmetic, no I/O.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Three reasons, in descending order of how much trouble they have already caused.
 *
 * 1. PURITY IS THE TESTABILITY. Not a single `fs`, `node:sqlite` or network call
 *    lives here — the only input is {@link module:extract.extractAll}'s output and
 *    the only output is contract shapes. That is what lets the whole metric surface
 *    be pinned against a fixture instead of against whatever the author's laptop
 *    happened to contain, and what lets the browser lens reuse the exact numbers
 *    the CLI prints rather than a second implementation of them. `StoreRef` carries
 *    `indexDbBytes`/`vectorDbBytes` precisely so `sizeBytes` does not need a stat.
 *    If you find yourself opening a file in this module, you are in extract.js.
 *
 * 2. AN AVERAGE IS A PLACE MEASUREMENT DIES. The audit that produced this feature
 *    computed embedding coverage as total-vectors / total-records over all 49
 *    stores and got 36%. That number silently counted 24 stores that have no
 *    `vectors.db` at all as 0% coverage. The honest reading — 1977/5257 across the
 *    25 stores whose vector capability could actually be exercised, with 24 stores
 *    holding 238 records excluded and *named* — is a different number about a
 *    different world. Every ratio in this file is therefore a
 *    {@link module:contract.Coverage} built by `makeCoverage()`, which structurally
 *    refuses to put an unmeasured store in a denominator.
 *
 * 3. THERE ARE THREE VECTOR STATES, AND THE MIDDLE ONE IS THE FINDING. Splitting
 *    stores into "has vectors" / "doesn't" hides the population that matters:
 *    21 stores have a present, loadable, and completely EMPTY `l1_vec`. That is a
 *    measured zero, not an unmeasured absence — the machinery is installed, every
 *    file-exists health check passes, and the store has quietly been on FTS-only
 *    recall since the day it was created. Only 4 stores carry embeddings. So this
 *    module emits {@link VECTOR_STATE} alongside the coverage, letting the lens say
 *    "24 never set up · 21 set up and empty · 4 working" instead of one blended
 *    percentage that describes none of them.
 *
 * WHAT A GAP IS FOR
 * -----------------
 * The failure this whole feature exists to prevent is a dashboard reading
 * "5,496 records · 219 scenes" while the agent receives three lines per turn — a
 * screen that would win an argument it should lose. Totals without gaps are that
 * screen. So every shortfall that can be computed from the extract lands in
 * `gaps[]` next to the total it undermines: records with no embedding, vector
 * tables that exist and are empty, scenes written but never inside the nav budget
 * (orchard-api surfaces 5 of its 75), duplicates, the low-signal share.
 * `gap()` refuses to let an unmeasured finding be marked critical; that guard is
 * deliberate and is not worked around anywhere below.
 *
 * TWO SCALES THAT DISAGREED — NOW ONE, STILL MEASURED
 * ---------------------------------------------------
 * `scene_nav.heatEmoji()` used to start rendering flames at heat >= 50 while the
 * `memory-consolidate` skill writes heat on a 1-5 scale, and all 216 scenes obeyed
 * it ({2:9, 3:30, 4:50, 5:127}), so the ladder had never rendered once. R2 moved
 * the ladder onto the written scale (first flame at 4, "active this week").
 *
 * The measurement stays. We do not assume the two agree: {@link readerHeatEmoji}
 * is still the reader's REAL function, not an idealised copy — nav visibility
 * depends on rendered line length, so a copy would compute the wrong answer — and
 * {@link GAP_KIND.HEAT_SCALE_MISMATCH} still fires whenever a store's whole heat
 * population sits below the first rung, or above the documented scale. What
 * changed is that the real store no longer trips it.
 */
"use strict";

const crypto = require("node:crypto");

const C = require("./contract.js");
const {
  STATUS, SCOPE, RECORD_TYPES, RECORD_TYPE_OTHER,
  WRITE_PATH, WRITE_PATHS, writePathForRecordId,
  LOW_SIGNAL_CLASSES, LOW_SIGNAL_UNION_CLASSES, LOW_SIGNAL_BASELINE,
  validateLowSignalUnion,
  DUPLICATE_TIERS, HEAT_BUCKETS, HEAT_SCALE, STALE_HOT,
  DUTY_CLASSES, INJECTION_TIERS,
  GAP_KIND, SEVERITY, gap,
  makeCoverage, zeroMap, unmeasuredVectors, storeSizeBytes,
  SCHEMA_VERSION, SNAPSHOT_ID_SPEC,
} = C;

// persona_projection is pure (parsing + classification + budget arithmetic, no
// I/O), and it is the SAME code the runtime injector runs. Reimplementing the
// projection here would let the lens draw a picture the agent never sees.
const {
  parsePersona, annotate, projectTier0, projectTier1, legacyProjection,
  DEFAULT_TIER0_MAX_CHARS, DEFAULT_TIER1_MAX_CHARS, LEGACY_MAX_LINES,
} = require("../persona_projection.js");

// scene_nav.js is the `<scene-navigation>` renderer memory_recall.js injects with,
// and it requires NOTHING — no fs, no sqlite — which is what lets the pure view
// import it. Before it existed, the fill loop, the emoji ladder, the 80-char
// summary cut and the header/footer literals were hand-copied here, with nothing
// forcing the copy to keep step with the block the agent actually receives.
const {
  renderSceneNav, byHeatDesc, NAV, heatEmoji: navHeatEmoji, CHARS_PER_TOKEN: NAV_CHARS_PER_TOKEN,
} = require("../scene_nav.js");

// doctor.js is pure (its persona-budget / secret / atom-count nudge rules require
// only persona_projection.js and redact.js, both leaves, and only lazily). The
// lens imports the SAME function `tmem doctor` prints so the two can never disagree
// about when a store should be re-consolidated — never a metric defined twice.
const { buildUpgradeNudges } = require("../doctor.js");

/* ------------------------------------------------------------------ *
 * 1. Vector state — the three-way split
 * ------------------------------------------------------------------ */

/**
 * What we know about a store's embeddings. Deliberately NOT the same axis as
 * {@link STATUS}: status answers "did the read succeed", this answers "what did
 * the read find", and collapsing the two is how 21 empty tables disappeared into
 * a coverage average.
 *
 * - `unmeasured` — no `vectors.db`, or sqlite-vec could not be exercised. Coverage
 *                  for these stores is unknown, not zero. 24 stores.
 * - `empty`      — `l1_vec` is present, loadable, and holds zero rows. A MEASURED
 *                  zero: recall is FTS-only and always has been, yet every
 *                  file-exists health check passes. 21 stores.
 * - `populated`  — embeddings exist. 4 stores.
 *
 * `empty` deliberately does NOT require the store to hold records. Three of the
 * 21 are empty on both sides, and demoting them to a fourth "nothing to embed"
 * state would split the population the finding is about — the machinery is
 * installed and has written nothing, which is the same sentence either way. What
 * separates them is whether anything is *harmed*, and that is the gap's job, not
 * the state's: `VECTORS_MISSING` only fires where records exist, so the 21 empty
 * stores produce 18 findings. Read `vectorStateRecords` for the population at risk.
 */
const VECTOR_STATE = Object.freeze({
  UNMEASURED: "unmeasured",
  EMPTY: "empty",
  POPULATED: "populated",
});

const VECTOR_STATES = Object.freeze(Object.values(VECTOR_STATE));

/**
 * @param {import("./contract.js").VectorIdsRead} vectors
 * @returns {string} one of {@link VECTOR_STATE}
 */
function vectorStateFor(vectors) {
  if (!vectors || vectors.status !== STATUS.OK) return VECTOR_STATE.UNMEASURED;
  return (vectors.count || 0) > 0 ? VECTOR_STATE.POPULATED : VECTOR_STATE.EMPTY;
}

/* ------------------------------------------------------------------ *
 * 2. Low-signal classification
 * ------------------------------------------------------------------ */

/**
 * The classifier is IMPORTED, not defined here.
 *
 * It used to live in this file, and `memory_auto_capture.js`'s write-side noise
 * gate could not reuse it: requiring transform.js drags in persona_projection,
 * scene_nav and the load-time ladder assertion below, which THROWS when the heat
 * ladder and the contract disagree — a lens invariant able to take the capture
 * path down with it. So the predicates moved to `low_signal.js` (pure, requires
 * only contract.js) and both sides import them. That is the whole point: the
 * dashboard must never name a class of junk the writer silently keeps admitting,
 * and the writer must never drop a record the lens never counted.
 *
 * `low_signal.js` is safe for a module whose contract is "no I/O": its only
 * require is `./view/contract.js`, which requires nothing at all.
 *
 * Re-exported below so existing consumers (and `buildRecordRows`) keep reading
 * one definition rather than acquiring a second one.
 */
const { classifyLowSignal } = require("../low_signal.js");
// From constants.js, the leaf that requires nothing — NOT from memory_store.js,
// which loads node:sqlite and would break this module's no-I/O purity tests.
const { isVectorEligible } = require("../constants.js");

/** True when any matched class is in the pinned union set. */
function isLowSignalUnion(classes) {
  for (const c of classes) if (LOW_SIGNAL_UNION_CLASSES.includes(c)) return true;
  return false;
}

/**
 * Compare a computed union ratio against the pinned audit baseline WITHOUT
 * throwing.
 *
 * {@link validateLowSignalUnion} throws by design — it is a guard for a code
 * change that redefines the metric. But this module also runs inside a live HTTP
 * server, and a store that legitimately drifts past the tolerance must produce a
 * visible finding, not a 500. So the throw is caught and turned into a datum the
 * UI can render. The verdict is never used to retune the classifier: drift is the
 * signal, not the bug.
 *
 * `comparable: false` is the case where the ratio is honest but the VERDICT is
 * not: the pin was measured over a whole corpus, so a ratio computed from a
 * truncated read compares two different populations. The delta then measures the
 * cap, not the classifier, and a "FAIL — drifted 31pp" would send the next reader
 * hunting a regression that does not exist. The drift verdict is unmeasurable in
 * that state, so it is refused rather than approximated; `withinTolerance` stays
 * `false`, because a pass you did not measure must never be claimed.
 *
 * @param {number} ratio
 * @param {{comparable?: boolean, why?: string}} [opts]
 * @returns {{withinTolerance: boolean, comparable: boolean, observed: number,
 *            pinned: number, deltaPoints: number, tolerancePoints: number,
 *            message: string|null}}
 */
function checkLowSignalBaseline(ratio, { comparable = true, why = "" } = {}) {
  const base = {
    observed: ratio,
    pinned: LOW_SIGNAL_BASELINE.ratio,
    deltaPoints: (ratio - LOW_SIGNAL_BASELINE.ratio) * 100,
    tolerancePoints: LOW_SIGNAL_BASELINE.TOLERANCE * 100,
    baselineRecords: LOW_SIGNAL_BASELINE.records,
    baselineUnionRecords: LOW_SIGNAL_BASELINE.unionRecords,
  };
  if (!comparable) {
    return {
      ...base,
      comparable: false,
      withinTolerance: false,
      message: `not comparable to the pinned baseline: ${why} — ` +
        "the pin was measured over the whole corpus, so this delta is a population " +
        "difference, not classifier drift",
    };
  }
  try {
    validateLowSignalUnion([...LOW_SIGNAL_UNION_CLASSES], ratio);
    return { ...base, comparable: true, withinTolerance: true, message: null };
  } catch (e) {
    return { ...base, comparable: true, withinTolerance: false, message: e.message };
  }
}

/* ------------------------------------------------------------------ *
 * 3. Duplicates
 * ------------------------------------------------------------------ */

/** `exact` tier key: trimmed content, verbatim. */
function exactKey(content) {
  return String(content == null ? "" : content).trim();
}

/** Pure-ASCII strings are their own NFKC normal form, so skipping the normalise
 *  pass for them is an identity, not an approximation. Worth the guard because
 *  this key is built for every record in every store and most of them are ASCII;
 *  measured in isolation the pass costs ~32 ms of a ~40 ms transform, though in
 *  situ V8 hides most of that — verified to leave the duplicate counts unchanged. */
const ASCII_ONLY_RE = /^[\x00-\x7F]*$/;
const nfkc = (s) => (ASCII_ONLY_RE.test(s) ? s : s.normalize("NFKC"));

/** `normalised` tier key: NFKC, lowercased, whitespace collapsed, trailing punctuation dropped. */
function normalisedKey(content) {
  return nfkc(String(content == null ? "" : content))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?…\-–—*_`"')\]}]+$/u, "")
    .trim();
}

/**
 * Group records by content and report the non-first members.
 *
 * "Non-first member" rather than "group size" because that is the count of
 * records that could be deleted without losing content — the number a cleanup is
 * measured against. Blank keys are excluded: an empty record is an `empty`
 * low-signal finding, and letting every blank collapse into one giant duplicate
 * group would double-count it as a second, louder one.
 *
 * @param {import("./contract.js").L1Record[]} records
 * @param {(s: string) => string} keyFn
 * @returns {{records: number, groups: number, groupIndexById: Map<string, number>}}
 */
function duplicateGroups(records, keyFn) {
  const byKey = new Map();
  for (const r of records) {
    const k = keyFn(r.content);
    if (!k) continue;
    const bucket = byKey.get(k);
    if (bucket) bucket.push(r.record_id);
    else byKey.set(k, [r.record_id]);
  }

  const groupIndexById = new Map();
  let groups = 0;
  let dupRecords = 0;
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue;
    const index = groups++;
    dupRecords += ids.length - 1;
    for (const id of ids) groupIndexById.set(id, index);
  }
  return { records: dupRecords, groups, groupIndexById };
}

/* ------------------------------------------------------------------ *
 * 4. Quantiles
 * ------------------------------------------------------------------ */

/**
 * Nearest-rank quantiles over an unsorted numeric array. No interpolation: these
 * are character counts of real records, and reporting a p90 of 411.5 chars would
 * name a record that does not exist.
 *
 * @param {number[]} values
 * @returns {import("./contract.js").Quantiles}
 */
function quantiles(values) {
  const n = values.length;
  if (!n) return { min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0, n: 0 };
  const s = values.slice().sort((a, b) => a - b);
  const at = (q) => s[Math.floor((n - 1) * q)];
  let sum = 0;
  for (const v of s) sum += v;
  return {
    min: s[0],
    p50: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: s[n - 1],
    mean: Math.round((sum / n) * 10) / 10,
    n,
  };
}

/* ------------------------------------------------------------------ *
 * 5. Heat + scene navigation
 * ------------------------------------------------------------------ */

/** Bucket key for a heat value, per {@link HEAT_BUCKETS}. */
function heatBucketKey(heat) {
  const h = Number.isFinite(heat) ? heat : 0;
  for (const b of HEAT_BUCKETS) if (h >= b.min && h <= b.max) return b.key;
  return HEAT_BUCKETS[HEAT_BUCKETS.length - 1].key;
}

/**
 * The reader's emoji ladder — now the runtime's own, not a copy of it.
 *
 * This used to be a hand mirror of `memory_recall.heatEmoji()`, because importing
 * memory_recall would drag MemoryStore, VectorStore and the config loader — file
 * and database access — into a module whose whole contract is that it does none.
 * The renderer has since moved to `scene_nav.js`, which requires nothing at all,
 * so the real function is reachable without giving that up. It matters because
 * this is not decoration: the emoji decide the rendered LINE LENGTH the nav budget
 * is spent on, so a mirror that drifted would change how many scenes we report as
 * visible without changing what the agent sees. That is now load-bearing in a way
 * it was not before: since R2 the ladder actually fires on 82% of scenes, so its
 * chars come out of the nav budget and change `visibleInNav`.
 */
const readerHeatEmoji = navHeatEmoji;

/**
 * The contract's `READER_FIRST_FLAME_AT` states where the ladder starts, and the
 * "no scene ever rendered a cue" gap is built on it. It is declared separately
 * from the ladder on purpose (contract §HEAT_SCALE), which leaves exactly one way
 * for the two to disagree — so the disagreement is checked here, at load, rather
 * than discovered as a gap that quietly stopped firing.
 */
(function assertLadderMatchesContract() {
  const at = HEAT_SCALE.READER_FIRST_FLAME_AT;
  if (readerHeatEmoji(at) === "" || readerHeatEmoji(at - 1) !== "") {
    throw new Error(
      `transform.js: HEAT_SCALE.READER_FIRST_FLAME_AT (${at}) no longer matches ` +
      "scene_nav.heatEmoji()'s first rung — the heat-cue finding is measuring a threshold nobody renders",
    );
  }
}());

/** The token→char factor every budget in the runtime uses (scene_nav.js,
 *  on_session_start.js). Shared by the scene-nav and persona budgets below so a
 *  token knob converts to chars identically wherever it is read. */
const CHARS_PER_TOKEN = NAV_CHARS_PER_TOKEN;

/** Nav literals, re-exported from the shared renderer rather than restated, plus
 *  the view's own default budget (the value `getSceneMaxTokens()` falls back to,
 *  needed here because transform never reads config itself). */
const SCENE_NAV = Object.freeze({
  CHARS_PER_TOKEN,
  HEADER: NAV.HEADER,
  FOOTER: NAV.FOOTER,
  GUIDE: NAV.GUIDE,
  SUMMARY_MAX_CHARS: NAV.SUMMARY_MAX_CHARS,
  DEFAULT_BUDGET_TOKENS: 200,
});

/**
 * How many of a store's scenes actually fit inside the scene-navigation block
 * that `memory_recall.buildSceneNav()` renders for THAT store's project.
 *
 * ONE NAV BLOCK PER PROJECT — WHICH IS WHAT THIS COUNTS. `buildSceneNav()` is
 * called with the active project's hash and renders that project's scenes,
 * followed by the global store's, into ONE budget. So there is no such thing as
 * a corpus-wide "how many of the 219 scenes are visible": the 219 live in 19
 * different projects, each with its own block, and no session ever renders more
 * than one of them. Summing per-store counts (what
 * `totals.scenesReachableInSomeNav` does) answers "across every project, how many
 * written scenes are reachable at all"; it is NOT the size of any single block,
 * which is ~5 lines at the default 800-char budget because a rendered line runs
 * ~130 chars (a real summary averages 164 and the renderer cuts it to
 * {@link NAV.SUMMARY_MAX_CHARS}).
 * Reading the sum as one block's contents is how "78 of 219 visible" and "5 of
 * 219 visible" get mistaken for the same measurement.
 *
 * It does not *replay* `buildSceneNav()`: it RUNS the same renderer
 * (`scene_nav.renderSceneNav`) over the same ordering, so "the agent can see five
 * of them" is measured by the code that decides it rather than by a second
 * estimate. The ordering is heat-descending, which is `buildSceneNav`'s own
 * fallback order — the runtime then applies `rankScenes(…, query)`, and an EMPTY
 * query is documented to be an exact no-op, so the unranked order this reproduces
 * is the one a query-less turn renders. The lens has no query, and inventing one
 * would make the count a function of a prompt nobody typed.
 *
 * The fill BREAKS on the first overflowing line rather than skipping it, so one
 * long line hides every scene behind it. That behaviour lives in the renderer;
 * changing it is one edit, not two.
 *
 * THE `global` STORE IS NOT MEASURABLE STANDALONE, and says so rather than
 * reporting a number. Global scenes render AFTER the active project's, so how
 * many of them appear depends on which project you are in — it is a different
 * answer per project (usually zero, because a project with five scenes already
 * fills the budget), and there is no "the" answer to publish. Computed as if
 * global rendered alone, it was an upper bound that the docstring admitted and
 * the payload did not; the contract has a status vocabulary for exactly this, so
 * it now returns `unmeasured` with the reason instead of a plausible zero-shaped
 * number. Every project store's figure remains exact — project scenes go first,
 * so nothing competes with them.
 *
 * @param {import("./contract.js").SceneFile[]} scenes
 * @param {number|null} budgetChars null/0 => nav disabled, nothing is visible
 * @param {{scope?: string}} [opts] {@link SCOPE} of the owning store. Defaults to
 *   `project` — the case that IS measurable — so a caller with no StoreRef in hand
 *   gets the exact figure rather than an unmeasured one it did not ask for. This
 *   is the only place that default is declared; `summariseScenes` forwards
 *   whatever it was given, including `undefined`.
 * @returns {{status: string, reason: string|null, visible: number|null,
 *            invisible: number|null, usedChars: number|null, budgetChars: number|null}}
 */
function sceneNavVisibility(scenes, budgetChars, { scope = SCOPE.PROJECT } = {}) {
  const list = scenes || [];
  if (!budgetChars || budgetChars <= 0) {
    // A disabled nav is a MEASURED zero, global or not: nothing renders for anyone.
    return {
      status: STATUS.OK, reason: null,
      visible: 0, invisible: list.length, usedChars: 0, budgetChars: budgetChars ?? null,
    };
  }

  if (scope === SCOPE.GLOBAL && list.length > 0) {
    return {
      status: STATUS.UNMEASURED,
      reason: "global scenes render after the active project's in a shared " +
        `${budgetChars}-char nav block, so their visibility differs per project — ` +
        "there is no standalone count",
      visible: null, invisible: null, usedChars: null, budgetChars,
    };
  }

  // The same ordering function buildSceneNav hands to rankScenes — not a second
  // spelling of it. rankScenes is an exact no-op for an empty query, so this
  // order IS the rendered order, and a count taken over a differently-sorted list
  // would be a count of a block nobody sees.
  const ordered = byHeatDesc(list);
  // The SceneFile shape is already the renderer's normalised shape (`name` with no
  // `.md`), so this hands over the fields explicitly rather than the whole record:
  // the core must not start depending on anything only the view happens to carry.
  const rendered = renderSceneNav(
    ordered.map((s) => ({ name: s.name, heat: s.heat, summary: s.summary })),
    budgetChars,
  );

  return {
    status: STATUS.OK,
    reason: null,
    visible: rendered.visibleCount,
    invisible: list.length - rendered.visibleCount,
    usedChars: rendered.usedChars,
    budgetChars,
  };
}

const MS_PER_DAY = 86400000;

function ageDays(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (now - t) / MS_PER_DAY;
}

/* ------------------------------------------------------------------ *
 * 6. Per-store summary
 * ------------------------------------------------------------------ */

const EMPTY_SCENE_STATS = Object.freeze({
  count: 0,
  heatBuckets: Object.freeze(zeroMap(HEAT_BUCKETS.map((b) => b.key))),
  heatValues: Object.freeze({}),
  staleHot: 0,
  navStatus: STATUS.OK,
  navReason: null,
  visibleInNav: 0,
  invisibleInNav: 0,
  navBudgetChars: null,
  navUsedChars: 0,
});

function monthOf(iso) {
  const m = String(iso || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(m) ? m : null;
}

/**
 * Everything computable about one store.
 *
 * The asymmetry between plain numbers and wrapped ones is contract §4 and is
 * intentional: index.db either read or the whole store is reported errored, so
 * record-derived figures are plain; the vector reading is the one that can be
 * absent without anything looking wrong, so it stays wrapped in a status forever.
 *
 * @param {import("./contract.js").StoreExtract} storeExtract
 * @param {{now?: number, navBudgetChars?: number|null}} [opts]
 */
function summariseStore(storeExtract, { now = Date.now(), navBudgetChars = null } = {}) {
  const ref = storeExtract.ref;
  const rd = storeExtract.records || C.unmeasured("records not read");
  const vr = storeExtract.vectors || C.unmeasured("vectors not read");
  const sr = storeExtract.scenes || C.unmeasured("scenes not read");
  // Was re-derived inline here, character for character, from the same two fields
  // extract.storeSizeBytes() reads — whose docstring says it exists so this
  // decision lives in ONE place. It now does: contract.js owns it, both readers
  // import it, and it stays pure (two numbers off the ref, no disk).
  const sizeBytes = storeSizeBytes(ref);

  const base = {
    slug: ref.slug,
    scope: ref.scope,
    label: ref.label,
    sizeBytes,
  };

  // ---- records -----------------------------------------------------
  if (rd.status === STATUS.ERROR) {
    // Contract §4: an errored store contributes to NO aggregate. It still gets a
    // row, because a store that vanished from the list would be invisible and a
    // store listed as broken is a finding.
    return {
      ...base,
      status: STATUS.ERROR,
      reason: rd.reason,
      records: null, byType: null, byWritePath: null, contentLength: null,
      lowSignal: null, lowSignalUnion: null, duplicates: null,
      vectors: unmeasuredVectors(`store unreadable: ${rd.reason}`),
      vectorState: VECTOR_STATE.UNMEASURED,
      scenes: summariseScenes(sr, { now, navBudgetChars, scope: ref.scope }),
      newestRecordAt: null, oldestRecordAt: null,
      missingByMonth: null,
    };
  }

  const records = rd.status === STATUS.OK && Array.isArray(rd.records) ? rd.records : [];
  const total = rd.status === STATUS.OK ? (rd.total ?? records.length) : 0;

  // `records` is a SLICE (capped by extract's recordLimit); `total` is the whole
  // population. Every per-record figure below is computed from the slice, so any
  // ratio that pairs one with the other is the measured-subset-over-full-population
  // blend this module exists to prevent — the same shape that produced the false
  // "0% vector coverage" reading. `RecordsRead.truncated` is extract's own signal
  // that the two differ, and until now nothing in transform read it.
  // `records.length < total` is a belt-and-braces derivation for a read that
  // predates the flag; either being true is enough to distrust the pairing.
  const recordsTruncated = rd.status === STATUS.OK &&
    (rd.truncated === true || records.length < total);

  const byType = zeroMap(RECORD_TYPES);
  const byWritePath = zeroMap(WRITE_PATHS);
  const lowSignal = zeroMap(LOW_SIGNAL_CLASSES);
  const lengths = [];
  let lowSignalUnion = 0;
  let newestRecordAt = null;
  let oldestRecordAt = null;

  const vectorsMeasured = vr.status === STATUS.OK;
  const vecIds = vectorsMeasured && vr.recordIds ? vr.recordIds : null;
  const missingByMonth = {};
  const wpTotals = zeroMap(WRITE_PATHS);
  const wpCovered = zeroMap(WRITE_PATHS);
  let withVector = 0;
  let eligibleRecords = 0;

  for (const r of records) {
    const type = RECORD_TYPES.includes(r.type) ? r.type : RECORD_TYPE_OTHER;
    byType[type] += 1;

    const wp = writePathForRecordId(r.record_id);
    byWritePath[wp] += 1;

    const content = r.content || "";
    lengths.push(content.length);

    const classes = classifyLowSignal(content);
    for (const c of classes) lowSignal[c] += 1;
    if (isLowSignalUnion(classes)) lowSignalUnion += 1;

    if (r.updated_time && (!newestRecordAt || r.updated_time > newestRecordAt)) newestRecordAt = r.updated_time;
    if (r.created_time && (!oldestRecordAt || r.created_time < oldestRecordAt)) oldestRecordAt = r.created_time;

    // The population embedding coverage is ABOUT. `records` counts every row,
    // but the writer never embeds episodic/persona by design, so dividing by it
    // measured a number no fix command could ever move: on the real store the
    // 5,459 "missing" vectors were exactly episodic 5,420 + persona 39, and
    // `tmem sync` correctly reported "all vectors in sync" while doctor showed 2%.
    const eligible = isVectorEligible(r.type);
    if (eligible) eligibleRecords += 1;

    if (vecIds && eligible) {
      wpTotals[wp] += 1;
      if (vecIds.has(r.record_id)) {
        withVector += 1;
        wpCovered[wp] += 1;
      } else {
        const mo = monthOf(r.created_time);
        if (mo) missingByMonth[mo] = (missingByMonth[mo] || 0) + 1;
      }
    }
  }

  const exact = duplicateGroups(records, exactKey);
  const normalised = duplicateGroups(records, normalisedKey);

  // ---- vectors -----------------------------------------------------
  let vectors;
  if (!vectorsMeasured) {
    // The ERROR variant is BUILT with the contract's constructor rather than made
    // by patching `.status` onto an already-built object: `source()` is what
    // enforces "a non-ok status carries no numbers", and an in-place patch walks
    // straight past it. The null field set is taken from `unmeasuredVectors()`
    // rather than restated here, so the two shapes cannot drift apart.
    const reason = vr.reason || "vector reading unavailable";
    if (vr.status === STATUS.ERROR) {
      const absent = unmeasuredVectors(reason);
      delete absent.status;
      delete absent.reason;
      vectors = C.errored(reason, absent);
    } else {
      vectors = unmeasuredVectors(reason);
    }
  } else if (recordsTruncated) {
    // WHY UNMEASURED RATHER THAN A RATIO OVER THE SLICE.
    //
    // Both available numerators are wrong. `withVector / total` divides a slice's
    // hits by the full row count and under-reports coverage by construction;
    // `withVector / records.length` is arithmetically clean but answers a
    // different question than the `records: total` printed beside it, so the gap
    // title "N of M records without embeddings" would mix a truncated N with a
    // full M. There is no third number here that is both correct and available.
    //
    // So this takes the route the contract already has for exactly this case:
    // out of the denominator entirely, with a reason. makeCoverage() moves the
    // store's `records` into `unmeasuredRecords` (never into `covered` as zeros),
    // sets `partial`, and carries the reason into `unmeasuredReasons`, so the UI
    // is already obliged to show the population beside the ratio instead of
    // folding it in. It also reuses the store-level gap that already exists —
    // VECTORS_UNMEASURABLE, "embedding coverage unknown for M records" — rather
    // than needing a new kind. No contract change, no fourth vector state.
    //
    // The l1_vec row count IS a whole-store reading and is not thrown away, but it
    // travels in the reason as text rather than as a numeric field on an unmeasured
    // envelope: contract.source() rejects exactly that shape ("a number here is how
    // unmeasured becomes zero"), and this object should not be the one exception.
    // The counted-not-sampled part that survives structurally is `vectorState`.
    vectors = unmeasuredVectors(
      `record read truncated at ${records.length} of ${total} rows — ` +
      "per-record embedding coverage cannot be measured for this store " +
      `(l1_vec holds ${vr.count || 0} rows)`);
  } else {
    const byPath = {};
    for (const wp of WRITE_PATHS) {
      byPath[wp] = {
        withVector: wpCovered[wp],
        withoutVector: wpTotals[wp] - wpCovered[wp],
        ratio: wpTotals[wp] > 0 ? wpCovered[wp] / wpTotals[wp] : 0,
      };
    }
    vectors = {
      status: STATUS.OK,
      reason: null,
      withVector,
      withoutVector: eligibleRecords - withVector,
      ratio: eligibleRecords > 0 ? withVector / eligibleRecords : 0,
      // Surfaced so a reader can see WHICH population the ratio divides by, and
      // how many rows were excluded as never-embedded-by-design. Without this the
      // ratio and the neighbouring `records` count invite the same misreading the
      // ratio itself used to make.
      eligibleRecords,
      ineligibleRecords: records.length - eligibleRecords,
      byWritePath: byPath,
      missingByMonth,
      // A vector whose record is gone. Never negative: `count` is the row count of
      // l1_vec and `withVector` counts a subset of it.
      orphanVectors: Math.max(0, (vr.count || 0) - withVector),
      dimensions: vr.dimensions ?? null,
      vectorRows: vr.count || 0,
    };
  }

  return {
    ...base,
    status: STATUS.OK,
    reason: null,
    records: total,
    // `records` is the row count; `recordsMeasured` is how many of them the
    // per-record figures on this object (byType, lowSignal, duplicates,
    // contentLength) were actually computed from. They are equal unless the read
    // was capped. Surfaced so a consumer can tell a full reading from a partial
    // one instead of inferring it from a ratio that looks plausible either way.
    recordsMeasured: records.length,
    recordsTruncated,
    byType,
    byWritePath,
    contentLength: quantiles(lengths),
    lowSignal,
    lowSignalUnion,
    duplicates: { exact: exact.records, normalised: normalised.records },
    duplicateGroups: { exact: exact.groups, normalised: normalised.groups },
    vectors,
    // Read off the l1_vec row count, which is a whole-store count — a truncated
    // RECORD read does not make "never set up / set up and empty / working"
    // unknown, so this stays measured even when `vectors` above does not, and no
    // fourth state is needed to express the difference.
    vectorState: vectorStateFor(vr),
    scenes: summariseScenes(sr, { now, navBudgetChars, scope: ref.scope }),
    newestRecordAt,
    oldestRecordAt,
    // Slice-derived, so it is only reportable when the slice is the whole store.
    missingByMonth: vectorsMeasured && !recordsTruncated ? missingByMonth : null,
  };
}

/**
 * Per-store scene statistics.
 *
 * `orphanScenes` / `danglingSceneNames` used to live here, joining
 * `l1_records.scene_name` to scene filenames. That join is not maintained by
 * anything in this repo (see the note in buildGaps where the gaps were removed),
 * so the counts were arithmetic over two unrelated columns and are gone with
 * them. Nothing else needed the record-side scene names, so summariseStore no
 * longer collects them.
 *
 * `scope` is passed straight down because nav visibility is only measurable for a
 * project store — see {@link sceneNavVisibility}, which owns both the meaning of
 * the parameter and its default. Declaring the same default here too would be two
 * statements of one rule on one call chain, and both real callers pass `ref.scope`
 * anyway, so this one never fired.
 *
 * @param {import("./contract.js").ScenesRead} sr
 */
function summariseScenes(sr, { now, navBudgetChars, scope }) {
  if (!sr || sr.status !== STATUS.OK || !Array.isArray(sr.scenes)) return null;

  const scenes = sr.scenes;
  const heatBuckets = zeroMap(HEAT_BUCKETS.map((b) => b.key));
  const heatValues = {};
  let staleHot = 0;

  for (const s of scenes) {
    const heat = Number(s.heat) || 0;
    heatBuckets[heatBucketKey(heat)] += 1;
    heatValues[heat] = (heatValues[heat] || 0) + 1;
    if (heat >= STALE_HOT.MIN_HEAT) {
      const age = ageDays(s.updated || s.created, now);
      if (age !== null && age > STALE_HOT.MAX_AGE_DAYS) staleHot += 1;
    }
  }

  const nav = sceneNavVisibility(scenes, navBudgetChars, { scope });

  return {
    count: scenes.length,
    heatBuckets,
    heatValues,
    staleHot,
    // The nav split carries its own status: the scenes were read perfectly, it is
    // the VISIBILITY of them that is unknowable for the global store. Contract §1
    // — an unmeasured reading holds nulls, never numbers, so nothing downstream
    // can add an upper bound into a total and call it measured.
    navStatus: nav.status,
    navReason: nav.reason,
    visibleInNav: nav.visible,
    invisibleInNav: nav.invisible,
    navBudgetChars: nav.budgetChars,
    navUsedChars: nav.usedChars,
  };
}

/* ------------------------------------------------------------------ *
 * 7. Persona projection
 * ------------------------------------------------------------------ */

/**
 * Where each persona bullet actually lands at runtime.
 *
 * Tiers come from running the REAL projections (`projectTier0` for the
 * once-per-session preamble, `projectTier1` for the every-turn slice) rather than
 * re-deriving them, so the lens cannot claim a bullet is injected that the agent
 * never receives.
 *
 * `projectTier1` is run with an EMPTY query on purpose: that is the worst case
 * every turn starts from, so what survives it is what the agent gets
 * unconditionally. Relevance-triggered conditionals appear per-prompt via
 * /api/recall, not here.
 *
 * The `onDemand` vs `never` split is a judgement worth stating: a bullet reaching
 * neither tier is `onDemand` when it is reference or conditional material (that is
 * what retrieval is for) and `never` when its duty is `always` — a hard constraint
 * the agent structurally cannot see is not "available on demand", it is a claim
 * the file makes and the runtime does not keep. `droppedAlwaysDuties` counts
 * exactly those.
 *
 * `projection.legacy` measures the path this replaced — `truncate(persona, 400)`,
 * first five non-heading lines — by RUNNING it (`legacyProjection()`), not by
 * quoting the audit. The lens draws a before/after against it, and a hardcoded
 * "1.09%" would be true on exactly one day: the denominator is the persona
 * document, which grows every consolidation. Measured live, the comparison stays
 * true by construction.
 */
/**
 * Which sections the legacy 400-char projection drew from, and how many lines each
 * contributed.
 *
 * Derived by mirroring `legacyProjection()`'s own line walk — same skip rule, same
 * five-line cap — rather than by testing whether a section's bullet text appears
 * in the output string. Substring matching would be wrong here for the same reason
 * it is wrong when zipping tier bullets: the projection truncates and repairs its
 * text, so the rendered line is not always a prefix of its source. Walking the
 * lines answers the question directly.
 *
 * The finding it exists to surface: the legacy path takes the first five lines of
 * the document, so it reports whatever section happens to sit at the top —
 * historically `Identity`, all five, regardless of duty.
 *
 * @param {string} text  Raw persona.md
 * @param {number} maxLines  Must match legacyProjection's cap.
 * @returns {{name: string, lines: number}[]} In first-appearance order.
 */
function legacySections(text, maxLines) {
  const counts = new Map();
  let section = "";
  let taken = 0;

  for (const line of String(text == null ? "" : text).trim().split(/\r?\n/)) {
    if (line.startsWith("#")) {
      // Headings are skipped by legacyProjection but still move the cursor. `#` is
      // the document title, not a section — the same rule parsePersona uses.
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      if (m && m[1].length >= 2) section = m[2].trim();
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    counts.set(section, (counts.get(section) || 0) + 1);
    taken += 1;
    if (taken >= maxLines) break;
  }

  return [...counts].map(([name, lines]) => ({ name, lines }));
}

/**
 * @param {import("./contract.js").PersonaRead} personaRead
 * @param {{tier0MaxChars?: number}} [opts] Effective tier-0 budget, resolved by the
 *   caller from `config.personaBudgetTokens` (env > config.json > default), i.e. the
 *   same number `on_session_start.js` projects with. Defaults to the projection's own
 *   default so a direct caller with no config in hand behaves as before. There is no
 *   tier-1 equivalent on purpose: that budget is pinned, not configurable.
 */
function summarisePersona(personaRead, { tier0MaxChars = DEFAULT_TIER0_MAX_CHARS } = {}) {
  if (!personaRead || personaRead.status !== STATUS.OK || typeof personaRead.text !== "string") {
    // A read claiming `ok` with no text is the contract inverted — a measured
    // status over an absent payload — and echoing that status would publish
    // "persona: ok" with every field null, which renders as a healthy persona
    // nobody can see. It is reported as an error naming exactly that instead.
    const okButEmpty = !!personaRead && personaRead.status === STATUS.OK;
    return {
      status: okButEmpty ? STATUS.ERROR : ((personaRead && personaRead.status) || STATUS.UNMEASURED),
      reason: okButEmpty
        ? "persona read reported ok but carried no text — the payload contradicts its status"
        : (personaRead && personaRead.reason) || "persona not read",
      sections: null, bullets: null, duties: null, projection: null,
    };
  }

  const parsed = annotate(parsePersona(personaRead.text));
  const tier0 = projectTier0(parsed, { maxChars: tier0MaxChars });
  const tier1 = projectTier1(parsed, { maxChars: DEFAULT_TIER1_MAX_CHARS, query: "" });

  // Composite key: NUL separates the two parts. A section name can never
  // contain NUL, so the joined key is unambiguous.
  //
  // Keep this as the \x00 ESCAPE, never a raw NUL byte. A raw NUL makes the
  // whole file "binary" to file(1) and grep, and grep then reports "no matches"
  // — no error, no warning, exit 1 as if the pattern were genuinely absent.
  // This file cost two agents in one session: one grepped it for `require`,
  // got nothing, and nearly documented that the module still duplicated code
  // it had stopped duplicating; another grepped for `suggestion`, got nothing,
  // and reported the remediation strings missing when there are 17 of them.
  // Both would have written the opposite of the truth into a user-facing doc.
  const key = (sectionName, index) => `${sectionName}\x00${index}`;
  const inTier1 = new Map(tier1.bullets.map((b) => [key(b.sectionName, b.index), b]));
  const inTier0 = new Map(tier0.bullets.map((b) => [key(b.sectionName, b.index), b]));

  // Line numbers live on the extract's bullet list (same order, same parser).
  const lineNos = Array.isArray(personaRead.bullets) ? personaRead.bullets.map((b) => b.lineNo) : [];

  const bullets = [];
  const duties = zeroMap(DUTY_CLASSES);
  const byTier = zeroMap(INJECTION_TIERS);
  const byTierChars = zeroMap(INJECTION_TIERS);
  let ordinal = 0;
  let injectedChars = 0;
  let droppedAlwaysDuties = 0;
  const sections = [];

  for (const section of parsed) {
    const sec = { name: section.name, lineNo: 0, bullets: 0, chars: 0, duties: zeroMap(DUTY_CLASSES) };
    for (const b of section.bullets) {
      // Zipped by (section, index) — the projection's own identifiers — never by
      // substring. `truncateAtWord()`'s dangling-`**` repair DELETES the marker,
      // so a rendered line can differ from its source in the middle, not just at
      // the tail; a prefix test would silently mis-attribute exactly the bullets
      // whose delivery we are trying to measure.
      const k = key(section.name, b.index);
      const t1 = inTier1.get(k);
      const t0 = inTier0.get(k);

      let tier;
      let tierReason;
      // What the agent ACTUALLY receives for this bullet. A truncated bullet that
      // counted at full source length would overstate delivery — the headline
      // "injected chars" is the number the whole projection view exists to keep
      // honest.
      let bulletInjectedChars = 0;
      let truncated = false;
      if (t1) {
        tier = "promptSummary";
        tierReason = `tier-1 (${t1.reason}, score ${t1.score}) — ${t1.injectedChars} of ${t1.sourceChars} chars` +
          (t1.truncated ? ", truncated" : "");
        bulletInjectedChars = t1.injectedChars;
        truncated = !!t1.truncated;
        injectedChars += t1.injectedChars;
      } else if (t0) {
        tier = "sessionStart";
        tierReason = `tier-0 preamble — ${t0.injectedChars} of ${t0.sourceChars} chars` +
          (t0.truncated ? ", truncated" : "");
        bulletInjectedChars = t0.injectedChars;
        truncated = !!t0.truncated;
      } else if (b.duty === "always") {
        tier = "never";
        tierReason = `duty "always" but selected by neither tier-0 (${tier0.usedChars}/${tier0.budgetChars} chars) ` +
          `nor tier-1 (${tier1.usedChars}/${tier1.budgetChars} chars)`;
      } else {
        tier = "onDemand";
        tierReason = `duty "${b.duty}" — retrievable from persona.md, not injected`;
      }

      if (tier === "never" && b.duty === "always") droppedAlwaysDuties += 1;

      bullets.push({
        section: section.name,
        text: b.text,
        chars: b.chars,
        lineNo: lineNos[ordinal] ?? 0,
        ordinal,
        duty: b.duty,
        tier,
        tierReason,
        injectedChars: bulletInjectedChars,
        truncated,
      });

      duties[b.duty] += 1;
      byTier[tier] += 1;
      // Chars ATTRIBUTABLE to the tier: delivered chars where the bullet is
      // injected, source chars where it is not. For promptSummary/sessionStart
      // that is what the agent reads; for onDemand/never it is the mass sitting
      // in the file unread, which is the whole point of showing the tier at all.
      byTierChars[tier] += (tier === "promptSummary" || tier === "sessionStart")
        ? bulletInjectedChars
        : b.chars;
      sec.bullets += 1;
      sec.chars += b.chars;
      sec.duties[b.duty] += 1;
      ordinal += 1;
    }
    sections.push(sec);
  }

  // The path this replaced, run rather than quoted. `totalChars` is the whole
  // persona DOCUMENT (not the sum of bullet chars above), because the figure the
  // lens draws is "how much of what the consolidator wrote ever arrived" — 401 of
  // ~36k chars, every one of them from whichever section happens to be first.
  const legacyText = legacyProjection(personaRead.text);
  const legacyTotalChars = personaRead.text.length;
  const legacy = {
    chars: legacyText.length,
    totalChars: legacyTotalChars,
    ratio: legacyTotalChars > 0 ? legacyText.length / legacyTotalChars : 0,
    sections: legacySections(personaRead.text, LEGACY_MAX_LINES),
  };

  // Heading line numbers come from extract (it read the file); match by name.
  if (Array.isArray(personaRead.sections)) {
    const lineByName = new Map(personaRead.sections.map((s) => [s.name, s.lineNo]));
    for (const s of sections) s.lineNo = lineByName.get(s.name) || 0;
  }

  return {
    status: STATUS.OK,
    reason: null,
    sections,
    bullets,
    duties,
    projection: {
      totalBullets: bullets.length,
      totalChars: bullets.reduce((a, b) => a + b.chars, 0),
      byTier,
      byTierChars,
      injectedChars,
      droppedAlwaysDuties,
      tier0Chars: tier0.usedChars,
      tier0BudgetChars: tier0.budgetChars,
      tier1Chars: tier1.usedChars,
      tier1BudgetChars: tier1.budgetChars,
      legacy,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 8. Gaps
 * ------------------------------------------------------------------ */

const SEVERITY_RANK = { critical: 3, warn: 2, info: 1 };

const subjectFor = (s) => ({ scope: s.scope, slug: s.slug, id: null, label: s.label });

/**
 * The ONE place a {@link GAP_KIND.VECTORS_MISSING} gap is built.
 *
 * There were two builders — one for a measured store, one for a truncated store
 * whose empty `l1_vec` is still a whole-store fact — carrying a byte-identical
 * copy of the empty-`l1_vec` sentence and six of eight evidence keys. That
 * sentence is the one a user acts on, and it is on the most-hit gap in the
 * payload (22 stores today); reworded in one copy and not the other, the same
 * finding would render two ways depending on something as unrelated as whether
 * the record read hit its cap.
 *
 * `empty` is derived here rather than passed, because it must not be possible
 * for a caller to claim the empty wording with a non-empty state. What callers
 * DO supply is the arithmetic (which differs: one side measured it per record,
 * the other knows it from a zero row count) and `extra` evidence keys.
 *
 * @param {Object} s StoreSummary
 * @param {{severity: string, withVector: number, withoutVector: number,
 *          ratio: number, extra?: Object}} parts
 */
function vectorsMissingGap(s, { severity, withVector, withoutVector, ratio, extra = {} }) {
  const empty = s.vectorState === VECTOR_STATE.EMPTY;
  // Eligible population when it was measurable, else the row count (a truncated or
  // errored store carries no per-record types to count).
  const pop = typeof s.vectors.eligibleRecords === "number" ? s.vectors.eligibleRecords : s.records;
  return gap({
    kind: GAP_KIND.VECTORS_MISSING,
    severity,
    subject: subjectFor(s),
    title: empty
      ? `${s.label}: l1_vec is present and empty — all ${pop} recall-eligible records are FTS-only`
      : `${s.label}: ${withoutVector} of ${pop} recall-eligible records without embeddings`,
    evidence: {
      slug: s.slug,
      records: s.records,
      // The denominator the ratio and `withoutVector` actually use. Printed
      // beside `records` so the two can never be confused again: they differ by
      // the episodic/persona rows nothing ever embeds.
      eligibleRecords: pop,
      withVector,
      withoutVector,
      ratio: round(ratio, 4),
      vectorState: s.vectorState,
      ...extra,
    },
    suggestion: "tmem sync",
  });
}

/**
 * Every shortfall the extract supports, as a flat list.
 *
 * The ordering rule matters as much as the contents: measured findings before
 * unmeasured ones, then severity descending. An absence of knowledge must never
 * outrank a known defect, or the list re-creates the false alarm it exists to
 * prevent.
 */
function buildGaps({ stores, persona, state, config, captureState, heat }) {
  const gaps = [];

  for (const s of stores) {
    if (s.status === STATUS.ERROR) {
      gaps.push(gap({
        kind: GAP_KIND.STORE_UNREADABLE,
        severity: SEVERITY.CRITICAL,
        subject: subjectFor(s),
        title: `${s.label}: index.db could not be read`,
        evidence: { slug: s.slug, reason: s.reason },
        // `tmem doctor` was suggested here and does not exist anywhere in the
        // repo — the dispatcher answers "Unknown command". There is no repair
        // verb for a corrupt index.db, so this points at the real verb that
        // re-reads the stores (`tmem status`) rather than inventing a fix: a
        // suggestion is a promise that the command exists, and a dead command is
        // worse than none at the moment someone is trying to act on a critical.
        suggestion: "tmem status",
      }));
      continue;
    }

    // ---- vectors ---------------------------------------------------
    if (s.vectors.status !== STATUS.OK) {
      if (s.vectorState === VECTOR_STATE.EMPTY && s.records > 0) {
        // Reachable only for a truncated read: per-record coverage above went
        // `unmeasured`, but `vectorState` says l1_vec holds ZERO rows, and that is
        // a whole-store count. Zero rows means zero of `s.records` are embedded —
        // no numerator comes from the slice, so this finding is exactly as
        // measured as it was before the cap, and reporting it as "unknown" would
        // be the blending bug inverted: a measured critical rendered as an
        // absence. It keeps its kind, severity and wording; only the per-write-path
        // split is missing, because THAT would have to come from the slice.
        gaps.push(vectorsMissingGap(s, {
          severity: SEVERITY.CRITICAL,
          withVector: 0,
          withoutVector: typeof s.vectors.eligibleRecords === "number" ? s.vectors.eligibleRecords : s.records,
          ratio: 0,
          extra: { recordsMeasured: s.recordsMeasured, reason: s.vectors.reason },
        }));
      } else if (s.records > 0) {
        gaps.push(gap({
          kind: GAP_KIND.VECTORS_UNMEASURABLE,
          severity: SEVERITY.WARN,
          unmeasured: true,
          subject: subjectFor(s),
          title: `${s.label}: embedding coverage unknown for ${s.records} records`,
          evidence: { slug: s.slug, records: s.records, reason: s.vectors.reason },
          suggestion: "tmem sync",
        }));
      }
    } else if (s.vectors.withoutVector > 0) {
      const empty = s.vectorState === VECTOR_STATE.EMPTY;
      gaps.push(vectorsMissingGap(s, {
        // An l1_vec that exists and is empty is worse than a partially-synced one:
        // the store passes every file-exists health check while running FTS-only.
        severity: empty ? SEVERITY.CRITICAL : (s.vectors.ratio < 0.5 ? SEVERITY.WARN : SEVERITY.INFO),
        withVector: s.vectors.withVector,
        withoutVector: s.vectors.withoutVector,
        ratio: s.vectors.ratio,
        extra: {
          autoPathRatio: round(s.vectors.byWritePath[WRITE_PATH.AUTO].ratio, 4),
          awaitedPathRatio: round(s.vectors.byWritePath[WRITE_PATH.AWAITED].ratio, 4),
        },
      }));
    }

    if (s.vectors.status === STATUS.OK && s.vectors.orphanVectors > 0) {
      gaps.push(gap({
        kind: GAP_KIND.VECTORS_ORPHANED,
        severity: SEVERITY.INFO,
        subject: subjectFor(s),
        title: `${s.label}: ${s.vectors.orphanVectors} embeddings with no record`,
        evidence: { slug: s.slug, orphanVectors: s.vectors.orphanVectors, vectorRows: s.vectors.vectorRows },
        suggestion: "tmem sync",
      }));
    }

    // ---- duplicates ------------------------------------------------
    if (s.duplicates && s.duplicates.exact > 0) {
      // Duplicates can only be found among records that were read, so the share —
      // which drives the WARN/INFO threshold — divides by `recordsMeasured`. On a
      // truncated store, `s.records` would deflate the share and could silently
      // demote a real WARN to INFO; the title says which population was searched
      // rather than implying the whole store.
      const share = s.recordsMeasured > 0 ? s.duplicates.exact / s.recordsMeasured : 0;
      gaps.push(gap({
        kind: GAP_KIND.DUPLICATE_RECORDS,
        severity: share >= 0.1 ? SEVERITY.WARN : SEVERITY.INFO,
        subject: subjectFor(s),
        title: `${s.label}: ${s.duplicates.exact} of ${s.recordsMeasured} records are exact duplicates` +
          (s.recordsTruncated ? ` (of ${s.records} rows; the rest were not read)` : ""),
        evidence: {
          slug: s.slug,
          exact: s.duplicates.exact,
          normalised: s.duplicates.normalised,
          exactGroups: s.duplicateGroups.exact,
          share: round(share, 4),
          records: s.recordsMeasured,
          recordsUnread: Math.max(0, s.records - s.recordsMeasured),
        },
        suggestion: null,
      }));
    }

    // ---- scenes ----------------------------------------------------
    if (!s.scenes) continue;
    if (s.scenes.navStatus !== STATUS.OK && s.scenes.count > 0) {
      // The scenes ARE written and the block IS budgeted; what cannot be computed
      // is how many survive, because global renders behind whichever project is
      // active. Reported as an absence of measurement rather than dropped: a store
      // that says nothing looks like a store with nothing to say. `unmeasured`
      // caps it at warn by construction (contract.gap), and carries no
      // invisibleInNav — there is no honest number to put there.
      gaps.push(gap({
        kind: GAP_KIND.SCENE_INVISIBLE,
        severity: SEVERITY.WARN,
        unmeasured: true,
        subject: subjectFor(s),
        title: `${s.label}: how many of ${s.scenes.count} scenes appear in scene-navigation ` +
          "depends on the active project and was not measured",
        evidence: {
          slug: s.slug,
          scenes: s.scenes.count,
          navBudgetChars: s.scenes.navBudgetChars,
          reason: s.scenes.navReason,
        },
        suggestion: null,
      }));
    } else if (s.scenes.invisibleInNav > 0) {
      gaps.push(gap({
        kind: GAP_KIND.SCENE_INVISIBLE,
        severity: s.scenes.visibleInNav === 0 ? SEVERITY.CRITICAL : SEVERITY.WARN,
        subject: subjectFor(s),
        title: `${s.label}: ${s.scenes.invisibleInNav} of ${s.scenes.count} scenes never appear in scene-navigation`,
        evidence: {
          slug: s.slug,
          scenes: s.scenes.count,
          visibleInNav: s.scenes.visibleInNav,
          invisibleInNav: s.scenes.invisibleInNav,
          navBudgetChars: s.scenes.navBudgetChars,
          navUsedChars: s.scenes.navUsedChars,
        },
        suggestion: "tmem config scene-max-tokens <n>",
      }));
    }
    if (s.scenes.staleHot > 0) {
      gaps.push(gap({
        kind: GAP_KIND.SCENE_STALE_HOT,
        severity: SEVERITY.INFO,
        subject: subjectFor(s),
        title: `${s.label}: ${s.scenes.staleHot} scenes claim heat >= ${STALE_HOT.MIN_HEAT} but are older than ${STALE_HOT.MAX_AGE_DAYS} days`,
        evidence: { slug: s.slug, staleHot: s.scenes.staleHot, minHeat: STALE_HOT.MIN_HEAT, maxAgeDays: STALE_HOT.MAX_AGE_DAYS },
        suggestion: "/memory-consolidate",
      }));
    }
    // NO scene_orphaned / scene_dangling GAPS — DELETED, NOT SOFTENED.
    //
    // They compared `l1_records.scene_name` against scene FILENAMES as if the two
    // were a foreign key. They are not, and never were: no code path in this repo
    // writes a record's `scene_name` to match a scene file.
    //
    //   - memory_auto_capture.js writes the literal constant "auto-capture" on
    //     every auto-captured record: 5367 of 5559 rows in the live store (96.5%).
    //   - The seed extractor writes a free-text "Brief scene description" PER
    //     RECORD (skills/memory-seed/references/extraction-guide.md), months
    //     before any scene exists, in whatever casing the model chose.
    //   - Scene files are named later and independently by the consolidator
    //     (`tmem write-scene --name`), slugified by memory_writer.writeSceneBlock.
    //     skills/memory-consolidate/SKILL.md reuses existing scene names for
    //     scene-to-scene dedup, and never writes anything back to L1.
    //   - Nothing reads `scene_name` either: not recall, not search, not the CLI.
    //     It is even UNINDEXED in the FTS table.
    //
    // So the join produced 19 stores × "218 of 219 scene files orphaned" and the
    // mirror-image "130 dangling names" — near-total in both directions at once,
    // which is the signature of comparing two unrelated columns. Across the whole
    // live store there is exactly ONE match ('azure-infrastructure-environments'),
    // and slugifying both sides does not rescue it (216/219 still orphaned).
    //
    // This could have been reported as `unmeasured`, and that would have been the
    // second lie: both sides read perfectly. There is nothing we failed to
    // measure — the question was malformed. A finding that scores a relationship
    // the system does not maintain is worse than no finding, especially rendered
    // in plain language as "218 topic summaries have no memories left under them".
    //
    // If L1→L2 linkage is ever actually implemented (a scene id on the record, or
    // consolidation stamping the scene name back), this becomes worth measuring
    // again — and it will need writing against whatever that link IS, not against
    // this string comparison.
  }

  // ---- low signal (root level, union only) -------------------------
  if (heat.lowSignal && heat.lowSignal.records > 0) {
    const ls = heat.lowSignal;
    gaps.push(gap({
      kind: GAP_KIND.LOW_SIGNAL_RECORDS,
      severity: ls.ratio >= 0.25 ? SEVERITY.WARN : SEVERITY.INFO,
      subject: { scope: "root", slug: null, id: null, label: "all stores" },
      // `ls.records` is the read population; when a store truncated, the unread
      // remainder is named in the title instead of being folded into the share.
      title: `${ls.unionRecords} of ${ls.records} records (${pct(ls.ratio)}) are low-signal` +
        (ls.recordsUnread > 0 ? ` — ${ls.recordsUnread} further records were not read` : ""),
      evidence: {
        records: ls.records,
        recordsUnread: ls.recordsUnread,
        unionRecords: ls.unionRecords,
        ratio: round(ls.ratio, 4),
        ...ls.perClass,
        pinnedRatio: round(LOW_SIGNAL_BASELINE.ratio, 4),
        withinBaselineTolerance: ls.baseline.withinTolerance,
        baselineComparable: ls.baseline.comparable !== false,
      },
      suggestion: null,
    }));
  }

  // ---- heat scale mismatch ----------------------------------------
  if (heat.scenes > 0 && heat.observedMax < HEAT_SCALE.READER_FIRST_FLAME_AT) {
    gaps.push(gap({
      kind: GAP_KIND.HEAT_SCALE_MISMATCH,
      severity: SEVERITY.WARN,
      subject: { scope: "root", slug: null, id: null, label: "scene heat" },
      title: `all ${heat.scenes} scenes are written on a ${heat.observedMin}-${heat.observedMax} heat scale, ` +
        `but scene_nav.heatEmoji() renders its first flame at ${HEAT_SCALE.READER_FIRST_FLAME_AT}`,
      evidence: {
        scenes: heat.scenes,
        observedMin: heat.observedMin,
        observedMax: heat.observedMax,
        writerScale: `${HEAT_SCALE.MIN}-${HEAT_SCALE.MAX}`,
        readerFirstFlameAt: HEAT_SCALE.READER_FIRST_FLAME_AT,
        scenesWithACue: 0,
        distribution: JSON.stringify(heat.values),
      },
      suggestion: null,
    }));
  } else if (heat.buckets && heat.buckets.offScale > 0) {
    // The mirror image: a writer has adopted the reader's larger scale, so the
    // buckets this lens calibrated to the 1-5 documentation no longer describe it.
    gaps.push(gap({
      kind: GAP_KIND.HEAT_SCALE_MISMATCH,
      severity: SEVERITY.WARN,
      subject: { scope: "root", slug: null, id: null, label: "scene heat" },
      title: `${heat.buckets.offScale} scenes carry heat above the documented ${HEAT_SCALE.MIN}-${HEAT_SCALE.MAX} scale`,
      evidence: {
        scenes: heat.scenes,
        offScale: heat.buckets.offScale,
        observedMax: heat.observedMax,
        writerScale: `${HEAT_SCALE.MIN}-${HEAT_SCALE.MAX}`,
      },
      suggestion: null,
    }));
  }

  // ---- persona -----------------------------------------------------
  if (persona.status !== STATUS.OK) {
    gaps.push(gap({
      kind: GAP_KIND.PERSONA_MISSING,
      severity: SEVERITY.WARN,
      unmeasured: persona.status === STATUS.UNMEASURED,
      subject: { scope: "root", slug: null, id: null, label: "persona" },
      title: "no L3 persona is available",
      evidence: { reason: persona.reason },
      suggestion: "/memory-consolidate",
    }));
  } else if (persona.projection.droppedAlwaysDuties > 0) {
    gaps.push(gap({
      kind: GAP_KIND.PERSONA_UNPROJECTED,
      severity: SEVERITY.WARN,
      subject: { scope: "root", slug: null, id: null, label: "persona" },
      title: `${persona.projection.droppedAlwaysDuties} of ${persona.projection.totalBullets} persona bullets are ` +
        `"always" duty but reach no injection tier`,
      evidence: {
        droppedAlwaysDuties: persona.projection.droppedAlwaysDuties,
        totalBullets: persona.projection.totalBullets,
        injectedChars: persona.projection.injectedChars,
        tier0Chars: persona.projection.tier0Chars,
        tier1Chars: persona.projection.tier1Chars,
        ...persona.projection.byTier,
      },
      suggestion: null,
    }));
  }

  // ---- capture backlog --------------------------------------------
  if (captureState.status === STATUS.OK && config.status === STATUS.OK && config.consolidateEvery > 0) {
    const behind = (captureState.turnCount || 0) - (captureState.lastConsolidationTurn || 0);
    if (behind >= config.consolidateEvery) {
      gaps.push(gap({
        kind: GAP_KIND.CAPTURE_BACKLOG,
        severity: behind >= config.consolidateEvery * 2 ? SEVERITY.WARN : SEVERITY.INFO,
        subject: { scope: "root", slug: null, id: null, label: "consolidation" },
        title: `${behind} turns captured since the last consolidation (threshold ${config.consolidateEvery})`,
        evidence: {
          turnCount: captureState.turnCount,
          lastConsolidationTurn: captureState.lastConsolidationTurn,
          behind,
          consolidateEvery: config.consolidateEvery,
        },
        suggestion: "/memory-consolidate",
      }));
    }
  }

  // ---- root documents ---------------------------------------------
  for (const [name, doc] of [["state.json", state], ["config.json", config], ["capture_state.json", captureState]]) {
    if (doc.status === STATUS.ERROR) {
      gaps.push(gap({
        kind: GAP_KIND.CONFIG_UNREADABLE,
        severity: SEVERITY.WARN,
        subject: { scope: "root", slug: null, id: name, label: name },
        title: `${name} could not be read`,
        evidence: { file: name, reason: doc.reason },
        suggestion: null,
      }));
    }
  }

  gaps.sort((a, b) =>
    Number(a.unmeasured) - Number(b.unmeasured) ||
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    a.kind.localeCompare(b.kind) ||
    a.id.localeCompare(b.id));

  return gaps;
}

const round = (n, d) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
const pct = (r) => `${(r * 100).toFixed(1)}%`;

/* ------------------------------------------------------------------ *
 * 9. Snapshot identity
 * ------------------------------------------------------------------ */

/**
 * Implements {@link SNAPSHOT_ID_SPEC} verbatim. O(stores), not O(records): this
 * answers "is this the same state I exported?", not "is every byte identical".
 */
function computeSnapshotId(stores, persona) {
  const lines = stores
    .slice()
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((s) => (s.status === STATUS.ERROR
      ? `${s.slug}${SNAPSHOT_ID_SPEC.fieldSeparator}${SNAPSHOT_ID_SPEC.erroredStoreLine}`
      : [s.slug, s.records ?? 0, s.newestRecordAt || "", s.scenes ? s.scenes.count : 0]
        .join(SNAPSHOT_ID_SPEC.fieldSeparator)));

  const personaBytes = persona && persona.status === STATUS.OK ? (persona.bytes ?? "NA") : "NA";
  const personaMtime = persona && persona.status === STATUS.OK ? (persona.mtime || "") : "";
  lines.push(`persona\t${personaBytes}\t${personaMtime}`);

  const digest = crypto
    .createHash(SNAPSHOT_ID_SPEC.algorithm)
    .update(`v${SCHEMA_VERSION}\n${lines.join(SNAPSHOT_ID_SPEC.lineSeparator)}`, "utf8")
    .digest("hex")
    .slice(0, SNAPSHOT_ID_SPEC.digestChars);

  return `${SNAPSHOT_ID_SPEC.prefix}${digest}`;
}

/* ------------------------------------------------------------------ *
 * 10. Root transform
 * ------------------------------------------------------------------ */

/**
 * {@link RootExtract} -> {@link Snapshot}. The only entry point its two
 * consumers need: serve.js (live server) and cli.js's `cmdViewSnapshot`
 * (`tmem view --snapshot`). There is no dump.js — that module was planned and
 * never written; the CLI took the job.
 *
 * @param {import("./contract.js").RootExtract} root
 * @param {{now?: number, extractMs?: number}} [opts]
 * @returns {import("./contract.js").Snapshot}
 */
function transformRoot(root, { now = Date.now(), extractMs = 0 } = {}) {
  const t0 = process.hrtime.bigint();

  const config = (root && root.config) || C.unmeasured("config not read");
  const state = (root && root.state) || C.unmeasured("state not read");
  const captureState = (root && root.captureState) || C.unmeasured("capture state not read");

  // The scene-nav budget is a knob with a default, so an unset config still has an
  // effective value; without it every scene would be reported invisible, which
  // would be a louder lie than the one this tool is chasing.
  const navBudgetTokens = config.status === STATUS.OK && Number.isFinite(config.sceneNavBudgetTokens)
    ? config.sceneNavBudgetTokens
    : SCENE_NAV.DEFAULT_BUDGET_TOKENS;
  const navBudgetChars = navBudgetTokens > 0 ? navBudgetTokens * SCENE_NAV.CHARS_PER_TOKEN : 0;

  // Same treatment for the persona knob, and for a sharper reason: this feature's
  // headline claim is that the tiers are computed by the SAME projection the recall
  // hook runs. Hardcoding DEFAULT_TIER0_MAX_CHARS kept that true only for users who
  // never ran `tmem config persona-max-tokens`; at 600 tokens the hook injects 2400
  // chars while the lens drew 4800, so bullets shown as sessionStart-delivered were
  // in fact `never`. `getPersonaMaxTokens()` rejects 0 (see memory_auto_capture), so
  // unlike the nav budget there is no "disabled" case to model here.
  const personaBudgetTokens = config.status === STATUS.OK && Number.isFinite(config.personaBudgetTokens)
    && config.personaBudgetTokens > 0
    ? config.personaBudgetTokens
    : null;
  const tier0MaxChars = personaBudgetTokens === null
    ? DEFAULT_TIER0_MAX_CHARS
    : personaBudgetTokens * CHARS_PER_TOKEN;

  const stores = ((root && root.stores) || []).map((s) => summariseStore(s, { now, navBudgetChars }));

  // ---- totals ------------------------------------------------------
  const byType = zeroMap(RECORD_TYPES);
  const byWritePath = zeroMap(WRITE_PATHS);
  const lowSignalPerClass = zeroMap(LOW_SIGNAL_CLASSES);
  const heatBuckets = zeroMap(HEAT_BUCKETS.map((b) => b.key));
  const heatValues = {};
  const duplicates = zeroMap(DUPLICATE_TIERS);
  const duplicateGroupCount = zeroMap(DUPLICATE_TIERS);
  const vectorStates = zeroMap(VECTOR_STATES);
  const vectorStateSlugs = Object.fromEntries(VECTOR_STATES.map((k) => [k, []]));
  const vectorStateRecords = zeroMap(VECTOR_STATES);
  const missingByMonth = {};

  let records = 0, recordsMeasured = 0, truncatedStores = 0;
  let scenes = 0, sizeBytes = 0;
  let readableStores = 0, erroredStores = 0;
  let lowSignalUnion = 0;
  let scenesReachableInSomeNav = 0, scenesUnreachableInEveryNav = 0, staleHot = 0;
  let scenesNavUnmeasured = 0;
  // One string, not a set: every unmeasured store's reason comes out of the same
  // template with the same root-level budget in it, so the copies were identical
  // by construction. Contract §6 (Totals.scenesNavUnmeasuredReason).
  let scenesNavUnmeasuredReason = null;
  let observedMinHeat = null, observedMaxHeat = null;

  const covEntries = [];
  const covEntriesByPath = Object.fromEntries(WRITE_PATHS.map((wp) => [wp, []]));

  for (const s of stores) {
    sizeBytes += s.sizeBytes;

    if (s.status === STATUS.ERROR) {
      erroredStores += 1;
      // An unreadable store cannot be counted, but it must not vanish from the
      // coverage caveat either: it enters as an errored entry with zero records.
      covEntries.push({ status: STATUS.ERROR, reason: s.reason, records: 0 });
      for (const wp of WRITE_PATHS) covEntriesByPath[wp].push({ status: STATUS.ERROR, reason: s.reason, records: 0 });
      vectorStates[VECTOR_STATE.UNMEASURED] += 1;
      vectorStateSlugs[VECTOR_STATE.UNMEASURED].push(s.slug);
      continue;
    }

    readableStores += 1;
    records += s.records;
    // Everything summed on the next four lines is counted PER RECORD READ, so its
    // denominator is the number of records read — not `records`, which is the row
    // count. They are equal unless a store truncated; keeping both means a share
    // built from these counts can never quietly acquire a population it never saw.
    recordsMeasured += s.recordsMeasured;
    if (s.recordsTruncated) truncatedStores += 1;
    for (const k of RECORD_TYPES) byType[k] += s.byType[k];
    for (const k of WRITE_PATHS) byWritePath[k] += s.byWritePath[k];
    for (const k of LOW_SIGNAL_CLASSES) lowSignalPerClass[k] += s.lowSignal[k];
    lowSignalUnion += s.lowSignalUnion;
    for (const k of DUPLICATE_TIERS) {
      duplicates[k] += s.duplicates[k];
      duplicateGroupCount[k] += s.duplicateGroups[k];
    }

    vectorStates[s.vectorState] += 1;
    vectorStateSlugs[s.vectorState].push(s.slug);
    vectorStateRecords[s.vectorState] += s.records;

    if (s.vectors.status === STATUS.OK) {
      // `eligibleRecords`, not `records`: the denominator has to be the population
      // the numerator could ever come from. `tmem sync` embeds only eligible types,
      // so dividing by every row made store-wide coverage read 2% on a store that
      // sync correctly called fully in sync.
      covEntries.push({ status: STATUS.OK, records: s.vectors.eligibleRecords, covered: s.vectors.withVector });
      for (const wp of WRITE_PATHS) {
        const p = s.vectors.byWritePath[wp];
        covEntriesByPath[wp].push({
          status: STATUS.OK,
          records: p.withVector + p.withoutVector,
          covered: p.withVector,
        });
      }
      for (const [m, n] of Object.entries(s.vectors.missingByMonth)) {
        missingByMonth[m] = (missingByMonth[m] || 0) + n;
      }
    } else {
      // The whole-store entry carries the true row count, so `unmeasuredRecords`
      // states the full population left out of the ratio — EXCEPT when l1_vec is
      // known to be empty, where "0 covered of s.records" is a whole-store fact
      // (see the matching gap): it needs no numerator from the record slice, so
      // it stays in the denominator rather than being demoted to unknown. The
      // per-write-path split below cannot follow it there, because that one does
      // need the slice.
      // An empty l1_vec is a whole-store fact, but the population it is empty OF
      // is still the eligible one. `eligibleRecords` is null on an unmeasured
      // envelope (contract.source forbids numbers there), so fall back to the row
      // count — an over-estimate, never an under-report of the gap.
      const emptyPop = typeof s.vectors.eligibleRecords === "number" ? s.vectors.eligibleRecords : s.records;
      const entry = s.vectorState === VECTOR_STATE.EMPTY
        ? { status: STATUS.OK, records: emptyPop, covered: 0 }
        : { status: s.vectors.status, reason: s.vectors.reason, records: s.records };
      covEntries.push(entry);
      for (const wp of WRITE_PATHS) {
        // Per-path counts only exist for records we read, so on a truncated store
        // these are a LOWER BOUND on the excluded population (they sum to
        // `recordsMeasured`, not `records`). They are excluded records either way —
        // no ratio is affected — and there is no honest way to split the unread
        // remainder across write paths, so it is left uncounted rather than guessed.
        covEntriesByPath[wp].push({ status: s.vectors.status, reason: s.vectors.reason, records: s.byWritePath[wp] });
      }
    }

    if (s.scenes) {
      scenes += s.scenes.count;
      // Measured stores only. A store whose nav visibility is unmeasurable keeps
      // its scenes OUT of both counts and into `scenesNavUnmeasured` — the same
      // rule Coverage applies to records, for the same reason: an upper bound
      // added to a sum is indistinguishable from a measurement afterwards.
      if (s.scenes.navStatus === STATUS.OK) {
        scenesReachableInSomeNav += s.scenes.visibleInNav;
        scenesUnreachableInEveryNav += s.scenes.invisibleInNav;
      } else {
        scenesNavUnmeasured += s.scenes.count;
        if (s.scenes.navReason && scenesNavUnmeasuredReason === null) {
          scenesNavUnmeasuredReason = s.scenes.navReason;
        }
      }
      staleHot += s.scenes.staleHot;
      for (const k of Object.keys(heatBuckets)) heatBuckets[k] += s.scenes.heatBuckets[k];
      for (const [h, n] of Object.entries(s.scenes.heatValues)) {
        heatValues[h] = (heatValues[h] || 0) + n;
        const hv = Number(h);
        if (observedMinHeat === null || hv < observedMinHeat) observedMinHeat = hv;
        if (observedMaxHeat === null || hv > observedMaxHeat) observedMaxHeat = hv;
      }
    }
  }

  const coverage = {
    vectors: makeCoverage("vectors", covEntries),
  };
  for (const wp of WRITE_PATHS) coverage[`vectors:${wp}`] = makeCoverage(`vectors:${wp}`, covEntriesByPath[wp]);

  // `lowSignalUnion` was counted one record at a time over the records actually
  // read, so `recordsMeasured` is the only denominator that matches it. Dividing
  // by `records` (the row count) would report a low-signal share against a
  // population the classifier never ran on — the same measured-numerator /
  // full-denominator blend the vector coverage had, in a metric that carries a
  // pinned baseline and therefore looks authoritative. Identical on a full read,
  // where the two denominators are the same number; `recordsUnread` is the
  // difference, published so the caveat is visible rather than inferred.
  const lowSignalRatio = recordsMeasured > 0 ? lowSignalUnion / recordsMeasured : 0;
  const lowSignal = {
    records: recordsMeasured,
    recordsUnread: Math.max(0, records - recordsMeasured),
    unionRecords: lowSignalUnion,
    ratio: lowSignalRatio,
    unionClasses: [...LOW_SIGNAL_UNION_CLASSES],
    perClass: lowSignalPerClass,
    baseline: checkLowSignalBaseline(lowSignalRatio, {
      comparable: truncatedStores === 0,
      why: `${recordsMeasured} of ${records} records were read across ` +
        `${truncatedStores} truncated store(s)`,
    }),
  };

  const heat = {
    scenes,
    values: heatValues,
    buckets: heatBuckets,
    observedMin: observedMinHeat === null ? 0 : observedMinHeat,
    observedMax: observedMaxHeat === null ? 0 : observedMaxHeat,
    readerFirstFlameAt: HEAT_SCALE.READER_FIRST_FLAME_AT,
    // With the reader's ladder starting at 50 and nothing written above 5, this is
    // 0 for every scene in the store — the dead cue the gap reports.
    scenesWithACue: Object.entries(heatValues)
      .filter(([h]) => Number(h) >= HEAT_SCALE.READER_FIRST_FLAME_AT)
      .reduce((a, [, n]) => a + n, 0),
    staleHot,
    lowSignal,
  };

  const persona = summarisePersona(root && root.persona, { tier0MaxChars });
  // The hybrid persona's second half: the CURRENT project's `<project-doctrine>`
  // (SOPs / anti-patterns, injected once at SessionStart for this repo only).
  // Projected through the SAME projection as the global persona so the two are
  // directly comparable; `unmeasured` when there is no current project (a
  // global-only view), never an error. See extract.projectDoctrine.
  const projectDoctrine = summarisePersona(root && root.projectDoctrine, { tier0MaxChars });

  // Upgrade nudges: activation hints for latent post-0.7.0 features (over-budget or
  // secret-bearing global persona, a project with atoms but no doctrine, memories
  // with no persona to rebuild from). Computed by doctor.buildUpgradeNudges from the
  // RAW persona texts extract already carries (`.text`; empty string when absent, an
  // absence is not a finding) and the per-store atom counts already summarised here.
  // `maxChars` is the same tier-0 budget the projection uses — persona-max-tokens ×
  // CHARS_PER_TOKEN, default when unset — mirroring cli.js cmdDoctor.
  const currentSlug = root && root.currentSlug;
  const globalStoreForNudges = stores.find((s) => s.scope === SCOPE.GLOBAL || s.slug === "global");
  const projectStoreForNudges = currentSlug ? stores.find((s) => s.slug === currentSlug) : null;
  const atomCount = (s) => (s && typeof s.records === "number" ? s.records : 0);
  const upgradeNudges = buildUpgradeNudges({
    globalPersona: (root && root.persona && root.persona.text) || "",
    projectPersona: (root && root.projectDoctrine && root.projectDoctrine.text) || "",
    globalAtomCount: atomCount(globalStoreForNudges),
    projectAtomCount: atomCount(projectStoreForNudges),
  }, { maxChars: tier0MaxChars });

  const recallUsage = buildRecallUsage(root && root.recallLog, now);
  const gaps = buildGaps({ stores, persona, state, config, captureState, heat });

  const gapsBySeverity = zeroMap(Object.values(SEVERITY));
  let unmeasuredGaps = 0;
  for (const g of gaps) {
    if (g.unmeasured) unmeasuredGaps += 1;
    else gapsBySeverity[g.severity] += 1;
  }

  const totals = {
    stores: stores.length,
    readableStores,
    erroredStores,
    records,
    // The denominator for every per-record count in this object (byType,
    // byWritePath, lowSignal, duplicates, contentLength). Equal to `records`
    // unless `truncatedStores > 0`; a consumer computing a share must divide by
    // this one, and can now tell the difference instead of assuming it away.
    recordsMeasured,
    truncatedStores,
    scenes,
    sizeBytes,
    byType,
    byWritePath,
    coverage,
    vectorStates,
    vectorStateSlugs,
    vectorStateRecords,
    missingByMonth,
    lowSignal,
    duplicates,
    duplicateGroups: duplicateGroupCount,
    heat: { values: heatValues, buckets: heatBuckets, observedMin: heat.observedMin, observedMax: heat.observedMax, scenesWithACue: heat.scenesWithACue },
    // Summed over the PER-PROJECT nav blocks, not over one block: each project
    // renders its own `<scene-navigation>` and no session ever sees two of them.
    // See sceneNavVisibility(). The quantifiers are in the names because the
    // docstring version of this warning did not stop "77 reachable somewhere"
    // being rendered as "one block shows 77 lines" (it shows about five).
    scenesReachableInSomeNav,
    scenesUnreachableInEveryNav,
    scenesNavUnmeasured,
    scenesNavUnmeasuredReason,
    navBudgetChars,
    gapsBySeverity,
    unmeasuredGaps,
  };

  // Sorted for the UI: global first (it is the cross-project store, so it anchors
  // the list), then by size descending.
  const sorted = stores.slice().sort((a, b) =>
    (a.scope === SCOPE.GLOBAL ? 0 : 1) - (b.scope === SCOPE.GLOBAL ? 0 : 1) ||
    (b.records ?? -1) - (a.records ?? -1) ||
    a.slug.localeCompare(b.slug));

  const transformMs = Number(process.hrtime.bigint() - t0) / 1e6;

  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: computeSnapshotId(stores, root && root.persona),
    generatedAt: new Date(now).toISOString(),
    rootDir: (root && root.rootDir) || "",
    totals,
    stores: sorted,
    persona,
    // A distinct document from `persona`: the per-project doctrine. Deliberately
    // NOT folded into computeSnapshotId — like recallUsage, it rides along as an
    // additive field and must not churn the snapshot identity.
    projectDoctrine,
    // Activation hints (strings) from doctor.buildUpgradeNudges; `[]` when a store
    // is already in the new shape. Additive, and out of computeSnapshotId.
    upgradeNudges,
    // The behavioural overlay: which memories recall actually injected, folded per
    // record_id. Deliberately NOT part of computeSnapshotId — the log grows on
    // every recall and is not in the watcher's fingerprint, so it must never churn
    // the snapshot identity. It rides along as an additive, optional field.
    recallUsage,
    gaps,
    health: { state, config, captureState },
    timing: { extractMs, transformMs },
  };
}

/* ------------------------------------------------------------------ *
 * 11. Record rows  (serve.js /api/store/:slug/records)
 * ------------------------------------------------------------------ */

/**
 * One {@link RecordRow} per L1 record of a store.
 *
 * Built here rather than in serve.js so the row-level low-signal labels and
 * duplicate groups are produced by the SAME classifier that produced the totals.
 * A second implementation in the HTTP layer is exactly how a table stops agreeing
 * with the headline above it.
 *
 * `hasVector` is `null` — never `false` — when the store's vector reading was not
 * `ok`. serve.js filters on that distinction.
 *
 * @param {import("./contract.js").StoreExtract} storeExtract
 * @returns {import("./contract.js").RecordRow[]}
 */
/* ------------------------------------------------------------------ *
 * Recall usage overlay
 *
 * The recall_log is the ONLY behavioural signal this system has: which memories
 * recall actually injected, and which it dropped for the char budget. Folded onto
 * records it turns a static store into a living map — a memory reads as hot (used,
 * recently), warm (used), or dead (a repeated candidate the budget keeps
 * discarding). "Never a candidate" is left as `null` (no dot), NOT dead: an atom
 * the index never surfaced is a different failure from one recall chose to drop.
 *
 * Co-recall links use LIFT (co ÷ chance), never raw co-count. Raw co-count is
 * dominated by the always-on persona line that rides every recall, producing one
 * degenerate blob; lift divides that out and surfaces the real topical bonds.
 * ------------------------------------------------------------------ */

const RECALL_HEAT = Object.freeze({
  HOT_MIN_RECALLS: 3,    // used at least this often …
  HOT_RECENCY_DAYS: 3,   // … and within this window → hot
  RELATED_MIN_CO: 2,     // a single co-recall is noise, not a bond
  RELATED_TOP_N: 3,      // keep the strongest few links per atom
});

/** recalls===0 means dropped-only (a candidate that never fit); it is dead, not unseen. */
function recallBucket(recalls, ageInDays) {
  if (recalls === 0) return "dead";
  if (recalls >= RECALL_HEAT.HOT_MIN_RECALLS && ageInDays !== null && ageInDays <= RECALL_HEAT.HOT_RECENCY_DAYS) {
    return "hot";
  }
  return "warm";
}

/**
 * Fold the recall_log entries into a per-record usage map + co-recall lift links.
 * Pure: everything comes from the entries and the injected `now`.
 *
 * @param {import("./contract.js").RecallLogRead} recallLog
 * @param {number} now  epoch ms, the same clock transformRoot stamps with
 * @returns {import("./contract.js").Source<Object>}
 */
function buildRecallUsage(recallLog, now) {
  if (!recallLog || recallLog.status !== STATUS.OK || !Array.isArray(recallLog.entries)) {
    const reason = (recallLog && recallLog.reason) || "recall log not read";
    return C.unmeasured(reason, { byId: null, recalls: null, recalledIds: null, candidateIds: null, window: null });
  }

  const stat = new Map();  // id -> { recalls, drops, lastAtMs }
  const co = new Map();    // "a b" -> co-count
  let coUniverse = 0;      // entries with >=1 injected id (the chance denominator)
  let firstAtMs = null;
  let lastAtMs = null;

  const slotFor = (id) => {
    let s = stat.get(id);
    if (!s) { s = { recalls: 0, drops: 0, lastAtMs: null }; stat.set(id, s); }
    return s;
  };

  for (const e of recallLog.entries) {
    const parsed = e.at ? Date.parse(e.at) : NaN;
    const atMs = Number.isFinite(parsed) ? parsed : null;
    if (atMs !== null) {
      firstAtMs = firstAtMs === null ? atMs : Math.min(firstAtMs, atMs);
      lastAtMs = lastAtMs === null ? atMs : Math.max(lastAtMs, atMs);
    }
    const inj = [...new Set(e.injectedIds)];
    for (const id of new Set(e.droppedIds)) slotFor(id).drops += 1;
    for (const id of inj) {
      const s = slotFor(id);
      s.recalls += 1;
      if (atMs !== null) s.lastAtMs = s.lastAtMs === null ? atMs : Math.max(s.lastAtMs, atMs);
    }
    if (inj.length) {
      coUniverse += 1;
      for (let i = 0; i < inj.length; i++) {
        for (let j = i + 1; j < inj.length; j++) {
          const key = inj[i] < inj[j] ? `${inj[i]} ${inj[j]}` : `${inj[j]} ${inj[i]}`;
          co.set(key, (co.get(key) || 0) + 1);
        }
      }
    }
  }

  const relatedBy = new Map();  // id -> [{ id, lift, co }]
  if (coUniverse > 0) {
    for (const [key, c] of co) {
      if (c < RECALL_HEAT.RELATED_MIN_CO) continue;
      const [a, b] = key.split(" ");
      const ra = stat.get(a).recalls;
      const rb = stat.get(b).recalls;
      if (!ra || !rb) continue;
      const lift = (c * coUniverse) / (ra * rb);
      if (lift <= 1) continue;  // at-or-below chance is not a bond
      for (const [x, y] of [[a, b], [b, a]]) {
        if (!relatedBy.has(x)) relatedBy.set(x, []);
        relatedBy.get(x).push({ id: y, lift, co: c });
      }
    }
    for (const arr of relatedBy.values()) {
      arr.sort((p, q) => q.lift - p.lift);
      arr.length = Math.min(arr.length, RECALL_HEAT.RELATED_TOP_N);
    }
  }

  const byId = {};
  let recalledIds = 0;
  for (const [id, s] of stat) {
    if (s.recalls > 0) recalledIds += 1;
    const ageInDays = s.lastAtMs === null ? null : (now - s.lastAtMs) / MS_PER_DAY;
    byId[id] = {
      recalls: s.recalls,
      drops: s.drops,
      lastRecalledAt: s.lastAtMs === null ? null : new Date(s.lastAtMs).toISOString(),
      bucket: recallBucket(s.recalls, ageInDays),
      related: relatedBy.get(id) || [],
    };
  }

  return C.ok({
    byId,
    recalls: recallLog.entries.length,
    recalledIds,
    candidateIds: stat.size,
    window: {
      firstAt: firstAtMs === null ? null : new Date(firstAtMs).toISOString(),
      lastAt: lastAtMs === null ? null : new Date(lastAtMs).toISOString(),
    },
  });
}

function buildRecordRows(storeExtract, snapshot) {
  const rd = (storeExtract && storeExtract.records) || null;
  if (!rd || rd.status !== STATUS.OK || !Array.isArray(rd.records)) return [];

  const vr = (storeExtract && storeExtract.vectors) || null;
  const vecIds = vr && vr.status === STATUS.OK && vr.recordIds ? vr.recordIds : null;
  const usageById = snapshot && snapshot.recallUsage && snapshot.recallUsage.status === STATUS.OK
    ? snapshot.recallUsage.byId
    : null;
  const { groupIndexById } = duplicateGroups(rd.records, exactKey);

  return rd.records.map((r) => ({
    id: r.record_id,
    content: r.content,
    chars: (r.content || "").length,
    type: r.type,
    priority: r.priority,
    scene: r.scene_name,
    createdAt: r.created_time,
    updatedAt: r.updated_time,
    writePath: writePathForRecordId(r.record_id),
    hasVector: vecIds ? vecIds.has(r.record_id) : null,
    lowSignal: classifyLowSignal(r.content),
    duplicateGroup: groupIndexById.has(r.record_id) ? groupIndexById.get(r.record_id) : -1,
    // null = never a candidate in-window (no dot); an object = measured behaviour.
    usage: usageById && usageById[r.record_id] ? usageById[r.record_id] : null,
  }));
}

/* ------------------------------------------------------------------ *
 * L2 -> L1 backbone (DERIVED, not stored)
 *
 * `scene_name` on a record is the literal "auto-capture" ~96% of the time and
 * matches no scene file — the stored link is dead (see the note at duplicate-
 * groups). So which atoms belong under which scene is DERIVED here by keyword
 * overlap between the atom's content and the scene's name+summary, and the UI
 * labels it "approx — derived, not stored". A cheaper, honest signal than
 * embeddings, and unlike them it works on every store, not just the 4 that carry
 * vectors. An atom under no scene is left UNLINKED, never forced under a weak
 * match: a wrong parent is a worse lie than an orphan.
 * ------------------------------------------------------------------ */

const TREE = Object.freeze({ MIN_OVERLAP: 2 });

// Words too common to carry topic: they would link everything to everything, the
// same degeneracy raw co-count has. Kept small and generic on purpose.
const TREE_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "not", "but", "you",
  "your", "user", "when", "what", "which", "then", "than", "over", "under", "onto",
  "are", "was", "were", "has", "have", "had", "its", "it's", "use", "used", "using",
  "via", "per", "all", "any", "one", "two", "run", "runs", "get", "set", "new",
]);

function keywordSet(text) {
  const out = new Set();
  for (const tok of String(text == null ? "" : text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 3 && !TREE_STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

/**
 * One store's L2->L1 tree: scenes with the atoms keyword-overlap assigns to them,
 * plus the atoms that matched no scene. Reuses buildRecordRows, so every atom
 * already carries its usage overlay, low-signal class and vector status.
 *
 * @param {import("./contract.js").StoreExtract} storeExtract
 * @param {Object} [snapshot]  carries recallUsage for the overlay
 */
function buildStoreTree(storeExtract, snapshot) {
  const rd = (storeExtract && storeExtract.records) || null;
  if (!rd || rd.status !== STATUS.OK || !Array.isArray(rd.records)) {
    return {
      status: (rd && rd.status) || STATUS.UNMEASURED,
      reason: (rd && rd.reason) || "records not read",
      scenes: [], unlinked: [], derivation: null, minOverlap: TREE.MIN_OVERLAP,
      totalAtoms: null, linkedAtoms: null,
    };
  }
  const rows = buildRecordRows(storeExtract, snapshot);
  const sc = (storeExtract && storeExtract.scenes) || null;
  const scenes = sc && sc.status === STATUS.OK && Array.isArray(sc.scenes) ? sc.scenes : [];
  // A scene's keywords come from its slug name (rich: "tmem-doctor-memory-health")
  // AND its one-line summary. Body text is not loaded by extract, by design.
  const sceneKW = scenes.map((s) => keywordSet(`${String(s.name).replace(/-/g, " ")} ${s.summary || ""}`));
  const buckets = scenes.map((s) => ({ name: s.name, summary: s.summary, heat: s.heat, updated: s.updated, atoms: [] }));
  const unlinked = [];

  for (const row of rows) {
    const akw = keywordSet(row.content);
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < sceneKW.length; i++) {
      let score = 0;
      for (const w of sceneKW[i]) if (akw.has(w)) score += 1;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0 && bestScore >= TREE.MIN_OVERLAP) buckets[best].atoms.push({ ...row, match: bestScore });
    else unlinked.push(row);
  }

  // Heaviest-used atoms first inside a scene, so the tree opens on what matters.
  const byUse = (a, b) => ((b.usage ? b.usage.recalls : -1) - (a.usage ? a.usage.recalls : -1)) || (b.chars - a.chars);
  for (const b of buckets) b.atoms.sort(byUse);
  unlinked.sort(byUse);
  // Fullest scenes first; a scene the overlay never populated sinks to the bottom.
  buckets.sort((a, b) => b.atoms.length - a.atoms.length || (b.heat || 0) - (a.heat || 0));

  const linkedAtoms = rows.length - unlinked.length;
  return {
    status: STATUS.OK, reason: null,
    scenes: buckets, unlinked,
    derivation: "keyword-overlap", minOverlap: TREE.MIN_OVERLAP,
    totalAtoms: rows.length, linkedAtoms,
  };
}

/* ------------------------------------------------------------------ *
 * CLI — a self-check, not a product surface.
 * `node scripts/view/transform.js` runs the live extract once and prints the
 * numbers the definition-of-done asks for. This is the only place in the file
 * that touches extract.js, and it is behind `require.main`, so importing this
 * module never pulls in I/O.
 * ------------------------------------------------------------------ */
function main() {
  const { extractAll } = require("./extract.js");

  const e0 = process.hrtime.bigint();
  const root = extractAll();
  const extractMs = Number(process.hrtime.bigint() - e0) / 1e6;

  const t0 = process.hrtime.bigint();
  const snap = transformRoot(root, { extractMs });
  const transformMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const t = snap.totals;
  const cov = t.coverage.vectors;

  console.log(`snapshot        ${snap.snapshotId}`);
  console.log(`stores          ${t.stores} (${t.readableStores} readable, ${t.erroredStores} errored)`);
  console.log(`records         ${t.records}   scenes ${t.scenes}   ${(t.sizeBytes / 1e6).toFixed(1)} MB`);
  if (t.truncatedStores > 0) {
    console.log(`                READ TRUNCATED: per-record figures below cover ${t.recordsMeasured} of ` +
      `${t.records} rows, across ${t.truncatedStores} capped store(s)`);
  }
  console.log("");
  console.log(`vector coverage ${cov.covered}/${cov.measuredRecords} = ${pct(cov.ratio)} over ${cov.measuredStores} measured stores`);
  console.log(`                excluded: ${cov.unmeasuredStores} unmeasured stores holding ${cov.unmeasuredRecords} records (partial=${cov.partial})`);
  for (const wp of WRITE_PATHS) {
    const c = t.coverage[`vectors:${wp}`];
    console.log(`                ${wp.padEnd(8)} ${c.covered}/${c.measuredRecords} = ${pct(c.ratio)}`);
  }
  console.log(`vector states   ${t.vectorStates.unmeasured} never set up (${t.vectorStateRecords.unmeasured} records) · ` +
    `${t.vectorStates.empty} set up and empty (${t.vectorStateRecords.empty} records) · ` +
    `${t.vectorStates.populated} working (${t.vectorStateRecords.populated} records)`);
  console.log(`                populated: ${t.vectorStateSlugs.populated.join(", ")}`);
  console.log("");
  const ls = t.lowSignal;
  console.log(`low-signal      ${ls.unionRecords}/${ls.records} union = ${pct(ls.ratio)}  ` +
    `(pinned ${pct(ls.baseline.pinned)}, delta ${ls.baseline.deltaPoints.toFixed(2)}pp, ` +
    `tolerance ${ls.baseline.tolerancePoints}pp)`);
  console.log("                validateLowSignalUnion: " + (
    ls.baseline.comparable === false ? `NOT COMPARABLE — ${ls.baseline.message}`
      : ls.baseline.withinTolerance ? "PASS"
        : `FAIL — ${ls.baseline.message}`));
  console.log(`                per class ${JSON.stringify(ls.perClass)}`);
  console.log(`duplicates      exact ${t.duplicates.exact} (${t.duplicateGroups.exact} groups) · ` +
    `normalised ${t.duplicates.normalised} (${t.duplicateGroups.normalised} groups)`);
  console.log("");
  console.log(`heat values     ${JSON.stringify(t.heat.values)}`);
  console.log(`heat buckets    ${JSON.stringify(t.heat.buckets)}`);
  console.log(`                observed ${t.heat.observedMin}-${t.heat.observedMax}, reader flames at ` +
    `${HEAT_SCALE.READER_FIRST_FLAME_AT} => ${t.heat.scenesWithACue} scenes ever rendered a flame`);
  console.log(`scene nav       ${t.scenesReachableInSomeNav} reachable in some project's nav / ` +
    `${t.scenesUnreachableInEveryNav} reachable in none ` +
    `(budget ${t.navBudgetChars} chars, summed over ${t.scenes ? "per-project blocks" : "no blocks"} — ` +
    "one block holds ~5 lines)");
  if (t.scenesNavUnmeasured > 0) {
    console.log(`                ${t.scenesNavUnmeasured} scenes excluded as unmeasurable: ` +
      t.scenesNavUnmeasuredReason);
  }
  console.log("");
  const pj = snap.persona.projection;
  if (pj) {
    console.log(`persona         ${pj.totalBullets} bullets, ${pj.totalChars} chars, duties ${JSON.stringify(snap.persona.duties)}`);
    console.log(`  byTier        ${JSON.stringify(pj.byTier)}   (bullet counts)`);
    console.log(`  byTierChars   ${JSON.stringify(pj.byTierChars)}`);
    console.log(`  delivered     ${pj.injectedChars} chars/turn (tier-1 ${pj.tier1Chars}/${pj.tier1BudgetChars}), ` +
      `${pj.tier0Chars}/${pj.tier0BudgetChars} once/session; ${pj.droppedAlwaysDuties} always-duty bullets reach nothing`);
    console.log(`  legacy        ${pj.legacy.chars} of ${pj.legacy.totalChars} chars = ${pct(pj.legacy.ratio)}, from ` +
      `${pj.legacy.sections.map((s) => `${s.name} (${s.lines})`).join(", ") || "no section"}`);
  }
  console.log("");
  console.log(`gaps            ${snap.gaps.length} (${JSON.stringify(t.gapsBySeverity)}, unmeasured ${t.unmeasuredGaps})`);
  for (const g of snap.gaps) {
    console.log(`  [${g.unmeasured ? "unmeasured" : g.severity.padEnd(8)}] ${g.kind}  ${g.title}`);
  }
  console.log("");
  console.log(`timing          extract ${extractMs.toFixed(1)} ms · transform ${transformMs.toFixed(1)} ms`);
}

if (require.main === module) main();

module.exports = {
  // entry points
  transformRoot,
  buildRecordRows,
  // per-part builders, exported so a fixture test can pin one metric at a time
  summariseStore,
  summariseScenes,
  summarisePersona,
  buildRecallUsage,
  recallBucket,
  RECALL_HEAT,
  buildStoreTree,
  keywordSet,
  buildGaps,
  // Re-exported (not re-implemented) so the health screen and `tmem doctor` share
  // one definition; the test pins this identity.
  buildUpgradeNudges,
  computeSnapshotId,
  // pure primitives
  classifyLowSignal,
  isLowSignalUnion,
  checkLowSignalBaseline,
  exactKey,
  normalisedKey,
  duplicateGroups,
  quantiles,
  heatBucketKey,
  readerHeatEmoji,
  sceneNavVisibility,
  vectorStateFor,
  // vocabulary this module adds on top of the contract
  VECTOR_STATE,
  VECTOR_STATES,
  SCENE_NAV,
};
