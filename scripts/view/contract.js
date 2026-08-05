#!/usr/bin/env node
/**
 * Shared contract for `tmem view` (live read-only memory visualiser).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The visualiser is split ETL-style across three independent modules —
 * extract.js (I/O, read-only SQLite + fs), transform.js (pure), serve.js
 * (HTTP + SSE) — plus one external consumer, `cli.js`'s `cmdViewSnapshot`,
 * which runs extract → transform for the one-shot `tmem view --snapshot`
 * payload. (An earlier plan gave that job to a `dump.js` in this directory; it
 * was never written, and the responsibility landed in the CLI instead. The
 * contract is the same either way — which is the point.) Modules that
 * never import each other still have to agree, field-for-field, on what a
 * "store" or a "gap" is. This file is that agreement: every shape crossing a
 * module boundary is declared here once, so a rename is a compile-time-ish
 * change in one place rather than a silent mismatch discovered in the browser.
 *
 * The harder reason is measurement honesty. During the audit that motivated
 * the visualiser, a store whose `sqlite-vec` extension failed to load reported
 * "0 vectors". Nothing in the payload distinguished that from a store that
 * genuinely had no vectors, so it was averaged into a coverage percentage and
 * produced a false alarm — twice. The lesson: **a zero can mean unmeasured,
 * not clean.** So every value that came from a fallible read is wrapped in a
 * {@link Source} carrying `status`, and aggregates are shaped so that blending
 * measured with unmeasured data is not merely discouraged but *inexpressible*:
 * a percentage only ever lives inside a {@link Coverage}, a Coverage is only
 * ever built from stores whose measurement succeeded, and it must carry the
 * count of stores/records it had to leave out. {@link validateCoverage} exists
 * because that invariant is exactly the kind that fails silently.
 *
 * Nothing here does I/O. Nothing here computes a metric. It declares types,
 * names, thresholds and a handful of constructors/validators — the vocabulary.
 *
 * The one import: `scripts/constants.js`, a true leaf that requires nothing.
 * Two of the values declared below — the low-signal class list and its
 * thresholds — are also read by the Stop hook's capture path, which cannot
 * afford to load this file to get them. Their VALUES live in the leaf and are
 * re-exported here unchanged, so this module stays the place their meaning is
 * documented and every existing `require("./contract.js")` keeps working.
 */
"use strict";

const { LOW_SIGNAL, LOW_SIGNAL_CLASSES } = require("../constants.js");

/**
 * Version of the *meaning* of everything in this file, not just its shape.
 *
 * It is embedded in every snapshotId (`s${SCHEMA_VERSION}-…`, see
 * {@link SNAPSHOT_ID_SPEC}) and in every API envelope, so a persisted snapshot
 * can always be told apart from one produced by code that judges it differently.
 * Bump it whenever a field is added or removed, a threshold moves, or a gap kind
 * appears or disappears — an old file that keeps the old number then reads as
 * "computed under other rules" instead of silently masquerading as current.
 *
 * History:
 *   1 — initial contract.
 *   2 — HEAT_SCALE.READER_FIRST_FLAME_AT 50 -> 4; gap kinds SCENE_ORPHANED and
 *       SCENE_DANGLING removed; SceneStats gained navStatus/navReason (`global`
 *       is `unmeasured`, not zero); Totals gained fields.
 *   3 — Totals.scenesVisibleInNav / scenesInvisibleInNav renamed to
 *       scenesReachableInSomeNav / scenesUnreachableInEveryNav. The old names
 *       read as "visible in THE nav block" and were duly rendered as one block's
 *       contents in the UI, which the sum is not; the quantifier now lives in the
 *       name instead of in a docstring nobody reads at the call site.
 *       Totals.scenesNavUnmeasuredReasons (string[]) became
 *       scenesNavUnmeasuredReason (string|null): the array was a de-duplicated
 *       set of copies of one constant.
 *   4 — Hybrid persona (0.7.0). RootExtract and Snapshot gained `projectDoctrine`
 *       (a {@link PersonaRead}/{@link PersonaSummary}): the CURRENT project's
 *       `<project-doctrine>`, read parallel to the cross-project global `persona`.
 *   5 — Snapshot gained `upgradeNudges` (string[]): doctor.buildUpgradeNudges'
 *       activation hints, surfaced on the health screen. RootExtract gained
 *       `currentSlug` (the resolved current-project slug) to feed them.
 */
const SCHEMA_VERSION = 5;

/* ------------------------------------------------------------------ *
 * 1. Status + Source
 * ------------------------------------------------------------------ */

/**
 * Measurement status of a single reading.
 *
 * - `ok`         — the read succeeded. The payload is trustworthy, including a zero.
 * - `unmeasured` — the read was not attempted, or the capability needed to make it
 *                  is absent (no vectors.db, sqlite-vec did not load, file missing
 *                  by design). NOT an error, and emphatically NOT zero. Payload
 *                  numerics MUST be `null`, never 0.
 * - `error`      — the read was attempted and failed (corrupt db, EACCES, parse
 *                  failure). Payload numerics MUST be `null`. `reason` is required.
 *
 * Rule of thumb used throughout: `ok` may be counted, the other two may only be
 * *reported*. See {@link isMeasured}.
 * @typedef {"ok"|"unmeasured"|"error"} Status
 */
const STATUS = Object.freeze({
  OK: "ok",
  UNMEASURED: "unmeasured",
  ERROR: "error",
});

const STATUS_VALUES = Object.freeze([STATUS.OK, STATUS.UNMEASURED, STATUS.ERROR]);

/**
 * A value plus its provenance. Every extract reader returns one of these; the
 * payload fields are spread onto the object so consumers read `src.records`
 * rather than `src.value.records`, but `status` / `reason` are always present.
 *
 * @typedef {Object} SourceMeta
 * @property {Status} status
 * @property {string|null} reason  Human-readable cause. Required when status is
 *   `error` or `unmeasured`; `null` when `ok`. Shown verbatim in the UI, so it
 *   should name the thing that failed ("sqlite-vec extension failed to load"),
 *   not a stack trace.
 */

/**
 * @template T
 * @typedef {SourceMeta & T} Source
 */

/**
 * Build a Source. Throws on the two mistakes that would reintroduce the
 * original bug: an unmeasured/error source without a reason, and an
 * unmeasured/error source carrying a numeric payload (which downstream code
 * would happily average).
 *
 * @param {Status} status
 * @param {Object} [payload]  Fields merged onto the result.
 * @param {string|null} [reason]
 * @returns {Source<any>}
 */
function source(status, payload = {}, reason = null) {
  if (!STATUS_VALUES.includes(status)) {
    throw new TypeError(`source(): unknown status ${JSON.stringify(status)}`);
  }
  if (status !== STATUS.OK && !reason) {
    throw new TypeError(`source(): status "${status}" requires a reason`);
  }
  if (status !== STATUS.OK) {
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === "number") {
        throw new TypeError(
          `source(): non-ok status "${status}" must not carry numeric field "${k}" ` +
          `(= ${v}); use null — a number here is how "unmeasured" becomes "zero"`
        );
      }
    }
  }
  return { status, reason: status === STATUS.OK ? null : reason, ...payload };
}

/** @param {Object} [payload] */
const ok = (payload = {}) => source(STATUS.OK, payload);
/** @param {string} reason @param {Object} [payload] */
const unmeasured = (reason, payload = {}) => source(STATUS.UNMEASURED, payload, reason);
/** @param {string|Error} reason @param {Object} [payload] */
const errored = (reason, payload = {}) =>
  source(STATUS.ERROR, payload, reason instanceof Error ? reason.message : String(reason));

/**
 * True only for `ok`. A convenience predicate — NOT the thing that keeps this
 * module honest.
 *
 * It used to be described as "the single gate every aggregate must pass values
 * through", which overstated it in a way worth correcting: a gate you have to
 * remember to call is a convention wearing an invariant's clothes. The real
 * enforcement is in the constructors, because you cannot build the value without
 * going through them — {@link source} refuses to let a non-ok status carry a
 * number, {@link makeCoverage} refuses a measured entry with no `covered` (and a
 * record count that is not a number), {@link gap} refuses an unmeasured finding
 * marked critical. Those cannot be forgotten.
 *
 * Nor would routing transform's ~20 status checks through this help much: every
 * one of them BRANCHES on the answer, and the interesting half is the else —
 * building the `unmeasured` with a reason that names what was missing. A boolean
 * makes the question uniform and leaves the answer exactly as hand-written.
 */
