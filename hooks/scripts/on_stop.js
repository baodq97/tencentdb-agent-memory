#!/usr/bin/env node
/**
 * Stop hook — POST /capture to Gateway + auto-capture to local FTS5.
 *
 * 1. Read latest user+assistant turn from transcript.
 * 2. Fire-and-forget /capture to Gateway (existing behavior).
 * 3. Auto-capture to local FTS5 for immediate recall (new).
 *    After N turns, sets consolidation_due flag in capture_state.json.
 */
"use strict";

const fs = require("node:fs");
const nodePath = require("node:path");
const { addPluginScriptsToPath, readHookInputAsync, sessionKey, emit } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();

function extractText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

function lastTurn(transcriptPath) {
  let userText = "";
  let assistantText = "";
  try {
    if (!fs.existsSync(transcriptPath)) return ["", ""];
    const lines = fs.readFileSync(transcriptPath, "utf-8").split("\n").reverse();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      const msg = typeof entry.message === "object" ? entry.message : entry;
      const role = msg.role;
      if (role === "assistant" && !assistantText) {
        assistantText = extractText(msg);
      } else if (role === "user" && !userText) {
        userText = extractText(msg);
      }
      if (userText && assistantText) break;
    }
  } catch {}
  return [userText, assistantText];
}

async function main() {
  const payload = await readHookInputAsync();
  const transcript = payload.transcript_path || "";
  const [userText, assistantText] = lastTurn(transcript);

  // 1. Gateway capture (best-effort)
  if (userText && assistantText) {
    try {
      const { GatewayClient, breakerOpen } = require(nodePath.join(scriptsDir, "gateway_client.js"));
      if (!breakerOpen()) {
        const sk = sessionKey(payload);
        await new GatewayClient(undefined, 3000).capture(
          userText, assistantText, sk,
          payload.session_id || ""
        );
      }
    } catch {}
  }

  // 2. Local auto-capture to FTS5
  if (userText) {
    try {
      const { autoCapture } = require(nodePath.join(scriptsDir, "memory_auto_capture.js"));
      autoCapture({
        userText,
        assistantText: assistantText || "",
        sessionId: payload.session_id || "",
        cwd: payload.cwd || "",
      });
    } catch {}
  }

  emit({});
}

main().catch(() => { emit({}); process.exit(0); });
