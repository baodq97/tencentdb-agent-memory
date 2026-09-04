#!/usr/bin/env node
/**
 * Auto-capture: save each conversation turn to local FTS5 for immediate recall.
 *
 * Called by the Stop hook after every turn. Saves the user+assistant text as a
 * lightweight L1 episodic atom so it's searchable via FTS5 immediately — no need
 * to wait for /memory-seed.
 *
 * Every N turns (configurable), also increments a consolidation counter. When
 * the counter reaches the threshold, the next UserPromptSubmit can inject a
 * hint that consolidation is due.
 *
 * Usage (from hook):
 *   require('./memory_auto_capture.js').autoCapture({ userText, assistantText, sessionId, cwd })
 *
 * Standalone:
 *   node scripts/memory_auto_capture.js --help
 *   node scripts/memory_auto_capture.js status
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// Governs the TIER-0 persona projection injected once per session by the
// SessionStart hook, which multiplies it back by CHARS_PER_TOKEN.
//
// IMPORTED, not copied: this and persona_projection's DEFAULT_TIER0_MAX_CHARS are
// the same budget expressed in two units, and two literals in two modules coupled
// only by comments WILL drift — a comment cannot fail a build. Tokens are the
// primitive, so this is an alias, not a conversion: no rounding, and the hook's
// tokens*CHARS_PER_TOKEN round trip is exact.
//
// This is a ONCE-PER-SESSION cost, not per turn: the per-turn channel is tier 1
// (DEFAULT_TIER1_MAX_CHARS = 420, ~105 tok) and it was deliberately NOT widened.
// At the old 300 tok this budget delivered 5 of 47 always-duty bullets, 4 of them
// cut mid-rule; standing instructions truncated before their operative clause are
// worse than absent, because they read as a different rule.
//
// UNGUARDED, and deliberately so. It used to be a guarded require of
// persona_projection.js with a hand-copied `1200` fallback, because this file is
// on the Stop hook's capture path and a missing sibling must never cost a turn.
// constants.js is a different kind of dependency: a leaf that requires nothing,
// has no code to fail and no transitive surface to go missing independently of
// this file. Guarding it would buy nothing and cost a second copy of the number —
// which is the drift the import exists to prevent.
const { DEFAULT_TIER0_MAX_TOKENS: DEFAULT_PERSONA_MAX_TOKENS } = require("./constants.js");

// Counter arm of the trigger. Lowered from 20 on measurement, not taste: at 20
// the median turn waited 1.86 h and 15.2% of turns were never consolidated at
// all; at 10 that is 0.63 h and 10.5%. See consolidationTrigger below for the
// full curve and the cost it buys.
const DEFAULT_CONSOLIDATE_EVERY = 10;
/** Session arm: below 3 new turns a session has produced too little to distil. */
const DEFAULT_CONSOLIDATE_ON_SESSION_END = 3;
/** The only model whose consolidation output has been measured end to end. */
const DEFAULT_CONSOLIDATE_MODEL = "sonnet";
/** Measured 7.2 runs/day on real traffic; 12 leaves headroom and bounds a runaway. */
const DEFAULT_CONSOLIDATE_MAX_RUNS_PER_DAY = 12;
/** ~3x the measured $0.4538 of one run, so a pathological run is capped, not free. */
const DEFAULT_CONSOLIDATE_BUDGET_USD = 1.5;
const DEFAULT_SCENE_MAX_TOKENS = 200;
const MAX_CONTENT_LENGTH = 500;
const DEFAULT_NOISE_GATE = true;

// Delegated, not re-derived: this module already requires memory_writer, and a
// second copy of the root is how the override came to be missing in seven places.
const { memoryBaseDir } = require("./memory_writer.js");

function captureStatePath() {
  return path.join(memoryBaseDir(), "capture_state.json");
}

