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

const DEFAULT_CONSOLIDATE_EVERY = 20;
const DEFAULT_SCENE_MAX_TOKENS = 200;
// Governs the TIER-0 persona projection injected once per session by the
// SessionStart hook, which multiplies it back by 4 chars/token.
//
// DERIVED, not a literal: this and persona_projection's DEFAULT_TIER0_MAX_CHARS
// are the same budget expressed in two units, and two literals in two modules
// coupled only by comments WILL drift — a comment cannot fail a build. Importing
// is safe here: persona_projection is pure (its only dependency is grounding.js,
// which has none) and does no I/O, so this adds no cycle and loads nothing new.
// Tokens are the primitive over there, so this is an alias, not a conversion —
// no rounding, and the hook's tokens*CHARS_PER_TOKEN round trip is exact.
//
// This is a ONCE-PER-SESSION cost, not per turn: the per-turn channel is tier 1
// (DEFAULT_TIER1_MAX_CHARS = 420, ~105 tok) and it was deliberately NOT widened.
// At the old 300 tok this budget delivered 5 of 47 always-duty bullets, 4 of them
// cut mid-rule; standing instructions truncated before their operative clause are
// worse than absent, because they read as a different rule.
const { DEFAULT_TIER0_MAX_TOKENS } = require("./persona_projection.js");
const DEFAULT_PERSONA_MAX_TOKENS = DEFAULT_TIER0_MAX_TOKENS;
const MAX_CONTENT_LENGTH = 500;

function memoryBaseDir() {
  return path.join(os.homedir(), ".memory-tencentdb");
}

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

function projectHashForCwd(cwd) {
  const { projectHashForCwd: hash } = require(path.join(__dirname, "memory_reader.js"));
  return hash(cwd);
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
function autoCapture({ userText, assistantText, sessionId, cwd }) {
  if (!isSubstantive(userText)) {
    return { captured: false, turnCount: 0, consolidationDue: false };
  }

  const projectHash = cwd ? projectHashForCwd(cwd) : "";
  const projectBase = projectHash
    ? path.join(memoryBaseDir(), "projects", projectHash)
    : path.join(memoryBaseDir(), "global");

  const content = truncate(userText, MAX_CONTENT_LENGTH);

  const record = {
    id: generateId(),
    content,
    type: "episodic",
    priority: 50,
    scene_name: "auto-capture",
    source_message_ids: [],
    metadata: { auto_captured: true, session_id: sessionId || "" },
    timestamps: [new Date().toISOString()],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionKey: sessionId ? `claude-code:${sessionId}` : "",
    sessionId: sessionId || "",
  };

  try {
    const { MemoryStore } = require(path.join(__dirname, "memory_store.js"));
    const dbPath = path.join(projectBase, "index.db");
    fs.mkdirSync(projectBase, { recursive: true });
    const store = new MemoryStore(dbPath);
    store.upsert(record);
    store.close();
  } catch {
    return { captured: false, turnCount: 0, consolidationDue: false };
  }

  const recordsDir = path.join(projectBase, "records");
  try {
    fs.mkdirSync(recordsDir, { recursive: true });
    const d = new Date();
    const shard = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    fs.appendFileSync(path.join(recordsDir, `${shard}.jsonl`), JSON.stringify(record) + "\n", "utf-8");
  } catch {}

  const state = loadCaptureState();
  state.turn_count = (state.turn_count || 0) + 1;

  if (!state.sessions) state.sessions = {};
  if (!state.sessions[sessionId]) state.sessions[sessionId] = { turns: 0 };
  state.sessions[sessionId].turns = (state.sessions[sessionId].turns || 0) + 1;
  state.sessions[sessionId].last_capture = new Date().toISOString();

  const threshold = getConsolidateEvery();
  const sinceLastConsolidation = state.turn_count - (state.last_consolidation_turn || 0);
  const consolidationDue = sinceLastConsolidation >= threshold;

  if (consolidationDue) {
    state.consolidation_due = true;
    state.consolidation_due_since = new Date().toISOString();
  }

  saveCaptureState(state);

  return {
    captured: true,
    turnCount: state.turn_count,
    consolidationDue,
  };
}

/**
 * Check if consolidation is due and return hint text for injection.
 * Called by UserPromptSubmit hook.
 */
function checkConsolidationDue() {
  try {
    const state = loadCaptureState();
    if (!state.consolidation_due) return null;
    const threshold = getConsolidateEvery();
    const sinceLastConsolidation = (state.turn_count || 0) - (state.last_consolidation_turn || 0);
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
 * Mark consolidation as completed (called after /memory-seed runs).
 */
function markConsolidated() {
  const state = loadCaptureState();
  state.last_consolidation_turn = state.turn_count || 0;
  state.consolidation_due = false;
  state.last_consolidation_time = new Date().toISOString();
  saveCaptureState(state);
}

function status() {
  const state = loadCaptureState();
  const threshold = getConsolidateEvery();
  const since = (state.turn_count || 0) - (state.last_consolidation_turn || 0);
  return {
    total_turns: state.turn_count || 0,
    turns_since_consolidation: since,
    consolidation_threshold: threshold,
    consolidation_due: !!state.consolidation_due,
    last_consolidation_time: state.last_consolidation_time || null,
    active_sessions: Object.keys(state.sessions || {}).length,
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

module.exports = { autoCapture, checkConsolidationDue, markConsolidated, status, getConsolidateEvery, setConsolidateEvery, getSceneMaxTokens, setSceneMaxTokens, getPersonaMaxTokens, setPersonaMaxTokens, loadConfig };
