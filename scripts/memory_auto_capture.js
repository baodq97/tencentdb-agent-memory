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

const DEFAULT_CONSOLIDATE_EVERY = 10;
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
  if (!text || text.length < 30) return false;
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

  const threshold = parseInt(process.env.MEMORY_CONSOLIDATE_EVERY || String(DEFAULT_CONSOLIDATE_EVERY), 10);
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
    const threshold = parseInt(process.env.MEMORY_CONSOLIDATE_EVERY || String(DEFAULT_CONSOLIDATE_EVERY), 10);
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
  const threshold = parseInt(process.env.MEMORY_CONSOLIDATE_EVERY || String(DEFAULT_CONSOLIDATE_EVERY), 10);
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

module.exports = { autoCapture, checkConsolidationDue, markConsolidated, status };
