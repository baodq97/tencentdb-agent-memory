#!/usr/bin/env node
/**
 * SessionEnd hook — Gateway flush + local session metadata save.
 *
 * 1. POST /session/end to Gateway (existing behavior, best-effort).
 * 2. Save session metadata to state.json as "pending" for later extraction.
 */
"use strict";

const { addPluginScriptsToPath, readHookInputAsync, sessionKey, emit } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();

async function savePendingSession(payload) {
  try {
    const { updateState } = require(require("node:path").join(scriptsDir, "memory_writer.js"));
    const { projectHashForCwd } = require(require("node:path").join(scriptsDir, "memory_reader.js"));

    const sid = payload.session_id || "";
    if (!sid) return;

    const cwd = payload.cwd || "";
    const projectHash = cwd ? projectHashForCwd(cwd) : "";

    updateState(sid, projectHash, "pending");
  } catch {}
}

async function main() {
  const payload = await readHookInputAsync();

  savePendingSession(payload);

  try {
    const { GatewayClient, breakerOpen } = require(require("node:path").join(scriptsDir, "gateway_client.js"));
    if (!breakerOpen()) {
      const sk = sessionKey(payload);
      await new GatewayClient().endSession(sk);
    }
  } catch {}

  emit({});
}

main().catch(() => { emit({}); process.exit(0); });
