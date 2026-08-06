#!/usr/bin/env node
/**
 * Stop hook — auto-capture latest turn to local FTS5.
 *
 * After N turns, sets consolidation_due flag for the asyncRewake pipeline.
 */
"use strict";

const fs = require("node:fs");
const nodePath = require("node:path");
const { spawn } = require("node:child_process");
const { addPluginScriptsToPath, readHookInputAsync, emit } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();
const { extractText } = require(nodePath.join(scriptsDir, "memory_reader.js"));

function lastTurn(transcriptPath) {
  let userText = "";
  let assistantText = "";
  let userUuid = "";
  let assistantUuid = "";
  let gitBranch = "";
  let hadToolUse = false;
  try {
    if (!fs.existsSync(transcriptPath)) return { userText, assistantText, sourceMessageIds: [], gitBranch };
    const lines = fs.readFileSync(transcriptPath, "utf-8").split("\n").reverse();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      const msg = typeof entry.message === "object" ? entry.message : entry;
      const role = msg.role;
      if (role === "assistant" && !assistantText) {
        assistantText = extractText(msg.content || msg);
        assistantUuid = entry.uuid || "";
        if (Array.isArray(msg.content) && msg.content.some((b) => b && b.type === "tool_use")) hadToolUse = true;
        if (!gitBranch && entry.gitBranch) gitBranch = entry.gitBranch;
      } else if (role === "user" && !userText) {
        userText = extractText(msg.content || msg);
        userUuid = entry.uuid || "";
        if (!gitBranch && entry.gitBranch) gitBranch = entry.gitBranch;
      }
      if (userText && assistantText) break;
    }
  } catch {}
  // source_message_ids is the cross-layer link that was measured DEAD (always []);
  // record the real transcript uuids so consolidate can read the whole turn back.
  const sourceMessageIds = [userUuid, assistantUuid].filter(Boolean);
  return { userText, assistantText, sourceMessageIds, gitBranch, hadToolUse };
}

/**
 * GAP-1 auto-wire: fire-and-forget the deterministic session digest so the durable
 * outcome facts (files edited, tests, releases, git ops) are captured without a
 * skill run. Detached + unref so it never blocks turn-end; idempotent writes (see
 * digest_capture) make running it every tool-turn converge instead of duplicating.
 * Only spawned when the turn actually used a tool — a pure Q&A turn has no new
 * outcomes to capture. Best-effort: any failure is swallowed, memory is optional.
 */
function spawnDigest(transcript, cwd, sessionId) {
  try {
    if (!transcript || !fs.existsSync(transcript)) return;
    const cli = nodePath.join(scriptsDir, "cli.js");
    const child = spawn(process.execPath, [cli, "digest", transcript, "--apply"], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd || process.env.CLAUDE_PROJECT_DIR || "" },
      detached: true,
      stdio: "ignore",
    });
    if (child && typeof child.unref === "function") child.unref();
  } catch {}
}

async function main() {
  const payload = await readHookInputAsync();
  const transcript = payload.transcript_path || "";
  const { userText, assistantText, sourceMessageIds, gitBranch, hadToolUse } = lastTurn(transcript);

  // GAP-1: capture machine-certain outcomes from the tool blocks (idempotent).
  if (hadToolUse) spawnDigest(transcript, payload.cwd || "", payload.session_id || "");

  if (userText) {
    try {
      const { autoCapture } = require(nodePath.join(scriptsDir, "memory_auto_capture.js"));
      autoCapture({
        userText,
        assistantText: assistantText || "",
        sessionId: payload.session_id || "",
        cwd: payload.cwd || "",
        sourceMessageIds,
        gitBranch,
        transcriptPath: transcript,
      });
    } catch {}
  }

  emit({});
}

main().catch(() => { emit({}); process.exit(0); });
