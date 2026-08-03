#!/usr/bin/env node
/**
 * Low-signal classification — the ONE definition, shared by the lens and the
 * write path.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The `tmem view` audit measured 39.2% of the store (2,187 of 5,576 records) as
 * low-signal, and proved it is a WRITE-side defect rather than a storage one:
 * one duplicate group holds 96 copies of the same `<task-notification>verify
 * loop failed` text, and dozens more are `Base directory for this skill: …`
 * echoes. Deleting them afterwards was measured worthless (0.04% of delivered
 * context). So `memory_auto_capture.autoCapture()` now REFUSES to store them,
 * and it must refuse using the same predicates the lens reports — otherwise the
 * dashboard names a class of junk the writer quietly keeps admitting, or the
 * writer drops records the lens never counted and nobody can audit the loss.
 *
 * Hence: predicates here, thresholds in `constants.js`, and nothing else. This
 * module is PURE and REQUIRE-LIGHT on purpose — the Stop hook pays this cost on
 * every single turn, so it reads the two values from the leaf rather than from
 * `view/contract.js`, which re-exports them but costs ~1.2 ms of module load to
 * do it.
 *
 * Requiring `view/transform.js` instead (which also exports `classifyLowSignal`,
 * by re-exporting THIS module) was tried and rejected: it drags in
 * persona_projection, scene_nav and a load-time assertion that THROWS when the
 * heat ladder and the contract disagree. That assertion fired during
 * development, which would have taken the whole capture path down with it — a
 * lens invariant must never be able to stop the writer.
 */
"use strict";

const { LOW_SIGNAL, LOW_SIGNAL_CLASSES } = require("./constants.js");

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const escapeRe = (s) => String(s).replace(ESCAPE_RE, "\\$&");

/**
 * Assent-token matcher for the `continuation` class.
 *
 * Built from {@link LOW_SIGNAL.CONTINUATION_OPENERS} rather than hand-written so
 * the legend and the classifier cannot drift. Longest-first alternation ("go
 * ahead" before "go"), and the trailing boundary is an explicit
 * `(?![\p{L}\p{N}])` instead of `\b`: `\b` is ASCII-only, so after "ừ" or "được"
 * it demands a following word character and the Vietnamese openers — half the
 * list — would never match.
 */
