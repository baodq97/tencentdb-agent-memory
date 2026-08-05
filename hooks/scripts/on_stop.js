#!/usr/bin/env node
/**
 * Stop hook — auto-capture latest turn to local FTS5.
 *
 * After N turns, sets consolidation_due flag for the asyncRewake pipeline.
 */
"use strict";

const fs = require("node:fs");
const nodePath = require("node:path");
const { addPluginScriptsToPath, readHookInputAsync, emit } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();
const { extractText } = require(nodePath.join(scriptsDir, "memory_reader.js"));

function lastTurn(transcriptPath) {
  let userText = "";
  let assistantText = "";
  let userUuid = "";
  let assistantUuid = "";
  let gitBranch = "";
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
  return { userText, assistantText, sourceMessageIds, gitBranch };
}

async function main() {
  const payload = await readHookInputAsync();
  const transcript = payload.transcript_path || "";
  const { userText, assistantText, sourceMessageIds, gitBranch } = lastTurn(transcript);

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
