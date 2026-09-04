#!/usr/bin/env node
/**
 * The leaf. Values shared across module boundaries, and NOTHING else.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two different problems, one cause: constants had been living inside the
 * modules that happened to use them first, so anything else that needed a value
 * had to import a module far larger than the value.
 *
 *   1. LOAD COST ON THE STOP HOOK. `memory_auto_capture.js` runs on every
 *      captured turn. It reaches `low_signal.js`, which reached
 *      `view/contract.js` — 1300 lines of documentation, frozen shape
 *      declarations and validators — to read two objects. Measured at ~1.2 ms of
 *      module load, every turn, for a threshold and a list of six strings.
 *   2. LITERALS COPIED BETWEEN MODULES. `CHARS_PER_TOKEN = 4` was declared
 *      independently in `persona_projection.js` and `scene_nav.js`, and
 *      `DEFAULT_TIER0_MAX_TOKENS` had a hand-copied `1200` sitting in
 *      `memory_auto_capture.js` behind a guarded require, pinned only by a test
 *      that regexed the source file for the literal. A constant that has to be
 *      guarded to be imported is a constant in the wrong module.
 *
 * THE RULE THAT KEEPS IT USEFUL: this module requires nothing — not even a node
 * builtin — and defines no functions. That is what makes it free to import from
 * anywhere, including the two modules (`persona_projection.js`,
 * `view/transform.js`) whose tests assert they perform no I/O. Adding a require
 * here would silently spend the budget this file exists to protect, and would
 * put a dependency inside the purity tests' blast radius.
 *
 * A value belongs here when it CROSSES a module boundary. Values only one module
 * uses stay where they are used; the modules that own a value's MEANING re-export
 * it (`view/contract.js` for the low-signal taxonomy, `persona_projection.js` for
 * the budgets), so existing imports keep working and the documentation stays next
 * to the decision it explains.
 */
"use strict";

/* ------------------------------------------------------------------ *
 * Low-signal taxonomy — shared by the WRITE gate and the LENS.
 *
 * `view/contract.js` re-exports both of these and carries the full rationale:
 * how the classes were calibrated against the real store, which candidate
 * classes were rejected, and why the union is pinned separately. The VALUES live
 * here so `low_signal.js` — and through it the Stop hook — can read them without
 * loading the contract.
 * ------------------------------------------------------------------ */

/** The classes the lens reports. Order is meaningful: it is the report order. */
const LOW_SIGNAL_CLASSES = Object.freeze([
  "taskNotification", "skillEcho", "slashOrTag", "continuation", "pasteDump", "empty",
]);

/**
 * Classifier thresholds and prefixes, shared verbatim by the classifier
 * (`low_signal.js`) and the UI legend (which explains it), so the two cannot
 * drift.
 *
 * `PASTE_DUMP_MIN_CHARS` is 495, not 500: `memory_auto_capture.truncate()` does
 * `slice(0, 500).trimEnd() + "..."`, so a capped record lands a few chars either
 * side of the ceiling depending on trailing whitespace. 495 catches the band
 * without reaching down into genuinely long-but-complete records.
 *
 * There is deliberately no bare minimum-length constant here.
 * `CONTINUATION_MAX_CHARS` is a bound on an assent token, not a quality
 * threshold, and it is only ever valid in conjunction with
 * `CONTINUATION_OPENERS` — see the `tooShort` rejection in `view/contract.js`.
 */
const LOW_SIGNAL = Object.freeze({
  CONTINUATION_MAX_CHARS: 60,
  PASTE_DUMP_MIN_CHARS: 495,
  TASK_NOTIFICATION_PREFIX: "<task-notification>",
  SKILL_ECHO_PREFIX: "base directory for this skill:",
  SLASH_OR_TAG_PREFIXES: Object.freeze(["/", "<"]),
  CONTINUATION_OPENERS: Object.freeze([
    "ok", "okay", "oke", "yes", "y", "yep", "sure", "go", "go ahead", "continue",
    "next", "tiếp", "tiep", "tiếp tục", "ừ", "u", "đồng ý", "dong y", "được", "duoc",
  ]),
});

/* ------------------------------------------------------------------ *
 * Budgets — shared by the projection, the recall path, the nav block and the
 * capture path's config resolver.
 *
 * `persona_projection.js` re-exports both and carries the rationale for the tier
 * economics (tier 0 is paid once per session, tier 1 every turn).
 * ------------------------------------------------------------------ */

/**
 * The ONE chars/token approximation (~4 chars/token for mixed EN/VI).
 *
 * It was declared independently in three modules, each with a comment naming the
 * other two — which is the drift hazard those comments were describing.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Tier-0 persona budget, in TOKENS. Tokens are the primitive because this is the
 * only budget the user can set in tokens (`tmem persona-max-tokens`), and the
 * SessionStart hook multiplies it back by CHARS_PER_TOKEN — a round trip that is
 * exact by construction only in this direction.
 */
const DEFAULT_TIER0_MAX_TOKENS = 1200;

/* ------------------------------------------------------------------ *
 * Vector eligibility — shared by the WRITE side, the READ side, and the LENS.
 *
 * `memory_store.js` owns the MEANING and re-exports both (its docblock carries
 * the measurement that produced the set: 98% of vectors were episodic, so every
 * KNN returned 10/10 neighbours that the read filter then dropped). The values
 * live HERE because a third consumer needs them and cannot reach that module:
 * `view/transform.js` computes embedding coverage, and two tests assert it
 * performs no I/O and loads no sqlite — which importing memory_store.js would
 * break. Without this, transform had to divide by ALL records, and reported 2%
 * coverage on a fully-synced store because 5,459 of 5,559 records are types the
 * writer deliberately never embeds. A denominator the fix command cannot move is
 * not a health metric.
 * ------------------------------------------------------------------ */

/** Types recall drops per-turn, and therefore types nothing should embed. */
const NON_RECALL_TYPES = new Set(["episodic", "persona"]);

/** Untyped records are eligible: absence of a type is not a decision to exclude. */
function isVectorEligible(type) { return !NON_RECALL_TYPES.has(String(type || "")); }

module.exports = {
  LOW_SIGNAL, LOW_SIGNAL_CLASSES,
  CHARS_PER_TOKEN, DEFAULT_TIER0_MAX_TOKENS,
  NON_RECALL_TYPES, isVectorEligible,
};