function isMeasured(src) {
  return !!src && src.status === STATUS.OK;
}

/**
 * Throws if `src` is not a well-formed Source.
 *
 * A test-time and boundary validator, like {@link validateCoverage}: it catches a
 * malformed value that was built without the constructors, at the edge where it
 * enters or leaves a module. It is not a substitute for building the value
 * correctly, and nothing in the pipeline depends on it having been called.
 */
function validateSource(src, label = "source") {
  if (!src || typeof src !== "object") throw new TypeError(`${label}: not an object`);
  if (!STATUS_VALUES.includes(src.status)) throw new TypeError(`${label}: bad status ${src.status}`);
  if (src.status !== STATUS.OK && !src.reason) throw new TypeError(`${label}: missing reason`);
  return src;
}

/* ------------------------------------------------------------------ *
 * 2. Domain vocabulary (shared constants)
 * ------------------------------------------------------------------ */

/** Store scope. `global` is the single `global/` store; `project` is `projects/<slug>/`. */
const SCOPE = Object.freeze({ GLOBAL: "global", PROJECT: "project" });

/**
 * L1 record `type` column values in circulation. Anything else is bucketed
 * under `OTHER` rather than dropped — the column is free-text, and a type we
 * have not seen is information, not noise.
 */
const RECORD_TYPES = Object.freeze(["persona", "episodic", "instruction", "semantic", "other"]);
const RECORD_TYPE_OTHER = "other";

/**
 * Write path, inferred from the record_id prefix (see memory_auto_capture.js
 * `ac_${ts}_${rand}` vs memory_writer.js `m_${ts}_${rand}`).
 *
 * - `auto`    — `ac_` : Stop-hook auto-capture, fire-and-forget, unawaited.
 * - `awaited` — `m_`  : CLI / writer path, the caller waited for the write.
 * - `unknown` — anything else (hand-inserted, migrated, contrib importer).
 *
 * Worth splitting because the two paths have historically diverged on vector
 * coverage: the unawaited path can lose its embedding follow-up.
 */
const WRITE_PATH = Object.freeze({ AUTO: "auto", AWAITED: "awaited", UNKNOWN: "unknown" });
const WRITE_PATHS = Object.freeze([WRITE_PATH.AUTO, WRITE_PATH.AWAITED, WRITE_PATH.UNKNOWN]);

/** Pure id -> write path. Defined here so extract, transform and dump cannot disagree. */
function writePathForRecordId(recordId) {
  const id = String(recordId || "");
  if (id.startsWith("ac_")) return WRITE_PATH.AUTO;
  if (id.startsWith("m_")) return WRITE_PATH.AWAITED;
  return WRITE_PATH.UNKNOWN;
}

/** Quantiles reported for content length, in this order. */
const QUANTILES = Object.freeze(["min", "p50", "p75", "p90", "p95", "p99", "max"]);

/**
 * Low-signal classes — calibrated against the real store (2111/5467 = 38.6%
 * low-signal), NOT against generic text-quality intuition.
 *
 * That distinction is the whole point. The pollution here is *structural*: it is
 * machine-generated text that is long, well-formed, alphabetic and correctly
 * scened, so every classic "short / empty / no letters" filter passes it
 * through. The worst single offender is a `<task-notification>` block repeated
 * 96 times in one store at ~200 chars each. A taxonomy that cannot see that is
 * decorative.
 *
 * - `taskNotification` — starts with `<task-notification>`. Sub-agent completion
 *   notices the Stop hook swept up as if they were user turns. 1356 records.
 * - `skillEcho`        — starts with `base directory for this skill:`. The echo a
 *   skill invocation prints; captured once per invocation. 366 records.
 * - `slashOrTag`       — content starts with `/` or `<`. Slash commands and stray
 *   XML-ish blocks: control plane, not conversation. Superset of the two classes
 *   above, kept because it also catches the long tail. 1372 records.
 * - `continuation`     — < {@link LOW_SIGNAL.CONTINUATION_MAX_CHARS} chars and opens
 *   with an assent token ({@link LOW_SIGNAL.CONTINUATION_OPENERS}, EN + VI). "ok",
 *   "tiếp", "continue" carry no recallable content. 43 records.
 * - `pasteDump`        — >= {@link LOW_SIGNAL.PASTE_DUMP_MIN_CHARS} chars, i.e. the
 *   record hit `MAX_CONTENT_LENGTH = 500` in memory_auto_capture.js and was
 *   truncated mid-thought by `truncate()`. The atom is a fragment of a paste, so
 *   its tail — usually the actual point — is gone. 1685 records, the largest class.
 * - `empty`            — content trimmed to length 0. Measured 0 occurrences, kept
 *   anyway: it costs nothing and a non-zero count would correctly signal a writer
 *   bug. Being always-zero is precisely why it is safe inside the union.
 *
 * Classes deliberately overlap (a truncated `<task-notification>` is three of
 * them), so per-class counts sum well above the number of low-signal records.
 * Report the union separately from the per-class breakdown.
 *
 * DELIBERATELY ABSENT — three classes rejected because they flag volume, not noise:
 *   `defaultPriority` — autoCapture() hardcodes `priority: 50` for every record it
 *     writes (memory_auto_capture.js:184), so it would flag 5037/5467 = 92% of the
 *     store. A class that fires on almost everything separates nothing.
 *   `sceneless` — autoCapture() likewise hardcodes `scene_name: "auto-capture"`
 *     (:185), so the field is never empty on the records that dominate the corpus.
 *   `tooShort` (< 40 chars) — the same mistake at smaller scale: 948 records (17%),
 *     which alone moved the union from 38.6% to 55.3%. **Short is not noise.**
 *     Real records under 40 chars in this store include `push -> create pr`,
 *     `fix the recall budget bug`, `tạo agent riêng review change cái đi`. This is
 *     exactly why `continuation` requires BOTH a length bound AND an assent-token
 *     opener — shortness on its own was evaluated during the audit and rejected as
 *     a signal. Do not reintroduce it as a bare length threshold.
 *
 * The list itself is declared in `scripts/constants.js` and re-exported from
 * here: the write-side gate reads it on every captured turn and must not pay for
 * this file to do so. The reasoning above is the reason it stays documented here.
 */

/**
 * The subset of {@link LOW_SIGNAL_CLASSES} whose union is the headline
 * low-signal percentage.
 *
 * WHY THIS IS A SEPARATE LIST. That union is the metric the before/after
 * acceptance comparison is judged on, and it is pinned to a baseline the audit
 * already published ({@link LOW_SIGNAL_BASELINE}: 38.6%). If a later agent adds
 * an exploratory class to LOW_SIGNAL_CLASSES and the union silently absorbs it,
 * the headline moves for a reason unrelated to any cleanup — and the visualiser
 * ends up contradicting the very audit it exists to verify. Adding `tooShort`
 * did exactly that: 38.6% -> 55.3%, with nothing about the store having changed.
 *
 * So: new classes are welcome in LOW_SIGNAL_CLASSES and will be reported
 * per-class, but they stay OUT of this list unless the baseline is re-pinned in
 * the same change. {@link validateLowSignalUnion} enforces the membership rule;
 * re-pinning is a deliberate edit to LOW_SIGNAL_BASELINE, not an accident.
 */
const LOW_SIGNAL_UNION_CLASSES = Object.freeze([
  "taskNotification", "skillEcho", "slashOrTag", "continuation", "pasteDump", "empty",
]);

/**
 * Pinned audit baseline for the union, so a drift is visible as a number rather
 * than inferred. Measured on the store as it stood at audit time; the live store
 * grows, so compare RATIOS (within {@link LOW_SIGNAL_BASELINE.TOLERANCE}), never
 * absolute counts.
 */
const LOW_SIGNAL_BASELINE = Object.freeze({
  records: 5467,
  unionRecords: 2111,
  ratio: 2111 / 5467, // 0.3861
  TOLERANCE: 0.02,
  measuredAt: "audit",
  perClass: Object.freeze({
    pasteDump: 1685, slashOrTag: 1372, taskNotification: 1356, skillEcho: 366,
    continuation: 43, empty: 0,
  }),
});

/**
 * Guards the headline metric against silent redefinition. Call wherever the
 * union is computed.
 *
 * @param {string[]} unionClasses  Classes actually folded into the union.
 * @param {number} [ratio]         Computed union ratio; checked against the pin when given.
 */
