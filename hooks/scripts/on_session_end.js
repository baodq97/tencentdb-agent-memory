#!/usr/bin/env node
/**
 * SessionEnd hook — save session metadata as "pending" for later extraction.
 * Must be fast — session is ending, process may be killed at any time.
 */
"use strict";

const nodePath = require("node:path");
const { addPluginScriptsToPath } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();

let data = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", chunk => { data += chunk; });
process.stdin.on("end", run);
process.stdin.on("error", run);
setTimeout(run, 1500);

let ran = false;
function run() {
  if (ran) return;
  ran = true;

  try {
    const payload = data.trim() ? JSON.parse(data) : {};
    const sid = payload.session_id || "";
    if (sid) {
      const { updateState } = require(nodePath.join(scriptsDir, "memory_writer.js"));
      const { projectHashForCwd } = require(nodePath.join(scriptsDir, "memory_reader.js"));
      const cwd = payload.cwd || "";
      const projectHash = cwd ? projectHashForCwd(cwd) : "";
      updateState(sid, projectHash, "pending");
    }
  } catch {}

  process.stdout.write("{}");
}
