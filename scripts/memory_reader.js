#!/usr/bin/env node
/**
 * Read native Claude Code JSONL conversation logs as L0 data.
 *
 * Usage:
 *   node scripts/memory_reader.js --help
 *   node scripts/memory_reader.js list-projects
 *   node scripts/memory_reader.js list-sessions --project D--2026-myrepo
 *   node scripts/memory_reader.js read --file path/to/session.jsonl
 *   node scripts/memory_reader.js read --file path/to/session.jsonl --after 2025-05-25T00:00:00Z
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function claudeProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

function projectHashForCwd(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  return resolved.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
}

function listProjects() {
  const d = claudeProjectsDir();
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function listSessions(projectHash) {
  const d = path.join(claudeProjectsDir(), projectHash);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => ({
      sessionId: f.replace(".jsonl", ""),
      filePath: path.join(d, f),
      projectHash,
    }));
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

function readSession(filePath, afterTimestamp = "", roles = ["user", "assistant"]) {
  if (!fs.existsSync(filePath)) return [];
  const messages = [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }

    const entryType = entry.type || "";
    if (!roles.includes(entryType)) continue;

    const msg = entry.message;
    if (!msg || typeof msg !== "object") continue;
    if (!roles.includes(msg.role)) continue;

    const text = extractText(msg.content);
    if (!text.trim()) continue;

    const ts = entry.timestamp || "";
    if (afterTimestamp && ts && ts <= afterTimestamp) continue;

    messages.push({
      id: entry.uuid || "",
      role: msg.role,
      content: text,
      timestamp: ts,
      sessionId: entry.sessionId || "",
      parentId: entry.parentUuid || "",
    });
  }

  messages.sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));
  return messages;
}

function readSessionPairs(filePath, afterTimestamp = "") {
  const msgs = readSession(filePath, afterTimestamp);
  const pairs = [];
  let i = 0;
  while (i < msgs.length - 1) {
    if (msgs[i].role === "user" && msgs[i + 1].role === "assistant") {
      pairs.push([msgs[i], msgs[i + 1]]);
      i += 2;
    } else {
      i++;
    }
  }
  return pairs;
}

function formatMessagesForExtraction(messages) {
  return messages
    .map((m) => `[${m.id}] [${m.role}] [${m.timestamp}]: ${m.content}`)
    .join("\n\n");
}

// ── CLI ──
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`Usage: node memory_reader.js <command> [options]

Commands:
  list-projects                             List all project hashes
  list-sessions  --project <hash>           List sessions for a project
  read           --file <path>              Read messages from a session
                 [--project <hash> --session <id>]
                 [--after <ISO timestamp>]
                 [--format json|text]`);
    return;
  }

  function flag(name) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : "";
  }

  if (cmd === "list-projects") {
    for (const p of listProjects()) console.log(p);
  } else if (cmd === "list-sessions") {
    for (const s of listSessions(flag("--project"))) {
      console.log(`${s.sessionId}  ${s.filePath}`);
    }
  } else if (cmd === "read") {
    let filePath = flag("--file");
    if (!filePath) {
      const proj = flag("--project");
      const sess = flag("--session");
      if (proj && sess) {
        filePath = path.join(claudeProjectsDir(), proj, `${sess}.jsonl`);
      } else {
        console.error("Error: provide --file or both --project and --session");
        process.exit(1);
      }
    }
    const messages = readSession(filePath, flag("--after"));
    const fmt = flag("--format") || "json";
    if (fmt === "text") {
      console.log(formatMessagesForExtraction(messages));
    } else {
      console.log(JSON.stringify(messages, null, 2));
    }
  }
}

if (require.main === module) main();

module.exports = {
  claudeProjectsDir,
  projectHashForCwd,
  listProjects,
  listSessions,
  readSession,
  readSessionPairs,
  formatMessagesForExtraction,
  extractText,
};