function validateLowSignalUnion(unionClasses, ratio = null) {
  const extra = unionClasses.filter((c) => !LOW_SIGNAL_UNION_CLASSES.includes(c));
  if (extra.length) {
    throw new RangeError(
      `low-signal union: class(es) ${extra.join(", ")} are not in LOW_SIGNAL_UNION_CLASSES — ` +
      `report them per-class instead, or re-pin LOW_SIGNAL_BASELINE in the same change`
    );
  }
  const missing = LOW_SIGNAL_UNION_CLASSES.filter((c) => !unionClasses.includes(c));
  if (missing.length) {
    throw new RangeError(`low-signal union: missing pinned class(es) ${missing.join(", ")}`);
  }
  if (ratio !== null && Math.abs(ratio - LOW_SIGNAL_BASELINE.ratio) > LOW_SIGNAL_BASELINE.TOLERANCE) {
    // Not necessarily a bug — a real cleanup SHOULD move this. But it must be
    // noticed and explained, never absorbed.
    throw new RangeError(
      `low-signal union ratio ${(ratio * 100).toFixed(1)}% drifted from the pinned ` +
      `baseline ${(LOW_SIGNAL_BASELINE.ratio * 100).toFixed(1)}% by more than ` +
      `${LOW_SIGNAL_BASELINE.TOLERANCE * 100}pp — re-pin LOW_SIGNAL_BASELINE if intended`
    );
  }
  return true;
}

/**
 * Classifier thresholds and prefixes ({@link LOW_SIGNAL}) are likewise declared in
 * `scripts/constants.js` and re-exported here, for the same reason and with the
 * same effect: shared verbatim by the classifier (`low_signal.js`, which
 * transform.js re-exports) and the UI legend, so the two cannot drift. The
 * derivation of `PASTE_DUMP_MIN_CHARS = 495` is documented beside the value.
 */

/**
 * Duplicate detection tiers. `exact` compares trimmed content verbatim;
 * `normalised` lowercases, collapses whitespace and strips trailing
 * punctuation. Both are reported — the gap between them is itself the finding.
 */
const DUPLICATE_TIERS = Object.freeze(["exact", "normalised"]);

/**
 * Scene heat buckets, on the 1–5 scale that is actually WRITTEN.
 *
 * Two scales exist in this codebase and they do not agree:
 *   - The writer's scale. The `memory-consolidate` skill instructs
 *     "Heat 4-5: active this week, 2-3: recent, 1: historical", and all 216
 *     scenes in the real store obey it: `{2: 9, 3: 30, 4: 50, 5: 127}`.
 *   - The reader's scale. `heatEmoji()` in scene_nav.js USED TO ladder at
 *     50/100/200/500/1000. Nothing has ever been written above 5, so that
 *     function had **never rendered a single flame for any scene** and the
 *     scene-navigation block shipped a cue that was dead code. R2 moved it onto
 *     the writer's scale — see READER_FIRST_FLAME_AT below.
 *
 * We calibrate to the writer, because that is where the data lives — mirroring
 * the old reader would have filed all 216 scenes as `cold` and made the lens's
 * heat encoding uniformly meaningless, which is the exact failure this tool
 * exists to catch. A residual mismatch (a store written entirely below the first
 * rung, or above the documented scale) is still reported as
 * {@link GAP_KIND.HEAT_SCALE_MISMATCH} rather than papered over.
 *
 * `min`/`max` both inclusive; `Infinity` on the top bucket absorbs any future
 * writer that adopts the larger scale. `flames` is this lens's own display cue
 * and is intentionally not sourced from `heatEmoji()`: the lens draws four
 * distinctions because it has the room, the reader draws two because every rung
 * costs per-turn context.
 */
const HEAT_BUCKETS = Object.freeze([
  Object.freeze({ key: "historical", min: 0, max: 1, flames: 0, label: "historical" }),
  Object.freeze({ key: "recent", min: 2, max: 3, flames: 1, label: "recent" }),
  Object.freeze({ key: "active", min: 4, max: 4, flames: 2, label: "active" }),
  Object.freeze({ key: "hot", min: 5, max: 5, flames: 3, label: "active this week" }),
  Object.freeze({ key: "offScale", min: 6, max: Infinity, flames: 3, label: "off-scale" }),
]);

/**
 * The scale the writer is documented to use. `offScale` above catches anything
 * outside it, and a non-empty `offScale` bucket is what triggers
 * {@link GAP_KIND.HEAT_SCALE_MISMATCH} from the writer's side; the reader's
 * ladder in scene_nav.js triggers it from the other side.
 *
 * READER_FIRST_FLAME_AT is where `scene_nav.heatEmoji()` renders its first
 * flame. It was 50 — above everything ever written, which is why the gap fired
 * on the whole store — and is now 4, the bottom of the documented "active this
 * week" band. It is declared HERE and not read off the ladder on purpose: two
 * independent statements are what let transform.js assert at load that the
 * reader and the contract still agree, and that assertion is the only thing
 * standing between a silently-drifted ladder and a gap that measures nothing.
 */
const HEAT_SCALE = Object.freeze({ MIN: 1, MAX: 5, READER_FIRST_FLAME_AT: 4 });

/**
 * "Stale hot": a scene the nav ladder still ranks near the top but whose file
 * has not been rewritten in a long time — heat without freshness is how the nav
 * budget gets spent on history. Note the contradiction this detects directly:
 * heat >= 4 is documented to mean "active this week", so an untouched-for-90-days
 * scene at heat 4+ is a claim the file's own mtime refutes.
 *
 * MIN_HEAT is on the writer's 1–5 scale ({@link HEAT_SCALE}), not heatEmoji()'s.
 */
const STALE_HOT = Object.freeze({ MIN_HEAT: 4, MAX_AGE_DAYS: 90 });

/**
 * Persona duty classes — what a persona bullet is *for*, which decides whether
 * it earns permanent context budget.
 *
 * - `always`      — must be in context every turn (identity, hard constraints,
 *                   "never do X"). Imperative or absolute phrasing.
 * - `conditional` — only matters in a situation ("when deploying...", "for VI prose...").
 * - `reference`   — background fact, worth retrieving on demand, not worth injecting.
 *
 * Classification is a transform-side heuristic; the vocabulary is fixed here.
 */
const DUTY_CLASSES = Object.freeze(["always", "conditional", "reference"]);

/**
 * Persona injection tiers — where a bullet actually lands at runtime.
 *
 * - `promptSummary` — what `memory_recall.getPersona()` injects on every
 *                     UserPromptSubmit: the TIER-1 projection (`projectTier1`,
 *                     ~420 chars), which is query-matched and scored, plus an
 *                     insurance line. It is not "the first bullets" — that was
 *                     the legacy `truncate(persona, 400)` path this branch
 *                     replaced, still measured for comparison as
 *                     `projection.legacy`. Being paid every turn, it is the tier
 *                     whose economics matter most.
 * - `sessionStart`  — the tier-0 preamble (`projectTier0`), injected once per
 *                     session by the SessionStart hook, budgeted by
 *                     `persona-max-tokens` (default 1200 tok ≈ 4800 chars).
 * - `onDemand`      — reachable only when the agent explicitly reads persona.md.
 * - `never`         — present in the file, projected into nothing. The whole point
 *                     of the projection view is to make this population visible.
 */
const INJECTION_TIERS = Object.freeze(["promptSummary", "sessionStart", "onDemand", "never"]);

/* ------------------------------------------------------------------ *
 * 3. Extract shapes (extract.js -> transform.js)
 *
 * Every reader returns a Source. Readers never throw for expected absence
 * (missing vectors.db, missing persona.md) — that is `unmeasured`.
 * ------------------------------------------------------------------ */