const CONTINUATION_RE = new RegExp(
  `^\\s*(?:${[...LOW_SIGNAL.CONTINUATION_OPENERS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);

const SLASH_OR_TAG_RE = new RegExp(
  `^\\s*[${LOW_SIGNAL.SLASH_OR_TAG_PREFIXES.map(escapeRe).join("")}]`,
);

/**
 * Which low-signal classes a record's content matches.
 *
 * Classes overlap on purpose — a truncated `<task-notification>` is three of them
 * — so the per-class counts sum well above the number of affected records and the
 * UNION is the only number that may be quoted as a share.
 *
 * Prefixes are tested with a leading-whitespace tolerance but no trimming of the
 * body, because `pasteDump` is a statement about the raw stored length (the
 * 500-char capture ceiling in memory_auto_capture.truncate()).
 *
 * @param {string} content
 * @returns {string[]} subset of {@link LOW_SIGNAL_CLASSES}, in declaration order
 */
function classifyLowSignal(content) {
  const text = typeof content === "string" ? content : String(content == null ? "" : content);
  const hit = [];
  const lead = text.replace(/^\s+/, "");

  if (lead.startsWith(LOW_SIGNAL.TASK_NOTIFICATION_PREFIX)) hit.push("taskNotification");
  if (lead.slice(0, LOW_SIGNAL.SKILL_ECHO_PREFIX.length).toLowerCase() === LOW_SIGNAL.SKILL_ECHO_PREFIX) {
    hit.push("skillEcho");
  }
  if (SLASH_OR_TAG_RE.test(text)) hit.push("slashOrTag");
  if (text.length < LOW_SIGNAL.CONTINUATION_MAX_CHARS && CONTINUATION_RE.test(text)) hit.push("continuation");
  if (text.length >= LOW_SIGNAL.PASTE_DUMP_MIN_CHARS) hit.push("pasteDump");
  if (!text.trim()) hit.push("empty");

  return hit;
}

/**
 * The classes the WRITE path is allowed to refuse — a deliberate SUBSET of
 * {@link LOW_SIGNAL_CLASSES}, because reporting junk and destroying it are
 * different licences.
 *
 * Every member here is machine-generated text the user never typed:
 *   `taskNotification` — the harness's `<task-notification>` envelope. 1,424 of
 *     the 1,441 `slashOrTag` hits are these; the biggest single duplicate group
 *     in the store is 96 identical copies of one of them.
 *   `skillEcho` — `Base directory for this skill: …`, emitted by skill loading.
 *     370 records across 75 distinct skill paths.
 *   `empty` — content that trims to nothing. Measured zero in the corpus; kept
 *     because it costs nothing and refusing to store a blank cannot lose data.
 *
 * DELIBERATELY EXCLUDED, each verified against the real 5,600-record corpus:
 *
 *   `pasteDump` (>= 495 chars) — 1,737 auto-capture records, the largest class,
 *     and NOT excluded for its size. Length is a proxy for "was truncated", not
 *     for "is noise": a user pasting a real spec, a stack trace or a log excerpt
 *     produces exactly this shape, and the class cannot tell those from a dump.
 *     Gating it would be the single largest data loss in the store's history,
 *     decided by a character count. The lens keeps reporting it; the writer will
 *     not act on it.
 *
 *   `slashOrTag` — the `<` half is safe (`<bash-stdout>`, `<teammate-message>`),
 *     but the `/` half is not. Of the 4 corpus records that start with `/` and
 *     are not already `taskNotification`, THREE are genuine user questions
 *     ("/v1/admin/providers => luồng này lưu vào đâu?"). Excluding the whole
 *     class costs 13 junk records corpus-wide — everything else it catches is
 *     already caught by `taskNotification` — and buys immunity from a rule that
 *     is wrong 75% of the time on the records only it can see.
 *
 *   `continuation` (< 60 chars, opens with an assent token) — 47 records, and
 *     reading all 47 is what settles it. "ok push và tạo pr and merge main đi",
 *     "đồng ý, tôi muốn validate gate là strict nhất", "ok, keep nó minimal
 *     nhất" are directives and stated preferences that happen to OPEN with an
 *     assent token. Perhaps five of the 47 are bare assent. As a lens class that
 *     is a fair 0.8% reading; as a delete rule it is ~90% false positives.
 *
 * Classes are named, never re-derived: {@link assertGateClassesAreReal} fails
 * loudly if the contract renames one, rather than letting the gate silently
 * match nothing.
 */
const NOISE_GATE_CLASSES = Object.freeze(["taskNotification", "skillEcho", "empty"]);

function assertGateClassesAreReal() {
  const unknown = NOISE_GATE_CLASSES.filter((c) => !LOW_SIGNAL_CLASSES.includes(c));
  if (unknown.length) {
    throw new RangeError(
      `low_signal.js: gate class(es) ${unknown.join(", ")} are not in LOW_SIGNAL_CLASSES — ` +
      "the write-side gate would match nothing and the noise would return silently",
    );
  }
}
assertGateClassesAreReal();

/**
 * The gated classes a piece of content matches, in declaration order. Empty
 * array means "store it".
 *
 * @param {string} content  The content AS IT WOULD BE STORED (post-truncate), so
 *   the writer and the lens classify the same string.
 * @returns {string[]} subset of {@link NOISE_GATE_CLASSES}
 */
function noiseClasses(content) {
  return classifyLowSignal(content).filter((c) => NOISE_GATE_CLASSES.includes(c));
}

module.exports = {
  classifyLowSignal,
  noiseClasses,
  NOISE_GATE_CLASSES,
  CONTINUATION_RE,
  SLASH_OR_TAG_RE,
};
