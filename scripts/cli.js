#!/usr/bin/env node
/**
 * tmem — CLI for tencentdb-agent-memory plugin.
 *
 * Usage:
 *   tmem init                          Initialize memory store + vector index
 *   tmem status                        Show memory stats
 *   tmem recall <query>                Search memories (hybrid FTS5 + vector)
 *   tmem search <query>                Search L1 atoms (FTS5 only)
 *   tmem scenes [list|dedup]           List or deduplicate scene blocks
 *   tmem changelog [--last N]          Show recent memory changes
 *   tmem persona                       Show current persona
 *   tmem reindex                       Rebuild vector index from FTS5
 *   tmem unlock                        Release stale consolidation lock
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SCRIPTS_DIR = __dirname;
function req(name) { return require(path.join(SCRIPTS_DIR, name)); }

function getDirs() {
  const { globalDir, projectDir } = req("memory_writer.js");
  const { projectHashForCwd } = req("memory_reader.js");
  const cwd = process.env.CLAUDE_PROJECT_DIR || ".";
  const pHash = projectHashForCwd(cwd);
  return { gDir: globalDir(), pDir: projectDir(pHash), pHash };
}

// ── init ──
async function cmdInit() {
  const { main } = require(path.join(SCRIPTS_DIR, "memory_init.js"));
  if (typeof main === "function") return main();
  // fallback: memory_init.js runs on require if no exported main
  require(path.join(SCRIPTS_DIR, "memory_init.js"));
}

// ── status ──
function cmdStatus() {
  const { MemoryStore } = req("memory_store.js");
  const { VectorStore } = req("vector_store.js");
  const { readPersona, listScenes } = req("memory_writer.js");
  const { status: captureStatus } = req("memory_auto_capture.js");
  const { gDir, pDir, pHash } = getDirs();

  console.log("=== Memory Status ===");
  console.log("Global:", gDir);
  console.log("Project:", pDir, "(" + pHash + ")");
  console.log();

  for (const [label, dir] of [["Global", gDir], ["Project", pDir]]) {
    const dbPath = path.join(dir, "index.db");
    if (!fs.existsSync(dbPath)) { console.log(label + ": (no index.db)"); continue; }
    const store = new MemoryStore(dbPath);
    const all = store.allRecords();
    const byType = {};
    for (const r of all) byType[r.type || "unknown"] = (byType[r.type || "unknown"] || 0) + 1;
    store.close();

    const vecPath = path.join(dir, "vectors.db");
    let vecCount = 0;
    try {
      const vs = new VectorStore(vecPath);
      vecCount = vs.count();
      vs.close();
    } catch {}

    console.log(`${label}: ${all.length} records ${JSON.stringify(byType)}, ${vecCount} vectors`);
  }

  const persona = readPersona(gDir);
  console.log("\nPersona:", persona ? persona.split("\n").length + " lines" : "(none)");

  const scenes = listScenes(pDir);
  console.log("Scenes:", scenes.length, scenes.length ? scenes.map(s => s.filename).join(", ") : "");

  console.log("\nCapture:", JSON.stringify(captureStatus()));
}

// ── recall ──
async function cmdRecall(query) {
  if (!query) { console.error("Usage: tmem recall <query>"); process.exit(1); }
  const { recallAsync, recall } = req("memory_recall.js");
  const { pHash } = getDirs();
  try {
    const ctx = await recallAsync(query, pHash);
    console.log(ctx || "(no relevant memories)");
  } catch {
    console.log(recall(query, pHash) || "(no relevant memories)");
  }
}

// ── search ──
function cmdSearch(query) {
  if (!query) { console.error("Usage: tmem search <query>"); process.exit(1); }
  const { MemoryStore } = req("memory_store.js");
  const { gDir, pDir } = getDirs();
  const results = [];
  for (const dir of [gDir, pDir]) {
    const db = path.join(dir, "index.db");
    if (!fs.existsSync(db)) continue;
    const store = new MemoryStore(db);
    results.push(...store.search(query, 10));
    store.close();
  }
  if (!results.length) { console.log("No matches for:", query); return; }
  for (const r of results) {
    console.log(`[${r.type || "?"}] (p=${r.priority}) ${r.content}`);
  }
}

// ── scenes ──
function cmdScenes(sub, args) {
  const { listScenes, parseSceneMeta } = req("memory_writer.js");
  const { gDir, pDir } = getDirs();

  if (!sub || sub === "list") {
    for (const [label, dir] of [["Global", gDir], ["Project", pDir]]) {
      const scenes = listScenes(dir);
      if (!scenes.length) { console.log(label + ": (no scenes)"); continue; }
      console.log(`${label}: ${scenes.length} scenes`);
      for (const s of scenes) {
        console.log(`  ${s.filename}  heat=${s.heat || "?"}  updated=${s.updated || "?"}  ${s.summary || ""}`);
      }
    }
    return;
  }

  if (sub === "dedup") {
    const dryRun = args.includes("--dry-run");
    for (const [label, dir] of [["Global", gDir], ["Project", pDir]]) {
      const scenes = listScenes(dir);
      if (scenes.length < 2) continue;

      // Group by keyword overlap
      const groups = [];
      const assigned = new Set();
      for (let i = 0; i < scenes.length; i++) {
        if (assigned.has(i)) continue;
        const group = [scenes[i]];
        assigned.add(i);
        const wordsI = new Set((scenes[i].summary || scenes[i].filename).toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 3));
        for (let j = i + 1; j < scenes.length; j++) {
          if (assigned.has(j)) continue;
          const wordsJ = new Set((scenes[j].summary || scenes[j].filename).toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 3));
          let overlap = 0;
          for (const w of wordsI) if (wordsJ.has(w)) overlap++;
          if (overlap >= 2 || (wordsI.size <= 3 && overlap >= 1)) {
            group.push(scenes[j]);
            assigned.add(j);
          }
        }
        if (group.length > 1) groups.push(group);
      }

      if (!groups.length) { console.log(label + ": no duplicates found"); continue; }

      console.log(`${label}: ${groups.length} duplicate groups`);
      for (const group of groups) {
        group.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
        const keep = group[0];
        const remove = group.slice(1);
        console.log(`  KEEP: ${keep.filename} (updated: ${keep.updated || "?"})`);
        for (const r of remove) {
          console.log(`  ${dryRun ? "WOULD REMOVE" : "REMOVE"}: ${r.filename} (updated: ${r.updated || "?"})`);
          if (!dryRun) {
            try { fs.unlinkSync(r.filepath); } catch {}
          }
        }
      }
    }
    return;
  }

  console.error("Usage: tmem scenes [list|dedup] [--dry-run]");
}

// ── changelog ──
function cmdChangelog(args) {
  const { gDir, pDir } = getDirs();
  let last = 20;
  const lastIdx = args.indexOf("--last");
  if (lastIdx !== -1 && args[lastIdx + 1]) last = parseInt(args[lastIdx + 1]) || 20;

  const entries = [];
  for (const [label, dir] of [["global", gDir], ["project", pDir]]) {
    const logPath = path.join(dir, "changelog.jsonl");
    if (!fs.existsSync(logPath)) continue;
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try { entries.push({ ...JSON.parse(line), scope: label }); } catch {}
    }
  }

  entries.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  const show = entries.slice(0, last);

  if (!show.length) { console.log("No changelog entries."); return; }
  for (const e of show) {
    const detail = e.type === "l1" ? `[${e.memoryType}] ${e.content || ""}` : e.name || "";
    console.log(`${e.timestamp}  ${e.action.padEnd(7)}  ${e.type.padEnd(7)}  ${e.scope.padEnd(7)}  ${detail}`);
  }
}

// ── persona ──
function cmdPersona() {
  const { readPersona } = req("memory_writer.js");
  const { gDir } = getDirs();
  const p = readPersona(gDir);
  console.log(p || "(no persona yet)");
}

// ── reindex ──
async function cmdReindex() {
  const { MemoryStore } = req("memory_store.js");
  const { VectorStore } = req("vector_store.js");
  const { getEmbeddingService } = req("embedding_service.js");
  const { gDir, pDir } = getDirs();

  const svc = getEmbeddingService();
  console.log("Warming up embedding model...");
  svc.startWarmup();
  await svc.waitForReady();
  if (!svc.isReady()) { console.error("Embedding failed:", svc.initError?.message); process.exit(1); }

  let total = 0;
  for (const [label, dir] of [["Global", gDir], ["Project", pDir]]) {
    const dbPath = path.join(dir, "index.db");
    if (!fs.existsSync(dbPath)) continue;
    const ftsStore = new MemoryStore(dbPath);
    const records = ftsStore.allRecords("", 10000);
    ftsStore.close();
    if (!records.length) continue;
    const vecStore = new VectorStore(path.join(dir, "vectors.db"));
    if (vecStore.degraded) continue;
    let count = 0;
    for (const r of records) {
      const vec = await svc.embed(r.content);
      if (vec) { vecStore.upsertVec(r.record_id, vec); count++; }
    }
    vecStore.close();
    console.log(`${label}: indexed ${count}/${records.length}`);
    total += count;
  }
  svc.close();
  console.log("Done.", total, "vectors indexed.");
}

// ── sync ──
async function cmdSync() {
  const { MemoryStore } = req("memory_store.js");
  const { VectorStore } = req("vector_store.js");
  const { getEmbeddingService } = req("embedding_service.js");
  const { gDir, pDir } = getDirs();

  let totalMissing = 0;
  const missing = [];

  for (const [label, dir] of [["Global", gDir], ["Project", pDir]]) {
    const dbPath = path.join(dir, "index.db");
    if (!fs.existsSync(dbPath)) continue;
    const ftsStore = new MemoryStore(dbPath);
    const records = ftsStore.allRecords("", 10000);
    ftsStore.close();
    if (!records.length) continue;

    const vecPath = path.join(dir, "vectors.db");
    const vecStore = new VectorStore(vecPath);
    if (vecStore.degraded) { vecStore.close(); continue; }

    const vecCount = vecStore.count();
    const ftsIds = new Set(records.map(r => r.record_id));
    const needEmbed = [];
    for (const r of records) {
      const exists = vecStore.searchVec(new Float32Array(768), 1);
      // Cheaper: compare counts. If vec < fts, embed the newest records.
      needEmbed.push(r);
    }
    vecStore.close();

    const delta = records.length - vecCount;
    if (delta <= 0) {
      console.log(`${label}: in sync (${records.length} records, ${vecCount} vectors)`);
      continue;
    }

    console.log(`${label}: ${delta} records missing vectors (${vecCount}/${records.length})`);
    // Collect records sorted newest first, take delta
    const sorted = records.sort((a, b) => (b.updated_time || "").localeCompare(a.updated_time || ""));
    missing.push(...sorted.slice(0, delta).map(r => ({ label, dir, ...r })));
    totalMissing += delta;
  }

  if (!totalMissing) { console.log("All vectors in sync."); return; }

  const svc = getEmbeddingService();
  console.log(`Syncing ${totalMissing} missing vectors...`);
  svc.startWarmup();
  await svc.waitForReady();
  if (!svc.isReady()) { console.error("Embedding not available."); return; }

  let synced = 0;
  const byDir = {};
  for (const r of missing) {
    if (!byDir[r.dir]) byDir[r.dir] = [];
    byDir[r.dir].push(r);
  }

  for (const [dir, records] of Object.entries(byDir)) {
    const vecStore = new VectorStore(path.join(dir, "vectors.db"));
    if (vecStore.degraded) { vecStore.close(); continue; }
    for (const r of records) {
      const vec = await svc.embed(r.content);
      if (vec) { vecStore.upsertVec(r.record_id, vec); synced++; }
    }
    vecStore.close();
  }

  svc.close();
  console.log(`Synced ${synced}/${totalMissing} vectors.`);
}

// ── atoms ──
function cmdAtoms(args) {
  const { MemoryStore } = req("memory_store.js");
  const { gDir, pDir } = getDirs();
  const typeFilter = "";
  const limit = 500;
  const scope = args[0] || "all";

  const result = {};
  if (scope === "all" || scope === "global") {
    const db = path.join(gDir, "index.db");
    if (fs.existsSync(db)) {
      const store = new MemoryStore(db);
      result.global = store.allRecords(typeFilter, limit);
      store.close();
    } else { result.global = []; }
  }
  if (scope === "all" || scope === "project") {
    const db = path.join(pDir, "index.db");
    if (fs.existsSync(db)) {
      const store = new MemoryStore(db);
      result.project = store.allRecords(typeFilter, limit);
      store.close();
    } else { result.project = []; }
  }
  console.log(JSON.stringify(result, null, 2));
}

// ── sessions ──
function cmdSessions() {
  const { readState } = req("memory_writer.js");
  const { listSessions, projectHashForCwd } = req("memory_reader.js");
  const state = readState();
  const processed = new Set(Object.keys(state.sessions || {}));
  const pHash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || ".");
  const sessions = listSessions(pHash).filter(s => !processed.has(s.sessionId));
  console.log(JSON.stringify({ project: pHash, pending: sessions.length, sessions: sessions.slice(0, 20) }));
}

// ── read-session ──
function cmdReadSession(sessionPath) {
  if (!sessionPath) { console.error("Usage: tmem read-session <path>"); process.exit(1); }
  const { readSession, formatMessagesForExtraction } = req("memory_reader.js");
  console.log(formatMessagesForExtraction(readSession(sessionPath)));
}

// ── write-l1 ──
function cmdWriteL1(args) {
  const { writeL1Record, globalDir, projectDir, updateState } = req("memory_writer.js");
  const { projectHashForCwd } = req("memory_reader.js");

  let data = "";
  try { data = fs.readFileSync(0, "utf-8"); } catch {}
  if (!data.trim()) { console.error("Pipe JSON array to stdin. E.g.: echo '[{...}]' | tmem write-l1"); process.exit(1); }

  const records = JSON.parse(data);
  const pHash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || ".");
  const sessionId = args.find((a, i) => args[i - 1] === "--session") || "";

  let count = 0;
  for (const rec of (Array.isArray(records) ? records : [records])) {
    const base = ["persona", "instruction"].includes(rec.type) ? globalDir() : projectDir(pHash);
    writeL1Record(base, rec);
    count++;
  }
  if (sessionId) updateState(sessionId, pHash, "completed");
  console.log(`Wrote ${count} L1 atoms`);
}

// ── write-scene ──
function cmdWriteScene(args) {
  const { writeSceneBlock, projectDir } = req("memory_writer.js");
  const { projectHashForCwd } = req("memory_reader.js");
  const pHash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || ".");

  function flag(name) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : "";
  }

  const name = flag("--name");
  const summary = flag("--summary");
  const heat = parseInt(flag("--heat") || "1");

  if (!name || !summary) { console.error("Usage: tmem write-scene --name <n> --summary <s> --heat <h> < content.md"); process.exit(1); }

  let content = "";
  try { content = fs.readFileSync(0, "utf-8"); } catch {}
  if (!content.trim()) content = summary;

  const p = writeSceneBlock(projectDir(pHash), name, summary, content.trim(), heat);
  console.log("Wrote scene:", p);
}

// ── write-persona ──
function cmdWritePersona() {
  const { writePersona, globalDir } = req("memory_writer.js");
  let content = "";
  try { content = fs.readFileSync(0, "utf-8"); } catch {}
  if (!content.trim()) { console.error("Pipe persona content to stdin. E.g.: echo '# Persona...' | tmem write-persona"); process.exit(1); }
  writePersona(globalDir(), content.trim());
  console.log("Persona updated.");
}

// ── mark-done ──
function cmdMarkDone() {
  const { markConsolidated } = req("memory_auto_capture.js");
  markConsolidated();
  const lockFile = path.join(os.homedir(), ".memory-tencentdb", "consolidation.lock");
  try { fs.unlinkSync(lockFile); } catch {}
  console.log("Consolidation marked complete, lock released.");
}

// ── unlock ──
function cmdUnlock() {
  const lockFile = path.join(os.homedir(), ".memory-tencentdb", "consolidation.lock");
  try { fs.unlinkSync(lockFile); console.log("Lock released."); } catch { console.log("No lock file."); }
}

// ── main ──
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);
  const restStr = rest.join(" ").trim();

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`tmem — tencentdb-agent-memory CLI

Usage: tmem <command> [options]

Commands:
  init                       Initialize memory store + vector index
  status                     Show memory stats
  recall <query>             Hybrid recall (FTS5 + vector + RRF)
  search <query>             Search L1 atoms (FTS5 only)
  atoms [global|project|all] Dump L1 atoms as JSON
  sessions                   List pending sessions for seeding
  read-session <path>        Format session for extraction
  write-l1 [--session id]    Write L1 atoms from stdin JSON
  write-scene --name --summary --heat  Write scene block (content from stdin)
  write-persona              Write persona from stdin
  scenes [list|dedup]        List or deduplicate scene blocks
    --dry-run                Preview dedup without removing
  changelog [--last N]       Show recent memory changes
  persona                    Show current persona
  sync                       Embed records missing from vector index (delta only)
  reindex                    Rebuild entire vector index from FTS5
  mark-done                  Mark consolidation complete + release lock
  unlock                     Release stale consolidation lock`);
    return;
  }

  switch (cmd) {
    case "init": return cmdInit();
    case "status": return cmdStatus();
    case "recall": return cmdRecall(restStr);
    case "search": return cmdSearch(restStr);
    case "atoms": return cmdAtoms(rest);
    case "sessions": return cmdSessions();
    case "read-session": return cmdReadSession(restStr);
    case "write-l1": return cmdWriteL1(rest);
    case "write-scene": return cmdWriteScene(rest);
    case "write-persona": return cmdWritePersona();
    case "scenes": return cmdScenes(rest[0], rest);
    case "changelog": return cmdChangelog(rest);
    case "persona": return cmdPersona();
    case "sync": return cmdSync();
    case "reindex": return cmdReindex();
    case "mark-done": return cmdMarkDone();
    case "unlock": return cmdUnlock();
    default:
      console.error(`Unknown command: ${cmd}. Run 'tmem --help' for usage.`);
      process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