/**
 * One store discovered on disk. Discovery itself is cheap and rarely fails, so
 * this is a plain object; the *contents* of the store are the fallible part.
 *
 * @typedef {Object} StoreRef
 * @property {string} slug        `global`, or the project hash (e.g. `-home-dev-projects-foo`).
 * @property {"global"|"project"} scope
 * @property {string} label       Display name (basename of the project root for projects).
 * @property {string} dir         Absolute path to the store directory.
 * @property {string} indexDbPath Absolute path to index.db (may not exist).
 * @property {string|null} vectorDbPath Absolute path to vectors.db, or null when absent.
 * @property {string} sceneDir    Absolute path to scene_blocks/.
 * @property {string|null} changelogPath Absolute path to changelog.jsonl, or null.
 * @property {boolean} hasIndexDb
 * @property {number} indexDbBytes  Size of index.db on disk; 0 when absent.
 * @property {number} vectorDbBytes Size of vectors.db on disk; 0 when absent.
 *   Captured during discovery, not computed later, because transform.js must do
 *   NO I/O — that is what lets it be tested against fixtures and reused without a
 *   live store. `StoreSummary.sizeBytes` is the sum of these two. A missing file
 *   is a real 0 here (it occupies no disk), not an unmeasured reading, which is
 *   why these are plain numbers rather than a Source.
 */

/**
 * On-disk footprint of a store's databases, in bytes — i.e. `StoreSummary.sizeBytes`.
 *
 * Lives HERE, not in extract.js, because both readers need it and both were
 * computing it: extract exported this function while transform re-derived
 * `(ref.indexDbBytes || 0) + (ref.vectorDbBytes || 0)` inline, character for
 * character. Two copies of "which files count towards a store's size" is one
 * copy too many — the next file to join the store (changelog.jsonl, say) would
 * have been added to one of them and the two numbers would disagree with no
 * test able to see it.
 *
 * Pure: it reads two numbers already captured on the {@link StoreRef} at
 * discovery time and touches no disk, which is what lets transform.js call it
 * without breaking its no-I/O property.
 *
 * @param {StoreRef} ref
 * @returns {number}
 */
function storeSizeBytes(ref) {
  return ((ref && ref.indexDbBytes) || 0) + ((ref && ref.vectorDbBytes) || 0);
}

/**
 * A single L1 row, exactly as extract hands it over — column names preserved
 * from memory_store.js so nobody has to hold two mental models.
 *
 * @typedef {Object} L1Record
 * @property {string} record_id
 * @property {string} content
 * @property {string} type
 * @property {number} priority
 * @property {string} scene_name
 * @property {string} session_key
 * @property {string} session_id
 * @property {string} created_time  ISO-8601 or "".
 * @property {string} updated_time  ISO-8601 or "".
 * @property {Object} metadata      Parsed metadata_json ({} when unparsable).
 */

/**
 * @typedef {Source<{records: L1Record[]|null, total: number|null, truncated: boolean|null}>} RecordsRead
 *   `total` is the row count in the table; `records` may be a capped slice, in
 *   which case `truncated` is true. `ok` with `total: 0` genuinely means empty.
 */

/**
 * @typedef {Source<{recordIds: Set<string>|null, count: number|null, dimensions: number|null}>} VectorIdsRead
 *   THE reading that started all this. `unmeasured` when vectors.db is absent
 *   or sqlite-vec fails to load — reason must say which. Never report 0 for a
 *   store whose vector capability could not be exercised.
 */

/**
 * @typedef {Object} SceneFile
 * @property {string} name      Filename without `.md` — the handle used by `tmem scene <name>`.
 * @property {string} filepath
 * @property {string} summary
 * @property {number} heat
 * @property {string} created   ISO-8601 or "".
 * @property {string} updated   ISO-8601 or "".
 * @property {number} bytes
 * @property {number} bodyChars Chars after the meta block — the real payload size.
 */

/** @typedef {Source<{scenes: SceneFile[]|null}>} ScenesRead */

/**
 * @typedef {Object} PersonaBulletRaw
 * @property {string} section  Nearest preceding `##` heading ("" before the first).
 * @property {string} text     Bullet text, `- ` stripped.
 * @property {number} chars
 * @property {number} lineNo   1-based line in persona.md, for deep-linking.
 * @property {number} ordinal  0-based position among all bullets — the promptSummary
 *   digest is ordinal-ordered, so this is what decides injection.
 */

/**
 * @typedef {Source<{text: string|null, bytes: number|null, mtime: string|null,
 *   sections: {name: string, lineNo: number}[]|null, bullets: PersonaBulletRaw[]|null}>} PersonaRead
 */

/**
 * @typedef {Source<{turnCount: number|null, lastConsolidationTurn: number|null,
 *   sessions: Object|null}>} CaptureStateRead   From capture_state.json.
 */

/**
 * @typedef {Source<{config: Object|null, consolidateEvery: number|null,
 *   sceneNavBudgetTokens: number|null, personaBudgetTokens: number|null}>} ConfigRead
 *   From config.json.
 *
 * `config` is the raw document; the three named fields are the EFFECTIVE values,
 * resolved through the same env > config > default precedence the runtime uses, so
 * an unset knob reports the number actually in force rather than `null`.
 *
 * `personaBudgetTokens` is `persona-max-tokens`, which governs the TIER-0
 * projection — the once-per-session preamble. It is declared because transform
 * must project with it: hardcoding the default made the view's central claim
 * ("the tiers are computed by the same projection the hook runs") true only for
 * users who never changed the setting. There is deliberately no tier-1 twin:
 * that budget is pinned, not configurable (memory_recall.PERSONA_TIER1_MAX_CHARS).
 */

/**
 * @typedef {Source<{sessions: Object|null, projects: Object|null,
 *   pendingSessions: number|null, recallDisabledSlugs: string[]|null}>} StateRead  From state.json.
 */

/**
 * Everything extract produces for one store, before any computation.
 * @typedef {Object} StoreExtract
 * @property {StoreRef} ref
 * @property {RecordsRead} records
 * @property {VectorIdsRead} vectors
 * @property {ScenesRead} scenes
 */

/**
 * @typedef {Object} RootExtract
 * @property {string} rootDir            `~/.memory-tencentdb`
 * @property {string|null} currentSlug   The resolved current-project store slug
 *   (memory_reader.projectHashForCwd), or null outside any project. A plain
 *   identifier, not a Source: transform uses it to pick the current project's store.
 * @property {StoreExtract[]} stores
 * @property {PersonaRead} persona          The cross-project global L3 persona.
 * @property {PersonaRead} projectDoctrine  The CURRENT project's `<project-doctrine>`
 *   (project-scoped `persona.md`: SOPs / anti-patterns, injected once at
 *   SessionStart). Same shape as `persona`; `unmeasured` when there is no current
 *   project (a global-only view), never an error.
 * @property {StateRead} state
 * @property {ConfigRead} config
 * @property {CaptureStateRead} captureState
 * @property {string} extractedAt        ISO-8601.
 */

/* ------------------------------------------------------------------ *
 * 4. Transform shapes (transform.js -> serve.js / cli.js `tmem view --snapshot`)
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} Quantiles
 * @property {number} min @property {number} p50 @property {number} p75
 * @property {number} p90 @property {number} p95 @property {number} p99
 * @property {number} max @property {number} mean @property {number} n
 */

/**
 * @typedef {Object} VectorCoverageStore
 * @property {Status} status        Mirrors the store's VectorIdsRead status.
 * @property {string|null} reason
 * @property {number|null} withVector     null unless status is `ok`.
 * @property {number|null} withoutVector
 * @property {number|null} ratio          0..1, null unless `ok`.
 * @property {Object<string, {withVector: number, withoutVector: number, ratio: number}>|null}
 *   byWritePath  Keyed by {@link WRITE_PATH}. null unless `ok`.
 * @property {Object<string, number>|null} missingByMonth  `YYYY-MM` -> count of records
 *   lacking a vector, keyed on created_time. Shows whether the gap is historical
 *   backlog or actively accruing. null unless `ok`.
 * @property {number|null} orphanVectors  Vector ids with no matching L1 record.
 */

