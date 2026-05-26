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
  init                     Initialize memory store + vector index
  status                   Show memory stats (records, vectors, persona, scenes)
  recall <query>           Hybrid recall (FTS5 + vector + RRF)
  search <query>           Search L1 atoms (FTS5 only)
  scenes [list|dedup]      List or deduplicate scene blocks
    --dry-run              Show what would be removed without removing
  changelog [--last N]     Show recent memory changes (default: 20)
  persona                  Show current persona
  reindex                  Rebuild vector index from FTS5
  unlock                   Release stale consolidation lock`);
    return;
  }

  switch (cmd) {
    case "init": return cmdInit();
    case "status": return cmdStatus();
    case "recall": return cmdRecall(restStr);
    case "search": return cmdSearch(restStr);
    case "scenes": return cmdScenes(rest[0], rest);
    case "changelog": return cmdChangelog(rest);
    case "persona": return cmdPersona();
    case "reindex": return cmdReindex();
    case "unlock": return cmdUnlock();
    default:
      console.error(`Unknown command: ${cmd}. Run 'tmem --help' for usage.`);
      process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
