#!/usr/bin/env node
/**
 * Write L1/L2/L3 memory data to the storage layout.
 *
 * Usage:
 *   node scripts/memory_writer.js --help
 *   node scripts/memory_writer.js write-l1 --base-dir ~/.memory-tencentdb/global --json '[...]'
 *   node scripts/memory_writer.js write-scene --base-dir ... --name "scene" --summary "..." --content "..."
 *   node scripts/memory_writer.js write-persona --base-dir ~/.memory-tencentdb/global --content "..."
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

function memoryBaseDir() {
  return path.join(os.homedir(), ".memory-tencentdb");
}

function globalDir() {
  return path.join(memoryBaseDir(), "global");
}

function projectDir(projectHash) {
  return path.join(memoryBaseDir(), "projects", projectHash);
}

// Every project store slug under the memory base (for cross-project CLI tools).
function listProjectHashes() {
  const d = path.join(memoryBaseDir(), "projects");
  try {
    return fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

function generateMemoryId() {
  return `m_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function shardDate() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function writeL1Record(baseDir, record, index = true) {
  const recordsDir = path.join(baseDir, "records");
  fs.mkdirSync(recordsDir, { recursive: true });

  const now = nowIso();
  if (!record.id) record.id = generateMemoryId();
  record.createdAt = record.createdAt || now;
  record.updatedAt = record.updatedAt || now;
  record.timestamps = record.timestamps || [now];
  record.priority = record.priority ?? 50;
  record.scene_name = record.scene_name || "";
  record.source_message_ids = record.source_message_ids || [];
  record.metadata = record.metadata || {};
  record.sessionKey = record.sessionKey || "";
  record.sessionId = record.sessionId || "";

  const jsonlPath = path.join(recordsDir, `${shardDate()}.jsonl`);
  fs.appendFileSync(jsonlPath, JSON.stringify(record) + "\n", "utf-8");

  if (index) {
    indexRecord(baseDir, record);
  }
  appendChangelog(baseDir, { action: "created", type: "l1", id: record.id, memoryType: record.type, content: record.content.slice(0, 100), timestamp: now });
  return record;
}

function writeL1Batch(baseDir, records, index = true) {
  return records.map((r) => writeL1Record(baseDir, r, index));
}

function indexRecord(baseDir, record) {
  const { MemoryStore } = require("./memory_store.js");
  const dbPath = path.join(baseDir, "index.db");
  const store = new MemoryStore(dbPath);
  store.upsert(record);
  store.close();
}

function appendChangelog(baseDir, entry) {
  try {
    const logPath = path.join(baseDir, "changelog.jsonl");
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch {}
}

const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

function parseSceneMeta(filepath) {
  try {
    const text = fs.readFileSync(filepath, "utf-8");
    const start = text.indexOf(META_START);
    const end = text.indexOf(META_END);
    if (start === -1 || end === -1) return null;
    const block = text.slice(start + META_START.length, end).trim();
    const meta = {};
    for (const line of block.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return meta;
  } catch { return null; }
}

function listScenes(baseDir) {
  const sceneDir = path.join(baseDir, "scene_blocks");
  if (!fs.existsSync(sceneDir)) return [];
  return fs.readdirSync(sceneDir)
    .filter(f => f.endsWith(".md"))
    .map(f => {
      const filepath = path.join(sceneDir, f);
      const meta = parseSceneMeta(filepath) || {};
      return { filename: f, filepath, ...meta };
    });
}

function writeSceneBlock(baseDir, sceneName, summary, content, heat = 1, created = "", updated = "") {
  const sceneDir = path.join(baseDir, "scene_blocks");
  fs.mkdirSync(sceneDir, { recursive: true });

  const now = nowIso();
  const filename = slugify(sceneName) + ".md";
  const filepath = path.join(sceneDir, filename);

  const existing = parseSceneMeta(filepath);
  created = created || (existing ? existing.created : "") || now;
  updated = updated || now;

  const meta = [
    META_START,
    `created: ${created}`,
    `updated: ${updated}`,
    `summary: ${summary}`,
    `heat: ${heat}`,
    META_END,
  ].join("\n");

  const action = existing ? "updated" : "created";
  fs.writeFileSync(filepath, `${meta}\n\n${content}`, "utf-8");
  appendChangelog(baseDir, { action, type: "scene", name: sceneName, file: filename, timestamp: now });
  return filepath;
}

function writePersona(baseDir, content) {
  fs.mkdirSync(baseDir, { recursive: true });
  const p = path.join(baseDir, "persona.md");
  const existed = fs.existsSync(p);
  fs.writeFileSync(p, content, "utf-8");
  appendChangelog(baseDir, { action: existed ? "updated" : "created", type: "persona", timestamp: nowIso() });
  return p;
}

function readPersona(baseDir) {
  const p = path.join(baseDir, "persona.md");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  return "";
}

function updateState(sessionId, projectHash = "", status = "completed", lastTimestamp = "") {
  const statePath = path.join(memoryBaseDir(), "state.json");
  let state = {};
  if (fs.existsSync(statePath)) {
    try { state = JSON.parse(fs.readFileSync(statePath, "utf-8")); } catch {}
  }

  const now = nowIso();
  if (!state.sessions) state.sessions = {};
  state.sessions[sessionId] = {
    status,
    project_hash: projectHash,
    last_timestamp: lastTimestamp || now,
    processed_at: now,
  };

  if (projectHash) {
    if (!state.projects) state.projects = {};
    if (!state.projects[projectHash]) state.projects[projectHash] = {};
    if (lastTimestamp) {
      state.projects[projectHash].last_consolidated = lastTimestamp;
    }
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = statePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, statePath);
}

function readState() {
  const statePath = path.join(memoryBaseDir(), "state.json");
  if (fs.existsSync(statePath)) {
    try { return JSON.parse(fs.readFileSync(statePath, "utf-8")); } catch {}
  }
  return {};
}

function slugify(name) {
  let s = name.toLowerCase().trim();
  s = s.replace(/[^\w\s-]/g, "");
  s = s.replace(/[\s_]+/g, "-");
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (s || "unnamed").slice(0, 80);
}

// ── CLI ──
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`Usage: node memory_writer.js <command> [options]

Commands:
  write-l1      --base-dir <dir> --json <json>     Write L1 record(s)
  write-scene   --base-dir <dir> --name <n> --summary <s> --content <c> [--heat <h>]
  write-persona --base-dir <dir> --content <c>     Write L3 persona
  update-state  --session-id <id> [--project-hash <h>] [--status <s>]`);
    return;
  }

  function flag(name) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : "";
  }

  if (cmd === "write-l1") {
    const data = JSON.parse(flag("--json"));
    if (Array.isArray(data)) {
      const records = writeL1Batch(flag("--base-dir"), data);
      console.log(`Wrote ${records.length} L1 records`);
    } else {
      const record = writeL1Record(flag("--base-dir"), data);
      console.log(`Wrote L1: ${record.id}`);
    }
  } else if (cmd === "write-scene") {
    const p = writeSceneBlock(
      flag("--base-dir"), flag("--name"), flag("--summary"),
      flag("--content"), parseInt(flag("--heat") || "1")
    );
    console.log(`Wrote scene: ${p}`);
  } else if (cmd === "write-persona") {
    const p = writePersona(flag("--base-dir"), flag("--content"));
    console.log(`Wrote persona: ${p}`);
  } else if (cmd === "update-state") {
    updateState(flag("--session-id"), flag("--project-hash"), flag("--status") || "completed");
    console.log("State updated");
  }
}

if (require.main === module) main();

module.exports = {
  memoryBaseDir, globalDir, projectDir, listProjectHashes,
  generateMemoryId, writeL1Record, writeL1Batch,
  writeSceneBlock, writePersona, readPersona,
  updateState, readState, listScenes, parseSceneMeta,
  appendChangelog, META_START, META_END,
};