/**
 * @typedef {Object} SceneStats
 * @property {number} count
 * @property {Object<string, number>} heatBuckets   Keyed by {@link HEAT_BUCKETS} key.
 * @property {number} staleHot                      Hot per {@link STALE_HOT} but not recently updated.
 * @property {Status} navStatus  Whether the nav split below is a measurement.
 *   `ok` for every project store: `memory_recall.buildSceneNav()` renders THAT
 *   project's scenes first, so nothing competes with them and the count is exact.
 *   `unmeasured` for the `global` store when it holds scenes — global renders
 *   AFTER the active project's, so how many appear is a different number in every
 *   project (usually zero, a project's own scenes having already filled the
 *   block). It was previously computed as if global rendered alone, which is an
 *   upper bound wearing a measurement's clothes; there is no single answer to
 *   publish, so none is.
 * @property {string|null} navReason  Why, when `navStatus` is not `ok`.
 * @property {number|null} visibleInNav  Scenes that fit inside THIS store's
 *   `<scene-navigation>` block — measured by running the real renderer
 *   (`scene_nav.renderSceneNav`) over the real ordering, at the effective budget,
 *   NOT by a second estimate. At the default 800 chars that is about five lines:
 *   a rendered line is ~130 chars once the summary is cut to
 *   `NAV.SUMMARY_MAX_CHARS`. `null` when `navStatus` is not `ok` — never 0.
 * @property {number|null} invisibleInNav  count - visibleInNav. Written, never seen.
 *   `null` when `navStatus` is not `ok`.
 * @property {number|null} navBudgetChars  Budget used for the split; null if unknown.
 * @property {number|null} navUsedChars    Chars the rendered block occupies,
 *   scaffolding included; `null` when `navStatus` is not `ok`.
 *
 * REMOVED: `orphanScenes` and `danglingSceneNames`. They counted the two sides of
 * a join between `l1_records.scene_name` and scene filenames that nothing in this
 * repo maintains — auto-capture writes the constant "auto-capture" on 96.5% of
 * rows, the seed extractor writes a free-text description per record, and the
 * consolidator names scene files independently and never writes back. Both counts
 * were therefore near-total in opposite directions at once. See the note in
 * transform.buildGaps(). Do not reintroduce them without a real link to measure.
 */

/**
 * Per-store computed view. Note the deliberate asymmetry: record-derived
 * numbers are plain (reading index.db either worked or the store is reported
 * as errored wholesale), while anything vector-derived stays wrapped, because
 * that is the reading that can silently be absent.
 *
 * @typedef {Object} StoreSummary
 * @property {string} slug
 * @property {"global"|"project"} scope
 * @property {string} label
 * @property {Status} status        Overall store status: `error` if index.db was
 *   unreadable, else `ok`. A store that is `error` contributes to NO aggregate.
 * @property {string|null} reason
 * @property {number|null} records         The store's true row count.
 * @property {number|null} recordsMeasured How many of those rows the per-record
 *   figures on this object (`byType`, `byWritePath`, `contentLength`, `lowSignal`,
 *   `duplicates`) were actually computed from. Equal to `records` unless the read
 *   hit {@link module:extract.DEFAULT_RECORD_LIMIT}. It is declared separately
 *   because a share built from those counts must divide by THIS number: pairing a
 *   truncated numerator with the full row count is the measured-subset-over-full-
 *   population blend {@link Coverage} exists to make impossible, and it is not
 *   detectable after the fact from a ratio that looks plausible either way.
 * @property {boolean|null} recordsTruncated  `recordsMeasured < records` — i.e.
 *   {@link RecordsRead}.truncated for this store, carried through so a consumer
 *   can distinguish a whole reading from a partial one without recomputing it.
 * @property {Object<string, number>|null} byType        Keyed by {@link RECORD_TYPES}.
 * @property {Object<string, number>|null} byWritePath   Keyed by {@link WRITE_PATH}.
 * @property {Quantiles|null} contentLength
 * @property {Object<string, number>|null} lowSignal     Keyed by {@link LOW_SIGNAL_CLASSES}.
 * @property {Object<string, number>|null} duplicates    Keyed by {@link DUPLICATE_TIERS};
 *   value = records that are a non-first member of a duplicate group.
 * @property {VectorCoverageStore} vectors
 * @property {SceneStats|null} scenes
 * @property {string|null} newestRecordAt  Max updated_time (ISO) — feeds the snapshot id.
 * @property {string|null} oldestRecordAt
 * @property {number} sizeBytes            index.db + vectors.db on disk.
 */

/**
 * @typedef {Object} PersonaSection
 * @property {string} name
 * @property {number} lineNo
 * @property {number} bullets
 * @property {number} chars
 * @property {Object<string, number>} duties  Keyed by {@link DUTY_CLASSES}.
 */

/**
 * @typedef {Object} PersonaBullet
 * @property {string} section
 * @property {string} text
 * @property {number} chars
 * @property {number} lineNo
 * @property {number} ordinal
 * @property {"always"|"conditional"|"reference"} duty
 * @property {"promptSummary"|"sessionStart"|"onDemand"|"never"} tier
 * @property {string} tierReason  Why it landed there, e.g. "ordinal 7 — beyond the
 *   5-bullet digest" or "truncated at 400 chars". The projection is only useful
 *   if its verdict is auditable.
 * @property {number} injectedChars  Chars of this bullet the agent ACTUALLY receives
 *   at its tier; 0 for `onDemand`/`never`. Distinct from `chars` (the source length)
 *   because the projection truncates per bullet — on the live persona 5 of the 6
 *   injected bullets are cut, so counting them at source length overstates delivery
 *   by more than 2x. Any "how much persona reaches the agent" figure must sum THIS.
 * @property {boolean} truncated  Whether the bullet was cut to fit its budget. Note
 *   that a truncated line is not necessarily a prefix of `text`: the dangling-`**`
 *   repair in truncateAtWord() deletes the marker in place, so consumers must key
 *   on (section, index) rather than substring-matching the rendered output.
 */

/**
 * @typedef {Object} PersonaProjection
 * @property {number} totalBullets
 * @property {number} totalChars
 * @property {Object<string, number>} byTier   BULLET COUNTS, keyed by
 *   {@link INJECTION_TIERS}. Counts, never chars — the two were conflated once and
 *   the "chars injected" tile read 41 (a bullet count) as characters. Consumers that
 *   want chars read `byTierChars`; nobody should recompute either from `bullets[]`.
 * @property {Object<string, number>} byTierChars  CHARS attributable to each tier,
 *   same keys. For `promptSummary`/`sessionStart` this is delivered chars (the sum of
 *   each bullet's `injectedChars`, i.e. post-truncation); for `onDemand`/`never` it is
 *   source chars — the mass sitting in the file unread, which is the only reason to
 *   show those tiers at all. `byTierChars.promptSummary === injectedChars` always.
 * @property {number} injectedChars            Chars actually reaching promptSummary.
 * @property {number} droppedAlwaysDuties      `always`-duty bullets that never inject.
 *   The headline number: a hard constraint the agent cannot see is a lie in the file.
 * @property {LegacyProjection} legacy         The pre-tiering baseline, MEASURED.
 */

/**
 * What the projection this replaced actually delivered: `truncate(persona, 400)`
 * over the first five non-heading lines (memory_recall.getPersona, preserved as
 * persona_projection.legacyProjection).
 *
 * Emitted as live data rather than a constant on purpose. The before/after
 * comparison the UI draws is a RATIO whose denominator is the persona document,
 * and that document grows with every consolidation — the audit's 1.09% had already
 * drifted to 1.03% by the time this field was added, with nothing about the legacy
 * path having changed. A frozen number in the shell would have quietly become
 * false; a measured one cannot.
 *
 * @typedef {Object} LegacyProjection
 * @property {number} chars       Length of the legacy injected string (401 today).
 * @property {number} totalChars  Length of the whole persona.md — NOT the sum of
 *   bullet chars in {@link PersonaProjection}. The comparison is against everything
 *   the consolidator wrote, including headings and prose.
 * @property {number} ratio       chars / totalChars.
 * @property {{name: string, lines: number}[]} sections  Sections the legacy output
 *   drew from, first-appearance order. Typically a single entry — the legacy path
 *   takes the document's first five lines, so it reports whichever section leads the
 *   file (`Identity`) and no other, whatever their duty. That concentration, not the
 *   char count, is the finding.
 */

/**
 * @typedef {Object} PersonaSummary
 * @property {Status} status
 * @property {string|null} reason
 * @property {PersonaSection[]|null} sections
 * @property {PersonaBullet[]|null} bullets
 * @property {Object<string, number>|null} duties   Totals keyed by {@link DUTY_CLASSES}.
 * @property {PersonaProjection|null} projection
 */

/* ------------------------------------------------------------------ *
 * 5. Gaps
 * ------------------------------------------------------------------ */

/**
 * Gap kinds. A gap is a *finding*; `unmeasured: true` marks the ones that are
 * only an absence of knowledge. The UI must render the two differently — the
 * original false alarm was an unmeasured item dressed up as a gap.
 */