function loadCaptureState() {
  try {
    return JSON.parse(fs.readFileSync(captureStatePath(), "utf-8"));
  } catch {
    return { turn_count: 0, last_consolidation_turn: 0, sessions: {} };
  }
}

function saveCaptureState(state) {
  const p = captureStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

// ── user config (persisted separately from volatile capture state) ──
function configPath() {
  return path.join(memoryBaseDir(), "config.json");
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf-8")); } catch { return {}; }
}

function saveConfig(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

// ── warmup doubling (upstream pipeline-manager parity) ──
//
// A fresh store should consolidate almost immediately so a new project isn't
// blind; then the cadence backs off by doubling (1→2→4→8→…) until it reaches
// the steady `everyN`, after which it graduates (`warmup_threshold: 0` ⇒ use
// everyN directly). This accelerates the L1/consolidation TRIGGER only — persona
// synthesis still rides the cascade's L3 step, so a persona is never built from
// a handful of atoms. Both pure: state in, number/mutation out.
function warmupThreshold(state, everyN) {
  const wt = state && state.warmup_threshold;
  if (wt === 0) return everyN;                               // graduated
  if (!Number.isInteger(wt) || wt < 1) return Math.min(1, everyN); // fresh
  return Math.min(wt, everyN);
}

function advanceWarmup(state, everyN) {
  if (!state || state.warmup_threshold === 0) return;        // already graduated
  const wt = Number.isInteger(state.warmup_threshold) && state.warmup_threshold >= 1
    ? state.warmup_threshold : 1;
  const next = wt * 2;
  state.warmup_threshold = next >= everyN ? 0 : next;
}

/**
 * Should this project consolidate now, and which arm decided?
 *
 * Pure: slot and config in, a label or null out. No I/O, so the policy can be
 * tested exhaustively without a store — which matters because this predicate is
 * the thing that decides how stale the whole memory system is allowed to get.
 *
 * TWO ARMS, AND THE `OR` IS THE POINT. Measured over 14 days of real traffic
 * (838 injected turns, 17 projects), a counter alone cannot serve short-lived
 * projects: the median session is 4 turns, so a project whose sessions are short
 * never accumulates enough to fire at ANY threshold. 33.5% of turns were never
 * consolidated under a counter of 40, and still 3.8% under a counter of 5 — at
 * three times the cost. A session-boundary arm alone has the opposite hole: a
 * long session accrues knowledge for hours with nothing distilled until it ends.
 *
 * Simulated on that same turn stream, `(session end AND delta>=3) OR delta>=10`
 * gives p50 lag 0.58 h and p90 4.21 h with 1.9% never served, against 4.37 h /
 * 105 h / 33.5% for the counter-only policy that shipped before it. The
 * simulation reproduces the independently measured lag of the old policy
 * (4.37 h simulated vs 4.15 h from the changelogs), which is what makes the rest
 * of the curve usable rather than a guess.
 *
 * The session arm is checked FIRST so its label wins when both fire: it is the
 * more specific fact about why this run happened, and the runs log is the only
 * evidence available afterwards for whether the policy is behaving.
 *
 * `warmupThreshold` still gates the counter arm. It exists so a brand-new store
 * consolidates almost immediately instead of sitting blind until turn 10, and
 * nothing here supersedes that.
 *
 * @param {{turn_count?:number,last_consolidation_turn?:number,warmup_threshold?:number}} slot
 * @param {{every:number,sessionEndMin:number}} cfg
 * @param {{sessionEnding?:boolean}} [opts]
 * @returns {"session-end"|"counter"|null}
 */
function consolidationTrigger(slot, cfg, opts) {
  const s = slot || {};
  const delta = (s.turn_count || 0) - (s.last_consolidation_turn || 0);
  if (delta <= 0) return null;          // nothing new; never spend a run on it

  const sessionEndMin = Number.isInteger(cfg && cfg.sessionEndMin) && cfg.sessionEndMin > 0
    ? cfg.sessionEndMin : DEFAULT_CONSOLIDATE_ON_SESSION_END;
  const every = Number.isInteger(cfg && cfg.every) && cfg.every > 0
    ? cfg.every : DEFAULT_CONSOLIDATE_EVERY;

  if (opts && opts.sessionEnding && delta >= sessionEndMin) return "session-end";
  if (delta >= warmupThreshold(s, every)) return "counter";
  return null;
}

// ── per-project counter slots (GAP-5 fix) ──
//
// The turn counter and consolidation trigger are PER-PROJECT: capture_state.json
// keeps `projects[<hash>]` = { turn_count, last_consolidation_turn,
// consolidation_due, warmup_threshold }. The root `turn_count` is retained only
// as a global odometer for whole-root throttles (digest, blind sweep) — it no
// longer drives the trigger. `warmupThreshold`/`advanceWarmup` above are pure and
// read `.warmup_threshold`, so they operate on a slot unchanged.
const GLOBAL_SLOT_KEY = "global";
function slotKey(hash) { return hash || GLOBAL_SLOT_KEY; }

/**
 * Episodic atom count already in a project's store, read-only, fail-open to 0.
 * Used ONLY to seed a project-slot the first time it is seen so an upgrade does
 * not make every established store "due" at once.
 */
function episodicCount(hash) {
  try {
    const base = hash
      ? path.join(memoryBaseDir(), "projects", hash)
      : path.join(memoryBaseDir(), "global");
    const db = path.join(base, "index.db");
    if (!fs.existsSync(db)) return 0;
    const { MemoryStore } = require(path.join(__dirname, "memory_store.js"));
    const store = new MemoryStore(db, { readOnly: true });
    const n = store.count("episodic");
    store.close();
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Read-only view of a project-slot: stored slot or a zero default, NO mutation. */
function readSlot(state, hash) {
  const s = state && state.projects && state.projects[slotKey(hash)];
  return s && typeof s === "object"
    ? s
    : { turn_count: 0, last_consolidation_turn: 0, consolidation_due: false };
}

/**
 * Get-or-seed a project-slot on the WRITE path. First sight of a project seeds
 * its counter to the atoms that already existed BEFORE this turn (baseline), so
 * an established store migrates in "not due" (baseline > 0 ⇒ warmup graduated),
 * while a brand-new store (baseline 0) keeps the fresh warmup fast-path.
 */
function ensureSlot(state, hash) {
  if (!state.projects) state.projects = {};
  const k = slotKey(hash);
  if (!state.projects[k]) {
    const baseline = Math.max(0, episodicCount(hash) - 1); // exclude the atom written this turn
    state.projects[k] = {
      turn_count: baseline,
      last_consolidation_turn: baseline,
      consolidation_due: false,
    };
    if (baseline > 0) state.projects[k].warmup_threshold = 0; // established store: graduated
  }
  return state.projects[k];
}

/** Default hash for callers that don't pass one: the current project. */
function activeHash() {
  return projectHashForCwd(process.cwd());
}

/** Effective consolidation threshold: env override > persisted config > default. */
function getConsolidateEvery() {
  const env = parseInt(process.env.MEMORY_CONSOLIDATE_EVERY || "", 10);
  if (Number.isInteger(env) && env > 0) return env;
  const stored = parseInt(loadConfig().consolidate_every, 10);
  if (Number.isInteger(stored) && stored > 0) return stored;
  return DEFAULT_CONSOLIDATE_EVERY;
}

/** Persist the consolidation threshold. Throws on invalid (non-positive-int) input. */
function setConsolidateEvery(n) {
  const v = parseInt(n, 10);
  if (!Number.isInteger(v) || v < 1) throw new Error("consolidate-every must be a positive integer");
  const cfg = loadConfig();
  cfg.consolidate_every = v;
  saveConfig(cfg);
  return v;
}

/** Effective scene-navigation token budget: env override > persisted config > default. 0 disables. */
function getSceneMaxTokens() {
  const env = parseInt(process.env.MEMORY_SCENE_MAX_TOKENS || "", 10);
  if (Number.isInteger(env) && env >= 0) return env;
  const stored = parseInt(loadConfig().scene_max_tokens, 10);
  if (Number.isInteger(stored) && stored >= 0) return stored;
  return DEFAULT_SCENE_MAX_TOKENS;
}

/* ── headless auto-consolidation settings ──────────────────────────────────
 *
 * One generic reader instead of five near-identical ones. The existing explicit
 * accessors above are left alone: rewriting working config paths is not what
 * this change is for, and a half-converted set of readers would be worse than
 * either convention on its own.
 *
 * Precedence matches every other setting here — env override > persisted
 * config > default — so a run can be redirected for one invocation without
 * mutating the user's config.json.
 */
function numSetting(envKey, cfgKey, dflt, min) {
  const floor = min === undefined ? 1 : min;
  const env = Number(process.env[envKey]);
  if (Number.isFinite(env) && env >= floor) return env;
  const stored = Number(loadConfig()[cfgKey]);
  if (Number.isFinite(stored) && stored >= floor) return stored;
  return dflt;
}

/**
 * Is unattended headless consolidation allowed at all?
 *
 * Defaults ON. The measured failure it fixes is not marginal: 74% of sessions
 * had no consolidation while they were running and 19% of turns still have none,
 * so shipping it off by default would leave every existing store in the state
 * the measurement condemned. It is still a switch, because it spends the user's
 * model quota — roughly 4.3M tokens a day at the measured cadence, on the same
 * rate-limit pool as their interactive work.
 */
function getAutoConsolidate() {
  const env = parseBoolish(process.env.MEMORY_AUTO_CONSOLIDATE);
  if (env !== null) return env;
  const stored = parseBoolish(loadConfig().auto_consolidate);
  if (stored !== null) return stored;
  return true;
}

function setAutoConsolidate(v) {
  const parsed = parseBoolish(v);
  if (parsed === null) throw new Error("auto-consolidate must be on or off (also accepts 1/0, true/false, yes/no)");
  const cfg = loadConfig();
  cfg.auto_consolidate = parsed ? "on" : "off";
  saveConfig(cfg);
  return parsed;
}

/** Session arm of the trigger: minimum new turns for an ending session to be worth a run. */
function getConsolidateOnSessionEnd() {
  return numSetting("MEMORY_CONSOLIDATE_ON_SESSION_END", "consolidate_on_session_end",
    DEFAULT_CONSOLIDATE_ON_SESSION_END, 1);
}

function setConsolidateOnSessionEnd(n) {
  const v = parseInt(n, 10);
  if (!Number.isInteger(v) || v < 1) throw new Error("consolidate-on-session-end must be a positive integer");
  const cfg = loadConfig();
  cfg.consolidate_on_session_end = v;
  saveConfig(cfg);
  return v;
}

/**
 * Model for the headless run. Configurable but defaulted to the only one with a
 * measured result: distilling atoms into scene facts is a judgement task, and a
 * wrong fact written into memory is worse than no fact — it is then retrieved
 * and believed. A cheaper model may well be fine; nobody has measured it.
 */
function getConsolidateModel() {
  const env = String(process.env.MEMORY_CONSOLIDATE_MODEL || "").trim();
  if (env) return env;
  const stored = String(loadConfig().consolidate_model || "").trim();
  if (stored) return stored;
  return DEFAULT_CONSOLIDATE_MODEL;
}

function setConsolidateModel(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) throw new Error("consolidate-model must be a non-empty model name");
  const cfg = loadConfig();
  cfg.consolidate_model = s;
  saveConfig(cfg);
  return s;
}

/** Hard ceiling on unattended runs per day, machine-wide. */
function getConsolidateMaxRunsPerDay() {
  return numSetting("MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY", "consolidate_max_runs_per_day",
    DEFAULT_CONSOLIDATE_MAX_RUNS_PER_DAY, 0);
}

function setConsolidateMaxRunsPerDay(n) {
  const v = parseInt(n, 10);
  if (!Number.isInteger(v) || v < 0) throw new Error("consolidate-max-runs-per-day must be a non-negative integer (0 disables auto runs)");
  const cfg = loadConfig();
  cfg.consolidate_max_runs_per_day = v;
  saveConfig(cfg);
  return v;
}

/** Per-run spend ceiling handed to `claude -p --max-budget-usd`. */
function getConsolidateBudgetUsd() {
  return numSetting("MEMORY_CONSOLIDATE_BUDGET_USD", "consolidate_budget_usd",
    DEFAULT_CONSOLIDATE_BUDGET_USD, 0.01);
}

function setConsolidateBudgetUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0.01) throw new Error("consolidate-budget-usd must be a number >= 0.01");
  const cfg = loadConfig();
  cfg.consolidate_budget_usd = v;
  saveConfig(cfg);
  return v;
}

/** Persist the scene-navigation token budget. 0 = disable scene-nav; throws on negative/non-int. */
function setSceneMaxTokens(n) {
  const v = parseInt(n, 10);
  if (!Number.isInteger(v) || v < 0) throw new Error("scene-max-tokens must be a non-negative integer (0 disables)");
  const cfg = loadConfig();
  cfg.scene_max_tokens = v;
  saveConfig(cfg);
  return v;
}

/**
 * Effective persona-projection byte budget: env override > persisted config > default.
 *
 * Unlike scene-max-tokens, 0 is rejected rather than treated as "disable": the persona
 * preamble is what conditions the agent's behaviour, and a silently-empty projection
 * looks identical to "no persona learned yet" from the agent's side — the exact failure
 * mode this store exists to fix. Trimming the budget is fine; switching it off is not.
 */
function getPersonaMaxTokens() {
  const env = parseInt(process.env.MEMORY_PERSONA_MAX_TOKENS || "", 10);
  if (Number.isInteger(env) && env > 0) return env;
  const stored = parseInt(loadConfig().persona_max_tokens, 10);
  if (Number.isInteger(stored) && stored > 0) return stored;
  return DEFAULT_PERSONA_MAX_TOKENS;
}

/** Persist the persona-projection byte budget. Throws on non-positive/non-int input. */
function setPersonaMaxTokens(n) {
  const v = parseInt(n, 10);
  if (!Number.isInteger(v) || v < 1) throw new Error("persona-max-tokens must be a positive integer (0 is not allowed — it would silently disable persona conditioning)");
  const cfg = loadConfig();
  cfg.persona_max_tokens = v;
  saveConfig(cfg);
  return v;
}

/**
 * Is the low-signal noise gate on? env override > persisted config > default (ON).
 *
 * `MEMORY_NOISE_GATE=0|off|false` disables it for one run; `tmem config
 * noise-gate off` disables it persistently. The escape hatch exists because this
 * is the only setting in this file that DESTROYS input rather than trimming
 * output — if a predicate turns out to be wrong for someone's corpus, they must
 * be able to switch it off without editing code, and then read
 * `changelog.jsonl` to see exactly what it ate.
 */
function getNoiseGateEnabled() {
  const env = parseBoolish(process.env.MEMORY_NOISE_GATE);
  if (env !== null) return env;
  const stored = parseBoolish(loadConfig().noise_gate);
  if (stored !== null) return stored;
  return DEFAULT_NOISE_GATE;
}

/**
 * null = "not set / unparseable", which is what lets env fall through to config.
 *
 * Exported because `tmem config` must accept the same on/off vocabulary for every
 * key it has — a CLI that takes `yes` for `noise-gate` and exits 1 for `recall`
 * is a bug the user meets before any test does.
 */
function parseBoolish(v) {
  if (v === true || v === false) return v;
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (["1", "on", "true", "yes"].includes(s)) return true;
  if (["0", "off", "false", "no"].includes(s)) return false;
  return null;
}

/** Persist the noise-gate switch. Throws on anything that isn't clearly on or off. */
function setNoiseGateEnabled(v) {
  const parsed = parseBoolish(v);
  if (parsed === null) throw new Error("noise-gate must be on or off");
  const cfg = loadConfig();
  cfg.noise_gate = parsed;
  saveConfig(cfg);
  return parsed;
}

/**
 * Which gated low-signal classes this content matches — the predicates come from
 * `low_signal.js`, the same ones `tmem view` reports with, never a local copy.
 *
 * FAILS OPEN. If the classifier cannot be loaded at all, this returns `[]` and
 * the record is stored. A gate that cannot be evaluated must not become a gate
 * that rejects everything: losing a turn is worse than keeping a noisy one, and
 * that is the whole reason the audit chose a write-side filter over a delete.
 */
function noiseClassesFor(content) {
  try {
    return require(path.join(__dirname, "low_signal.js")).noiseClasses(content);
  } catch {
    return [];
  }
}

/**
 * Record a refusal where `tmem changelog` will show it.
 *
 * A gate that drops input silently is unauditable — the point of logging the
 * matched CLASS (not just "skipped") is that a wrong rule can be found later by
 * grepping for it, and the 100-char preview matches what `writeL1Record()`
 * stores for a creation, so the two entry kinds read the same way.
 */
function logSkip(projectBase, { content, classes, sessionId }) {
  try {
    fs.mkdirSync(projectBase, { recursive: true });
    const { appendChangelog } = require(path.join(__dirname, "memory_writer.js"));
    appendChangelog(projectBase, {
      action: "skipped",
      type: "l1",
      id: null,
      memoryType: "episodic",
      reason: "low-signal",
      classes,
      chars: content.length,
      session_id: sessionId || "",
      content: content.slice(0, 100),
      timestamp: new Date().toISOString(),
    });
  } catch {}
}

/**
 * The store slug for `cwd`. The other require on the capture path with the same
 * exposure the top-level one had: lazy, so it does not break loading, but called
 * from autoCapture() OUTSIDE any try, so a missing memory_reader.js threw the
 * whole turn away rather than storing it.
 *
 * Degrades to "" — which autoCapture already treats as "no project context" and
 * routes to the global store, exactly as it does for a hook invoked with no cwd.
 * Deliberately NOT a locally reimplemented hash: a slug that disagreed with
 * memory_reader's would split one project's memories across two stores silently,
 * and the atom would then be unfindable from the project it belongs to. Global is
 * the wrong shelf but a real one — cross-project search still reaches it.
 */
function projectHashForCwd(cwd) {
  try {
    const { projectHashForCwd: hash } = require(path.join(__dirname, "memory_reader.js"));
    return hash(cwd);
  } catch {
    return "";
  }
}

function generateId() {
  return `ac_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "...";
}

function isSubstantive(text) {
  if (!text || text.length < 15) return false;
  if (text.startsWith("<command-name>") || text.startsWith("<local-command")) return false;
  if (text.startsWith("<system-reminder>")) return false;
  return true;
}

/**
 * Auto-capture a conversation turn to local FTS5.
 *
 * @param {object} opts
 * @param {string} opts.userText - User's message text
 * @param {string} opts.assistantText - Assistant's response text
 * @param {string} opts.sessionId - Session ID
 * @param {string} opts.cwd - Current working directory (for project hash)
 * @returns {{ captured: boolean, turnCount: number, consolidationDue: boolean }}
 */
function autoCapture({ userText, assistantText, sessionId, cwd, sourceMessageIds, gitBranch, transcriptPath }) {
  if (!isSubstantive(userText)) {
    return { captured: false, turnCount: 0, consolidationDue: false };
  }

  const projectHash = cwd ? projectHashForCwd(cwd) : "";
  const projectBase = projectHash
    ? path.join(memoryBaseDir(), "projects", projectHash)
    : path.join(memoryBaseDir(), "global");

  const content = truncate(userText, MAX_CONTENT_LENGTH);

  // The low-signal gate. Classifies the string AS IT WOULD BE STORED, so the
  // writer and `tmem view` are looking at the same text. See low_signal.js for
  // which classes are gated and — more importantly — which measured classes are
  // deliberately NOT (pasteDump, slashOrTag, continuation all match genuine user
  // content in the real corpus).
  if (getNoiseGateEnabled()) {
    const classes = noiseClassesFor(content);
    if (classes.length) {
      logSkip(projectBase, { content, classes, sessionId });
      return { captured: false, skipped: true, skipClasses: classes, turnCount: 0, consolidationDue: false };
    }
  }

  const record = {
    id: generateId(),
    content,
    type: "episodic",
    priority: 50,
    scene_name: "auto-capture",
    // The cross-layer link, measured DEAD (always []). Record the real transcript
    // uuids so consolidate can read the whole turn (user + assistant + tool
    // results) back and distil an outcome-aware atom, instead of the verbatim
    // prompt this row currently holds.
    source_message_ids: Array.isArray(sourceMessageIds) ? sourceMessageIds : [],
    metadata: {
      auto_captured: true,
      session_id: sessionId || "",
      // Pointer to the L0 slice for consolidate-time distillation (WS5).
      pointer: {
        sessionId: sessionId || "",
        lastUuid: (Array.isArray(sourceMessageIds) && sourceMessageIds.length) ? sourceMessageIds[sourceMessageIds.length - 1] : "",
        cwd: cwd || "",
        gitBranch: gitBranch || "",
        transcriptPath: transcriptPath || "",
      },
    },
    timestamps: [new Date().toISOString()],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionKey: sessionId ? `claude-code:${sessionId}` : "",
    sessionId: sessionId || "",
  };

  // Route through the ONE canonical L1 writer: it appends the durable JSONL
  // record (carrying source_message_ids + the L0 pointer), indexes into FTS, AND
  // logs the write to the changelog — the hand-rolled upsert used to skip the
  // changelog, so auto-captured atoms were invisible to `tmem changelog`.
  try {
    const { writeL1Record } = require(path.join(__dirname, "memory_writer.js"));
    writeL1Record(projectBase, record);
  } catch {
    return { captured: false, turnCount: 0, consolidationDue: false };
  }

  const state = loadCaptureState();
  state.turn_count = (state.turn_count || 0) + 1; // global odometer (digest/blind throttle only)

  if (!state.sessions) state.sessions = {};
  if (!state.sessions[sessionId]) state.sessions[sessionId] = { turns: 0 };
  state.sessions[sessionId].turns = (state.sessions[sessionId].turns || 0) + 1;
  state.sessions[sessionId].last_capture = new Date().toISOString();

  // Per-project counter drives the trigger — a project accrues and consolidates
  // independently of every other project on the machine.
  const slot = ensureSlot(state, projectHash);
  slot.turn_count = (slot.turn_count || 0) + 1;

  // Routed through the ONE predicate rather than re-deriving the comparison here.
  // The counter arm and the session-end arm have to agree about what "due" means,
  // and two copies of the rule is how they would stop agreeing.
  const sinceLastConsolidation = slot.turn_count - (slot.last_consolidation_turn || 0);
  const consolidationDue = consolidationTrigger(
    slot,
    { every: getConsolidateEvery(), sessionEndMin: getConsolidateOnSessionEnd() },
    { sessionEnding: false },
  ) === "counter";

  if (consolidationDue) slot.consolidation_due = true;

  saveCaptureState(state);

  return {
    captured: true,
    turnCount: slot.turn_count,
    consolidationDue,
  };
}

/**
 * Check if consolidation is due and return hint text for injection.
 * Called by UserPromptSubmit hook.
 */
// Monotonic per-turn counter, independent of the consolidation cycle. Used to
// throttle whole-root maintenance scans (e.g. the pipeline's blind-store sweep)
// so they don't open every project store on every Stop. 0 on any read failure.
function getTurnCount() {
  try { return loadCaptureState().turn_count || 0; } catch { return 0; }
}

function checkConsolidationDue(hash) {
  try {
    const state = loadCaptureState();
    const slot = readSlot(state, hash !== undefined ? hash : activeHash());
    if (!slot.consolidation_due) return null;
    const threshold = getConsolidateEvery();
    const sinceLastConsolidation = (slot.turn_count || 0) - (slot.last_consolidation_turn || 0);
    return {
      due: true,
      turnsSinceConsolidation: sinceLastConsolidation,
      threshold,
      message: `Memory consolidation is due (${sinceLastConsolidation} turns since last). Consider running /memory-seed to extract high-quality memories.`,
    };
  } catch {
    return null;
  }
}

/**
 * Mark consolidation as completed for a project (called after a run finishes).
 * Scoped to the project-slot; other projects' counters are untouched.
 */
function markConsolidated(hash) {
  const state = loadCaptureState();
  const slot = ensureSlot(state, hash !== undefined ? hash : activeHash());
  slot.last_consolidation_turn = slot.turn_count || 0;
  slot.consolidation_due = false;
  slot.last_consolidation_time = new Date().toISOString();
  advanceWarmup(slot, getConsolidateEvery()); // back the warmup cadence off one step
  state.last_consolidation_time = slot.last_consolidation_time; // global mirror for legacy readers
  saveCaptureState(state);
}

function status(hash) {
  const state = loadCaptureState();
  const slot = readSlot(state, hash !== undefined ? hash : activeHash());
  const threshold = warmupThreshold(slot, getConsolidateEvery());
  const since = (slot.turn_count || 0) - (slot.last_consolidation_turn || 0);
  return {
    total_turns: slot.turn_count || 0,
    turns_since_consolidation: since,
    consolidation_threshold: threshold,
    consolidation_due: !!slot.consolidation_due,
    last_consolidation_time: slot.last_consolidation_time || state.last_consolidation_time || null,
    active_sessions: Object.keys(state.sessions || {}).length,
    global_turns: state.turn_count || 0,
  };
}

// ── CLI ──
function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "--help") {
    console.log(`Usage: node memory_auto_capture.js <command>

Commands:
  status              Show capture state and consolidation status
  mark-consolidated   Reset consolidation counter
  reset               Reset all capture state`);
    return;
  }

  if (cmd === "status") {
    console.log(JSON.stringify(status(), null, 2));
  } else if (cmd === "mark-consolidated") {
    markConsolidated();
    console.log("Consolidation marked complete");
  } else if (cmd === "reset") {
    try { fs.unlinkSync(captureStatePath()); } catch {}
    console.log("Capture state reset");
  }
}

if (require.main === module) main();

module.exports = { autoCapture, checkConsolidationDue, getTurnCount, markConsolidated, status, getConsolidateEvery, setConsolidateEvery, warmupThreshold, advanceWarmup, consolidationTrigger,
  getAutoConsolidate, setAutoConsolidate, getConsolidateOnSessionEnd, setConsolidateOnSessionEnd,
  getConsolidateModel, setConsolidateModel, getConsolidateMaxRunsPerDay, setConsolidateMaxRunsPerDay,
  getConsolidateBudgetUsd, setConsolidateBudgetUsd, getSceneMaxTokens, setSceneMaxTokens, getPersonaMaxTokens, setPersonaMaxTokens, getNoiseGateEnabled, setNoiseGateEnabled, parseBoolish, loadConfig };
