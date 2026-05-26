#!/usr/bin/env node
/**
 * Stop hook — POST /capture for the most recent user+assistant turn.
 *
 * Reads the transcript path from the hook payload, scans the tail of the JSONL
 * to find the latest user message and the latest assistant message, and
 * fire-and-forgets /capture. Failures are swallowed.
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

  try {
    const { GatewayClient, breakerOpen } = require(nodePath.join(scriptsDir, "gateway_client.js"));
    if (breakerOpen()) { emit({}); return; }

    const transcript = payload.transcript_path || "";
    const [userText, assistantText] = lastTurn(transcript);
    if (!userText || !assistantText) { emit({}); return; }

    const sk = sessionKey(payload);
    await new GatewayClient(undefined, 3000).capture(
      userText, assistantText, sk,
      payload.session_id || ""
    );
  } catch {}

  emit({});
}

main().catch(() => { emit({}); process.exit(0); });