const GAP_KIND = Object.freeze({
  VECTORS_MISSING: "vectors_missing",           // records with no embedding
  VECTORS_UNMEASURABLE: "vectors_unmeasurable", // sqlite-vec absent/failed — not a gap
  VECTORS_ORPHANED: "vectors_orphaned",         // embedding with no record
  STORE_UNREADABLE: "store_unreadable",
  DUPLICATE_RECORDS: "duplicate_records",
  LOW_SIGNAL_RECORDS: "low_signal_records",
  SCENE_INVISIBLE: "scene_invisible",           // written but outside the nav budget
  SCENE_STALE_HOT: "scene_stale_hot",
  // SCENE_ORPHANED / SCENE_DANGLING removed: they scored an L1→L2 link
  // (`l1_records.scene_name` -> scene filename) that no writer in this repo
  // maintains, and so fired on 218 of 219 scene files and ~130 record names
  // simultaneously — both directions near-total, which is what comparing two
  // unrelated columns looks like. Removed rather than made `unmeasured`: both
  // sides read perfectly, so nothing went unmeasured; the question was malformed.
  // The evidence is in transform.buildGaps(). If L1→L2 linkage is ever really
  // implemented, measure THAT link — do not restore this string comparison.
  /**
   * Writer and reader disagree about what `heat` means. This fired on the whole
   * store when scene_nav.heatEmoji() laddered at 50/100/200/500/1000 while every
   * scene was written on the 1–5 scale, so a scene at heat 5 ("active this week")
   * was read as cold and got no cue. R2 realigned the ladder; the gap remains
   * because the disagreement can recur from either side — a store whose entire
   * heat population sits below the reader's first rung, or a writer that adopts a
   * larger scale. Reported, not silently normalised: a scale mismatch that nobody
   * can see is how the nav budget quietly ranks the wrong scenes.
   */
  HEAT_SCALE_MISMATCH: "heat_scale_mismatch",
  PERSONA_UNPROJECTED: "persona_unprojected",   // always-duty bullet never injected
  PERSONA_MISSING: "persona_missing",
  CAPTURE_BACKLOG: "capture_backlog",           // turns since last consolidation
  CONFIG_UNREADABLE: "config_unreadable",
});

const GAP_KINDS = Object.freeze(Object.values(GAP_KIND));

/**
 * Severity. `info` never colours red in the UI; `unmeasured`-flagged gaps are
 * capped at `warn` because you cannot know the severity of what you did not read.
 */
const SEVERITY = Object.freeze({ INFO: "info", WARN: "warn", CRITICAL: "critical" });
const SEVERITIES = Object.freeze([SEVERITY.INFO, SEVERITY.WARN, SEVERITY.CRITICAL]);

/**
 * @typedef {Object} Gap
 * @property {string} id        Stable across refreshes: `${kind}:${subject.slug||subject.id}`.
 *   Stability matters — SSE diffs and "acknowledged" UI state key on it.
 * @property {string} kind      One of {@link GAP_KIND}.
 * @property {"info"|"warn"|"critical"} severity
 * @property {boolean} unmeasured  true => this is an absence of measurement, not a
 *   defect. Such gaps MUST NOT contribute to any count of defects.
 * @property {{scope: string, slug: string|null, id: string|null, label: string}} subject
 *   What the gap is about. `slug` names the store; `id` a record/scene/bullet.
 * @property {string} title     One line, imperative-free, e.g. "412 records without embeddings".
 * @property {Object} evidence  Free-form but always numeric-or-string leaves, so the
 *   UI can render it as a table without special cases. Include the denominator:
 *   "412 of 5,467" is actionable, "412" is not.
 * @property {string|null} suggestion  Command the user could run (`tmem sync`), or null.
 */

/** Constructs a Gap with the invariants enforced (id shape, severity cap). */
function gap({ kind, severity, unmeasured: isUnmeasured = false, subject, title, evidence = {}, suggestion = null }) {
  if (!GAP_KINDS.includes(kind)) throw new TypeError(`gap(): unknown kind ${kind}`);
  if (!SEVERITIES.includes(severity)) throw new TypeError(`gap(): unknown severity ${severity}`);
  if (isUnmeasured && severity === SEVERITY.CRITICAL) {
    throw new TypeError(
      `gap(): kind "${kind}" is unmeasured and cannot be critical — ` +
      `an unread value has unknown severity`
    );
  }
  const key = subject && (subject.id || subject.slug || subject.scope || "root");
  return { id: `${kind}:${key}`, kind, severity, unmeasured: isUnmeasured, subject, title, evidence, suggestion };
}

/* ------------------------------------------------------------------ *
 * 6. Totals + Coverage  (the anti-blending machinery)
 * ------------------------------------------------------------------ */

/**
 * A ratio that is structurally incapable of mixing measured and unmeasured
 * input. There is no bare percentage anywhere else in this contract; if you
 * want one, you build a Coverage, and building one forces you to state what
 * you excluded.
 *
 * @typedef {Object} Coverage
 * @property {string} metric            e.g. "vectors".
 * @property {number} measuredStores    Stores whose reading was `ok`.
 * @property {number} measuredRecords   Denominator. Records inside those stores only.
 * @property {number} covered           Numerator. <= measuredRecords.
 * @property {number} ratio             covered / measuredRecords, 0 when denominator is 0.
 * @property {number} unmeasuredStores  Stores excluded from the ratio entirely.
 * @property {number} unmeasuredRecords Records living in those excluded stores. These are
 *   NOT in the denominator and must be shown next to the ratio, never folded in.
 * @property {number} erroredStores
 * @property {string[]} unmeasuredReasons  Deduped reasons, so the UI can explain the gap.
 * @property {boolean} partial          true when unmeasuredStores + erroredStores > 0 —
 *   the flag the UI uses to refuse to print a bare "%" without a caveat.
 */

/**
 * Build a Coverage from per-store contributions.
 *
 * @param {string} metric
 * @param {Array<{status: Status, reason?: string|null, records: number, covered?: number}>} entries
 *   One entry per store. For `ok` entries `covered` is required; for the others it
 *   is ignored (and must not be supplied as a number — see {@link source}).
 * @returns {Coverage}
 */
function makeCoverage(metric, entries) {
  let measuredStores = 0, measuredRecords = 0, covered = 0;
  let unmeasuredStores = 0, unmeasuredRecords = 0, erroredStores = 0;
  const reasons = new Set();

  for (const e of entries) {
    if (!STATUS_VALUES.includes(e.status)) throw new TypeError(`makeCoverage(${metric}): bad status ${e.status}`);
    // NOT `Number(e.records) || 0`. That coercion sat inside the anti-blending
    // machine and quietly defeated it: an entry whose record count was null or
    // NaN contributed 0 to `unmeasuredRecords`, so an unmeasured store vanished
    // from the very caveat this function exists to produce — the ratio would then
    // look complete while a whole population went unmentioned. It is the same
    // class of caller error as a missing `covered`, so it fails the same way:
    // loudly, at construction, where it is one stack frame from the cause.
    // `typeof`, not `Number()`: `Number(null)` is 0, so a coercion-based guard
    // would wave through exactly the value that caused the problem.
    const n = e.records;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      throw new TypeError(
        `makeCoverage(${metric}): entry has non-numeric "records" (= ${JSON.stringify(e.records)}) — ` +
        "a store whose record count is unknown must say so, not contribute 0 to the caveat"
      );
    }
    if (e.status === STATUS.OK) {
      if (typeof e.covered !== "number") {
        throw new TypeError(`makeCoverage(${metric}): measured entry missing numeric "covered"`);
      }
      if (e.covered > n) {
        throw new RangeError(`makeCoverage(${metric}): covered ${e.covered} exceeds records ${n}`);
      }
      measuredStores += 1;
      measuredRecords += n;
      covered += e.covered;
    } else {
      // The whole point: these records leave the denominator, they do not become zeros.
      unmeasuredStores += 1;
      unmeasuredRecords += n;
      if (e.status === STATUS.ERROR) erroredStores += 1;
      if (e.reason) reasons.add(e.reason);
    }
  }

  return validateCoverage({
    metric,
    measuredStores,
    measuredRecords,
    covered,
    ratio: measuredRecords > 0 ? covered / measuredRecords : 0,
    unmeasuredStores,
    unmeasuredRecords,
    erroredStores,
    unmeasuredReasons: [...reasons],
    partial: unmeasuredStores > 0,
  });
}

/**
 * Guards the invariant that motivated this whole module. Cheap enough to call
 * on every payload; the failure it catches is otherwise invisible.
 */
