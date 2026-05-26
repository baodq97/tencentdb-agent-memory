#!/usr/bin/env node
/**
 * FTS5 search and <memory-context> formatting for recall injection.
 *
 * Budget: < 300 tokens (~1200 chars). Latency: < 5s total.
 *
 * Usage:
 *   node scripts/memory_recall.js --help
 *   node scripts/memory_recall.js recall --query "dark mode" --project-hash D--2026-myrepo
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MemoryStore } = require("./memory_store.js");
const { globalDir, projectDir, readPersona } = require("./memory_writer.js");

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 280;

function recall(query, projectHash = "", maxTokens = DEFAULT_MAX_TOKENS, topK = 5) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts = [];
  let used = 0;

  const persona = getPersona();
  if (persona) {
    const summary = truncate(persona, 400);
    parts.push(`<persona>\n${summary}\n</persona>`);
    used += summary.length + 24;
  }

  let memories = [];
  const gDir = globalDir();
  const gDb = path.join(gDir, "index.db");
  if (fs.existsSync(gDb)) {
    const store = new MemoryStore(gDb);
    memories.push(...store.search(query, topK));
    store.close();
  }

  if (projectHash) {
    const pDir = projectDir(projectHash);
    const pDb = path.join(pDir, "index.db");
    if (fs.existsSync(pDb)) {
      const store = new MemoryStore(pDb);
      memories.push(...store.search(query, topK));
      store.close();
    }
  }

  memories = dedupeAndRank(memories, topK);

  if (memories.length) {
    const memLines = [];
    for (const m of memories) {
      const line = `- [${m.type || "?"}] ${m.content}`;
      if (used + line.length + 2 > maxChars) break;
      memLines.push(line);
      used += line.length + 1;
    }
    if (memLines.length) {
      parts.push("<memories>\n" + memLines.join("\n") + "\n</memories>");
    }
  }

  if (!parts.length) return "";
  return "<memory-context>\n" + parts.join("\n") + "\n</memory-context>";
}

function getPersona() {
  const persona = readPersona(globalDir());
  if (!persona) return "";
  const lines = persona.trim().split("\n");
  const summary = [];
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) summary.push(trimmed.slice(2));
    else if (trimmed) summary.push(trimmed);
    if (summary.length >= 5) break;
  }
  return summary.join("; ");
}

function dedupeAndRank(memories, limit) {
  const seen = new Set();
  const unique = [];
  for (const m of memories) {
    const rid = m.record_id || m.id || "";
    if (seen.has(rid)) continue;
    seen.add(rid);
    unique.push(m);
  }
  unique.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return unique.slice(0, limit);
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const last = cut.lastIndexOf(" ");
  return (last > 0 ? cut.slice(0, last) : cut) + "...";
}

// ── CLI ──
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`Usage: node memory_recall.js <command> [options]

Commands:
  recall  --query <q> [--project-hash <h>] [--max-tokens <n>] [--top-k <n>] [--format text|json]`);
    return;
  }

  function flag(name) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : "";
  }

  if (cmd === "recall") {
    const result = recall(
      flag("--query"),
      flag("--project-hash"),
      parseInt(flag("--max-tokens") || String(DEFAULT_MAX_TOKENS)),
      parseInt(flag("--top-k") || "5")
    );
    const fmt = flag("--format") || "text";
    if (fmt === "json") {
      console.log(JSON.stringify({ context: result, chars: result.length }));
    } else {
      console.log(result || "(no relevant memories found)");
    }
  }
}

if (require.main === module) main();

module.exports = { recall };