function validateCoverage(cov, label = "coverage") {
  if (!cov || typeof cov !== "object") throw new TypeError(`${label}: not an object`);
  for (const k of ["measuredStores", "measuredRecords", "covered", "unmeasuredStores", "unmeasuredRecords", "ratio"]) {
    if (typeof cov[k] !== "number" || Number.isNaN(cov[k])) throw new TypeError(`${label}.${k}: not a number`);
  }
  if (cov.covered > cov.measuredRecords) {
    throw new RangeError(`${label}: covered ${cov.covered} > measuredRecords ${cov.measuredRecords}`);
  }
  const expected = cov.measuredRecords > 0 ? cov.covered / cov.measuredRecords : 0;
  if (Math.abs(cov.ratio - expected) > 1e-9) {
    throw new RangeError(
      `${label}: ratio ${cov.ratio} does not equal covered/measuredRecords ${expected} — ` +
      `an unmeasured store has been blended into the denominator`
    );
  }
  if (cov.partial !== (cov.unmeasuredStores > 0)) {
    throw new RangeError(`${label}: "partial" flag disagrees with unmeasuredStores`);
  }
  return cov;
}

/**
 * @typedef {Object} Totals
 * @property {number} stores           All discovered stores, including unreadable ones.
 * @property {number} readableStores
 * @property {number} erroredStores
 * @property {number} records          Sum over readable stores only.
 * @property {number} recordsMeasured  Records actually read, summed over the same
 *   stores — the denominator for `byType`, `byWritePath`, `lowSignal`, `duplicates`
 *   and every per-record count in this object. Equal to `records` unless
 *   `truncatedStores > 0`.
 * @property {number} truncatedStores  Readable stores whose record read was capped.
 *   Non-zero means `records` and `recordsMeasured` answer different questions.
 * @property {number} scenes
 * @property {Object<string, number>} byType
 * @property {Object<string, number>} byWritePath
 * @property {Object<string, Coverage>} coverage  metric -> Coverage. The ONLY place a
 *   ratio may live. Currently: `vectors`, plus `vectors:auto` / `vectors:awaited`
 *   for the per-write-path split.
 * @property {LowSignalTotals} lowSignal  Corpus-wide low-signal reading, including the
 *   drift verdict against {@link LOW_SIGNAL_BASELINE}. Declared because a consumer
 *   that cannot find this field renders "not measured" over a number that WAS
 *   measured — the original blending bug inverted, and just as wrong.
 * @property {number} scenesReachableInSomeNav  Scenes that fit inside the nav
 *   block of the project they live in — SUMMED OVER THE PER-PROJECT NAV BLOCKS,
 *   one block per project store, each budgeted independently, and no session ever
 *   renders more than one of them. Hence the quantifier in the name: this answers
 *   "across every project, how many written scenes are reachable at all", and it
 *   is NOT the number of lines in any single block. A single block holds about
 *   five (a rendered line is ~130 chars against an 800-char budget), so quoting
 *   this sum as one block's contents overstates what any turn receives by roughly
 *   the number of projects. Per-block figures are exact and live on
 *   {@link SceneStats}.visibleInNav. Measured stores only — see
 *   `scenesNavUnmeasured`.
 * @property {number} scenesUnreachableInEveryNav  Scenes written but never
 *   rendered into their own project's nav block — and a scene lives in exactly one
 *   store, so a scene counted here is offered in NO project, ever. Not "withheld
 *   this turn": every turn withholds far more than this, because it renders only
 *   one project's block. Sits beside `scenes` deliberately: a scene count with no
 *   reachability count is the "5,496 records" screen this whole view exists to
 *   refuse.
 * @property {number} scenesNavUnmeasured   Scenes living in stores whose nav
 *   visibility could not be measured (today: `global`, whose scenes render behind
 *   whichever project is active). NOT in either count above and never folded into
 *   one, exactly as {@link Coverage}.unmeasuredRecords is not folded into a ratio.
 * @property {string|null} scenesNavUnmeasuredReason  Why, when
 *   `scenesNavUnmeasured > 0`; `null` otherwise. Singular, and deliberately not a
 *   list: the reason is generated at one site ({@link SceneStats}.navReason, from
 *   `transform.sceneNavVisibility`) out of one template whose only variable is the
 *   root-level nav budget, which every store in a pass shares. A Set of it could
 *   only ever hold one string, so the plural field, the de-duplication and the
 *   `join("; ")` in every consumer were machinery for a case that cannot arise.
 *   If a second reason is ever generated, this becomes a list again — and that is
 *   a schema bump, which is the point of it being singular now.
 * @property {Object<string, number>} gapsBySeverity   Excludes unmeasured gaps.
 * @property {number} unmeasuredGaps                   Counted separately, on purpose.
 */

/**
 * @typedef {Object} LowSignalTotals
 * @property {number} records       Denominator: records READ in readable stores,
 *   i.e. the sum of `StoreSummary.recordsMeasured`. Equal to the row count unless
 *   a store's read was capped; the classifier only ran on these, so this is the
 *   only denominator `unionRecords` may be divided by.
 * @property {number} recordsUnread Rows in readable stores that were not read, and
 *   therefore not classified. NOT in the denominator — shown beside the ratio,
 *   never folded into it, exactly as {@link Coverage}.unmeasuredRecords is.
 * @property {number} unionRecords  Records matching at least one
 *   {@link LOW_SIGNAL_UNION_CLASSES} member. UNION, not sum — a record matching three
 *   junk classes counts once, which is why this is not derivable from `perClass`.
 * @property {number} ratio         unionRecords / records.
 * @property {string[]} unionClasses  Classes folded into the union, echoed so a
 *   consumer can verify the headline was not silently redefined.
 * @property {Object<string, number>} perClass  Per-class counts, keyed by
 *   {@link LOW_SIGNAL_CLASSES}. These OVERLAP and sum well above `unionRecords`;
 *   never present their total as a share.
 * @property {{withinTolerance: boolean, comparable: boolean, observed: number,
 *   pinned: number, deltaPoints: number, tolerancePoints: number, baselineRecords: number,
 *   baselineUnionRecords: number, message: string|null}} baseline
 *   `comparable` is false when the corpus was read under a cap: the pin covers a
 *   whole corpus, so the delta would measure the cap rather than the classifier.
 *   `withinTolerance` is then false — never true — because a pass that was not
 *   measured must not be claimed; read `comparable` before reporting drift.
 *   Non-throwing form of {@link validateLowSignalUnion}. The validator throws by
 *   design — it guards a code change that redefines the metric — but transform also
 *   runs inside a live server, where legitimate drift must become a visible finding
 *   rather than a 500. `message` carries the validator's text when it fails.
 */

/* ------------------------------------------------------------------ *
 * 7. Snapshot identity
 * ------------------------------------------------------------------ */

/**
 * How a snapshotId is computed (implemented in transform.js, NOT here — this
 * module stays free of hashing so it can be required from anywhere):
 *
 *   1. For each store with `status === "ok"`, build the line
 *        `${slug}\t${records}\t${newestRecordAt || ""}\t${scenes}`
 *      Stores that are `error` contribute `${slug}\tERR` — an unreadable store
 *      changing to readable IS a state change and must alter the id.
 *   2. Sort lines byte-wise by slug (store discovery order is filesystem-dependent).
 *   3. Append `persona\t${personaBytes|"NA"}\t${personaMtime|""}`.
 *   4. Join with `\n`, prefix `v${SCHEMA_VERSION}\n`, and take
 *        sha256(utf8) -> hex -> first 16 chars.
 *   5. Format: `s<SCHEMA_VERSION>-<16 hex>` — currently `s5-<16 hex>`.
 *      The version is inside the id on purpose: two runs over identical state
 *      but different contract semantics MUST NOT share an id, and a file named
 *      `snapshot-s2-*.json` is self-evidently pre-v3.
 *
 * Deliberately cheap: no content hashing, so it is O(stores) not O(records).
 * It answers "is this the same state I exported?", not "is every byte identical".
 * Two states with equal counts and equal max updated_time are treated as the
 * same snapshot — acceptable, because every write in this system bumps
 * updated_time or the count.
 */
const SNAPSHOT_ID_SPEC = Object.freeze({
  algorithm: "sha256",
  digestChars: 16,
  prefix: `s${SCHEMA_VERSION}-`,
  storeFields: Object.freeze(["slug", "records", "newestRecordAt", "scenes"]),
  fieldSeparator: "\t",
  lineSeparator: "\n",
  sortBy: "slug",
  erroredStoreLine: "ERR",
  includesPersona: true,
});

const SNAPSHOT_ID_PATTERN = /^s\d+-[0-9a-f]{16}$/;

/** True for a well-formed snapshot id of any schema version. */
function isSnapshotId(v) {
  return typeof v === "string" && SNAPSHOT_ID_PATTERN.test(v);
}

/* ------------------------------------------------------------------ *
 * 8. Snapshot + API envelopes
 * ------------------------------------------------------------------ */

/**
 * The whole computed view. `/api/snapshot` returns this inside an envelope;
 * `--snapshot` writes this (plus the envelope meta) as one JSON file.
 *
 * @typedef {Object} Snapshot
 * @property {number} schemaVersion
 * @property {string} snapshotId
 * @property {string} generatedAt      ISO-8601.
 * @property {string} rootDir
 * @property {Totals} totals
 * @property {StoreSummary[]} stores   Sorted by records desc, global first.
 * @property {PersonaSummary} persona           The cross-project global persona.
 * @property {PersonaSummary} projectDoctrine   The current project's doctrine, projected
 *   through the SAME projection as `persona` so the two are directly comparable.
 *   `unmeasured` when there is no current project. Deliberately NOT part of
 *   `computeSnapshotId` — additive, like `recallUsage`.
 * @property {string[]} upgradeNudges  Activation hints from doctor.buildUpgradeNudges
 *   (the SAME function `tmem doctor` prints): re-consolidate to activate latent
 *   post-0.7.0 features. `[]` when every store is already in the new shape. Additive,
 *   and out of `computeSnapshotId`.
 * @property {Gap[]} gaps              Sorted: measured before unmeasured, then severity desc.
 * @property {{state: Object, config: Object, captureState: Object}} health
 *   Each carries its own `status`/`reason` (they are Sources).
 * @property {{extractMs: number, transformMs: number}} timing
 */

/** Route paths, so serve.js and any client agree literally. */
const ROUTES = Object.freeze({
  SNAPSHOT: "/api/snapshot",
  STORE_RECORDS: "/api/store/:slug/records",
  PERSONA: "/api/persona",
  RECALL: "/api/recall",
  EXPORT: "/api/export",
  EVENTS: "/api/events", // SSE; emits {type:"snapshot", snapshotId} on change
});

/** Default and maximum page size for `/api/store/:slug/records`. */
const PAGE = Object.freeze({ DEFAULT_LIMIT: 100, MAX_LIMIT: 1000 });

/**
 * Every API response is this envelope — success and failure alike, so clients
 * have one branch, not two.
 *
 * @typedef {Object} ApiEnvelope
 * @property {boolean} ok
 * @property {number} schemaVersion
 * @property {string|null} snapshotId  State the response was computed against; lets a
 *   client detect that a paginated page came from a different state than its snapshot.
 * @property {string} generatedAt
 * @property {*} data                  Route-specific payload; null when ok is false.
 * @property {{code: string, message: string}|null} error
 */

/**
 * @param {*} data
 * @param {{snapshotId?: string|null, generatedAt?: string}} [meta]
 * @returns {ApiEnvelope}
 */
function apiOk(data, meta = {}) {
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    snapshotId: meta.snapshotId || null,
    generatedAt: meta.generatedAt || new Date().toISOString(),
    data,
    error: null,
  };
}

/** @returns {ApiEnvelope} */
function apiError(code, message, meta = {}) {
  return {
    ok: false,
    schemaVersion: SCHEMA_VERSION,
    snapshotId: meta.snapshotId || null,
    generatedAt: meta.generatedAt || new Date().toISOString(),
    data: null,
    error: { code, message },
  };
}

/** Error codes used across routes. */
const API_ERROR = Object.freeze({
  NOT_FOUND: "not_found",
  BAD_REQUEST: "bad_request",
  STORE_UNREADABLE: "store_unreadable",
  INTERNAL: "internal",
});

/**
 * `/api/store/:slug/records?offset=&limit=&type=&writePath=&q=&hasVector=`
 * @typedef {Object} RecordsPage
 * @property {string} slug
 * @property {RecordRow[]} rows
 * @property {number} offset
 * @property {number} limit
 * @property {number} total          Rows matching the filter, not rows in store.
 * @property {number} storeTotal     Rows in the store, unfiltered.
 * @property {Object} filter         Echo of the applied filter, so the UI can render chips.
 * @property {Status} vectorStatus   Whether `hasVector` on the rows means anything at all.
 * @property {string|null} vectorReason
 */

/**
 * @typedef {Object} RecordRow
 * @property {string} id             record_id.
 * @property {string} content
 * @property {number} chars
 * @property {string} type
 * @property {number} priority
 * @property {string} scene          scene_name.
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {"auto"|"awaited"|"unknown"} writePath
 * @property {boolean|null} hasVector  null when vectorStatus !== "ok". Not false.
 * @property {string[]} lowSignal      Matching {@link LOW_SIGNAL_CLASSES}.
 * @property {number} duplicateGroup   -1 when unique, else a per-store group index.
 */

/** `/api/persona` -> {@link PersonaSummary} plus the raw text for the source view.
 * @typedef {PersonaSummary & {text: string|null, path: string}} PersonaResponse
 */

/**
 * `/api/recall?q=&slug=&limit=` — runs the SAME recall path the agent uses, so
 * the view shows what would actually be injected, not a re-implementation.
 *
 * @typedef {Object} RecallResponse
 * @property {string} q
 * @property {RecallHit[]} hits
 * @property {Status} vectorStatus   `unmeasured` => this was FTS-only; say so in the UI.
 * @property {string|null} vectorReason
 * @property {string} injected       The exact `<memory-context>` block that would be injected.
 * @property {number} injectedChars
 * @property {number} tookMs
 */

/**
 * @typedef {Object} RecallHit
 * @property {string} id @property {string} slug @property {string} content
 * @property {string} type @property {number} priority
 * @property {"fts"|"vector"|"both"} matchedBy
 * @property {number|null} score   null when the ranker did not expose one.
 * @property {boolean} injected    Whether it survived the budget into `injected`.
 */

/**
 * `/api/export?format=json` — the same payload `--snapshot` writes to disk, so
 * a bug report from the UI and one from the CLI are byte-comparable.
 * @typedef {Object} ExportResponse
 * @property {Snapshot} snapshot
 * @property {{tool: string, version: string, node: string, exportedAt: string}} provenance
 */

/* ------------------------------------------------------------------ *
 * 9. Empty-state constructors
 *    Shared so an unreadable store renders identically everywhere.
 * ------------------------------------------------------------------ */

/** Zeroed counter map over a fixed key list — keeps key sets identical across modules. */
function zeroMap(keys) {
  return Object.fromEntries(keys.map((k) => [k, 0]));
}

/** Vector block for a store whose vector capability could not be exercised. */
function unmeasuredVectors(reason) {
  return {
    status: STATUS.UNMEASURED,
    reason,
    withVector: null,
    withoutVector: null,
    ratio: null,
    byWritePath: null,
    missingByMonth: null,
    orphanVectors: null,
  };
}

module.exports = {
  SCHEMA_VERSION,
  // status + source
  STATUS, STATUS_VALUES, source, ok, unmeasured, errored, isMeasured, validateSource,
  // vocabulary
  SCOPE, RECORD_TYPES, RECORD_TYPE_OTHER,
  WRITE_PATH, WRITE_PATHS, writePathForRecordId,
  QUANTILES, DUPLICATE_TIERS,
  LOW_SIGNAL_CLASSES, LOW_SIGNAL_UNION_CLASSES, LOW_SIGNAL_BASELINE, LOW_SIGNAL,
  validateLowSignalUnion,
  HEAT_BUCKETS, HEAT_SCALE, STALE_HOT, DUTY_CLASSES, INJECTION_TIERS,
  // gaps
  GAP_KIND, GAP_KINDS, SEVERITY, SEVERITIES, gap,
  // coverage
  makeCoverage, validateCoverage,
  // snapshot identity
  SNAPSHOT_ID_SPEC, SNAPSHOT_ID_PATTERN, isSnapshotId,
  // api
  ROUTES, PAGE, API_ERROR, apiOk, apiError,
  // helpers
  zeroMap, unmeasuredVectors, storeSizeBytes,
};
