#!/usr/bin/env node
/**
 * tmem — CLI for tencentdb-agent-memory plugin.
 * Run `tmem --help` for the full command list (the authoritative source).
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

// ── scene (read one full scene block by name, project-first then global) ──
function cmdScene(name) {
  if (!name) { console.error("Usage: tmem scene <name>  (names from `tmem scenes list` / scene-navigation)"); process.exit(1); }
  const { gDir, pDir } = getDirs();
  const file = name.endsWith(".md") ? name : name + ".md";
  for (const dir of [pDir, gDir]) {
    const p = path.join(dir, "scene_blocks", file);
    if (fs.existsSync(p)) { console.log(fs.readFileSync(p, "utf-8")); return; }
  }
  console.error(`Scene not found: ${name}`);
  process.exit(1);
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

// ── sync ──
// Embed records into the vector index. Default: delta only (newest records missing
// vectors). With --full: re-embed every record (former `reindex`).
async function cmdSync(args) {
  const full = (args || []).includes("--full");
  const { MemoryStore } = req("memory_store.js");
  const { VectorStore } = req("vector_store.js");
  const { getEmbeddingService } = req("embedding_service.js");
  const { gDir, pDir } = getDirs();

  // Decide which records to embed, per dir.
  const todo = []; // [{ dir, ...record }]
  for (const [label, dir] of [["Global", gDir], ["Project", pDir]]) {
    const dbPath = path.join(dir, "index.db");
    if (!fs.existsSync(dbPath)) continue;
    const ftsStore = new MemoryStore(dbPath);
    const records = ftsStore.allRecords("", 10000);
    ftsStore.close();
    if (!records.length) continue;

    const vecStore = new VectorStore(path.join(dir, "vectors.db"));
    if (vecStore.degraded) { vecStore.close(); continue; }
    const vecCount = vecStore.count();
    vecStore.close();

    if (full) {
      todo.push(...records.map(r => ({ dir, ...r })));
      continue;
    }
    const delta = records.length - vecCount;
    if (delta <= 0) {
      console.log(`${label}: in sync (${records.length} records, ${vecCount} vectors)`);
      continue;
    }
    console.log(`${label}: ${delta} records missing vectors (${vecCount}/${records.length})`);
    const sorted = records.sort((a, b) => (b.updated_time || "").localeCompare(a.updated_time || ""));
    todo.push(...sorted.slice(0, delta).map(r => ({ dir, ...r })));
  }

  if (!todo.length) { console.log(full ? "No records to embed." : "All vectors in sync."); return; }

  const svc = getEmbeddingService();
  console.log(`${full ? "Reindexing" : "Syncing"} ${todo.length} vectors...`);
  svc.startWarmup();
  await svc.waitForReady();
  if (!svc.isReady()) { console.error("Embedding not available."); return; }

  const byDir = {};
  for (const r of todo) {
    if (!byDir[r.dir]) byDir[r.dir] = [];
    byDir[r.dir].push(r);
  }

  let done = 0;
  for (const [dir, records] of Object.entries(byDir)) {
    const vecStore = new VectorStore(path.join(dir, "vectors.db"));
    if (vecStore.degraded) { vecStore.close(); continue; }
    for (const r of records) {
      const vec = await svc.embed(r.content);
      if (vec) { vecStore.upsertVec(r.record_id, vec); done++; }
    }
    vecStore.close();
  }

  svc.close();
  console.log(`Embedded ${done}/${todo.length} vectors.`);
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

// ── config ──
function cmdConfig(args) {
  const { getConsolidateEvery, setConsolidateEvery, getSceneMaxTokens, setSceneMaxTokens, loadConfig } = req("memory_auto_capture.js");
  const key = args[0];

  if (!key) {
    console.log(JSON.stringify({
      consolidate_every: getConsolidateEvery(),
      scene_max_tokens: getSceneMaxTokens(),
      stored: loadConfig(),
      env_override: {
        MEMORY_CONSOLIDATE_EVERY: process.env.MEMORY_CONSOLIDATE_EVERY || null,
        MEMORY_SCENE_MAX_TOKENS: process.env.MEMORY_SCENE_MAX_TOKENS || null,
      },
    }, null, 2));
    return;
  }

  if (key === "consolidate-every") {
    if (args[1] === undefined) { console.log(getConsolidateEvery()); return; }
    try {
      const v = setConsolidateEvery(args[1]);
      console.log(`consolidate-every set to ${v}`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  if (key === "scene-max-tokens") {
    if (args[1] === undefined) { console.log(getSceneMaxTokens()); return; }
    try {
      const v = setSceneMaxTokens(args[1]);
      console.log(`scene-max-tokens set to ${v}`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown config key: ${key}. Supported: consolidate-every, scene-max-tokens`);
  process.exit(1);
}

// ── daemon ──
async function cmdDaemon(sub) {
  const ec = req("embed_client.js");
  const { pidFileForDir, addrForDir, startDaemon } = req("embed_daemon.js");
  const pidfile = pidFileForDir(SCRIPTS_DIR);
  const addr = addrForDir(SCRIPTS_DIR);
  const readPid = () => {
    try { const n = parseInt(fs.readFileSync(pidfile, "utf-8").trim(), 10); return Number.isInteger(n) ? n : null; }
    catch { return null; }
  };
  const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (sub === "status") {
    const pid = readPid();
    const h = await ec.pingDaemon({ timeoutMs: 2500 });
    const detail = {
      ready: `ready — serving ${h.vlen}-d vectors`,
      warming: "warming — model loading; recall on FTS until ready",
      failed: "failed — model load failed; recall stays on FTS",
      stuck: "UNRESPONSIVE — connected but no reply; run `tmem daemon stop` then `start`",
      down: "down — not running; recall on FTS (run `tmem daemon start`)",
      badreply: "protocol mismatch — unexpected reply",
    }[h.state] || h.state;
    console.log(`tmem daemon: ${detail}`);
    console.log(`  addr: ${addr}`);
    console.log(`  ${pid ? `pid ${pid}${alive(pid) ? "" : " (stale pidfile — process not running)"}` : "no pidfile"}`);
    process.exit(h.state === "ready" ? 0 : 1);
  }

  if (sub === "stop") {
    const pid = readPid();
    if (pid && alive(pid)) {
      try { process.kill(pid); console.log(`tmem daemon: stopped pid ${pid}`); }
      catch (e) { console.error(`tmem daemon: could not kill pid ${pid}: ${e.message}`); }
    } else {
      console.log("tmem daemon: not running (no live pid)");
    }
    try { fs.unlinkSync(pidfile); } catch {}
    if (process.platform !== "win32") { try { fs.unlinkSync(addr); } catch {} }
    return;
  }

  if (sub === "start" || sub === undefined) {
    const h = await ec.pingDaemon({ timeoutMs: 2500 });
    if (h.state === "ready" || h.state === "warming") {
      const pid = readPid();
      console.log(`tmem daemon: already running (${h.state}${pid ? `, pid ${pid}` : ""}). Nothing to do.`);
      return;
    }
    // down/stuck/failed: clear any incumbent holding the address, then serve foreground
    const pid = readPid();
    if (pid && alive(pid)) {
      console.log(`tmem daemon: clearing unresponsive incumbent pid ${pid} (state=${h.state})`);
      try { process.kill(pid); } catch {}
      try { fs.unlinkSync(pidfile); } catch {}
      await sleep(600); // let the OS release the pipe/socket before rebinding
    }
    console.log("tmem daemon: starting (foreground). Warming EmbeddingGemma; serves until idle (15m) or Ctrl-C.");
    console.log(`  addr: ${addr}`);
    startDaemon(); // listening server keeps the process alive (long-lived parent = no reap)
    return new Promise(() => {}); // never resolves — block here while serving
  }

  console.error("Usage: tmem daemon <start|status|stop>");
  process.exit(1);
}

// ── contrib ──
async function cmdContrib(rest) {
  const sub = rest[0];
  const args = rest.slice(1);
  const { gDir } = getDirs();
  const contribRoot = path.join(gDir, "contributors");
  const dbPath = path.join(contribRoot, "index.db");
  const { ContribStore } = req("contrib_store.js");
  const { loadConfig, addSubject } = req("contrib_config.js");

  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  switch (sub) {
    case "add": {
      const [user, repo] = args;
      const s = addSubject(gDir, { github_user: user, repo });
      console.log(`Added subject ${s.id} (${s.repo})`);
      return;
    }
    case "list-subjects": {
      const cfg = loadConfig(gDir);
      const store = new ContribStore(dbPath);
      for (const s of cfg.subjects) {
        console.log(`${s.id}\t${s.repo}\tatoms=${store.countAtoms(s.id)}`);
      }
      if (!cfg.subjects.length) console.log("(no subjects — use: tmem contrib add <user> <owner/repo>)");
      return;
    }
    case "raw": {
      const id = args[0];
      const cfg = loadConfig(gDir);
      const subject = cfg.subjects.find((s) => s.id === id);
      if (!subject) { console.error(`unknown subject: ${id}`); process.exitCode = 1; return; }
      const { fetchRaw } = req("contrib_ingest.js");
      // preflight: gh must be installed + authenticated
      const { spawnSync } = require("node:child_process");
      const ghCheck = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
      if (ghCheck.error || ghCheck.status !== 0) {
        console.error("gh CLI not available or not authenticated. Run: gh auth login");
        process.exitCode = 1;
        return;
      }
      const store = new ContribStore(dbPath);
      const incremental = args.includes("--full") ? null : store.getCursor(id);
      const raw = await fetchRaw(subject, {
        maxRetries: cfg.ingest.max_retries,
        maxWaitSec: cfg.ingest.max_wait_per_retry_sec,
        since: incremental,
      });
      const outDir = path.join(contribRoot, "raw", id);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "raw.json"), JSON.stringify(raw, null, 2));
      store.setCursor(id, new Date().toISOString());
      if (incremental) console.error(`[contrib] incremental since ${incremental} (use --full to refetch all)`);
      console.log(JSON.stringify(raw, null, 2));
      return;
    }
    case "upsert-atom": {
      const store = new ContribStore(dbPath);
      const atom = JSON.parse(flag("--json"));
      store.upsertAtom(atom);
      console.log(`ok ${atom.record_id}`);
      return;
    }
    case "atoms": {
      const store = new ContribStore(dbPath);
      console.log(JSON.stringify(store.getAtoms(args[0], args[1]), null, 2));
      return;
    }
    case "upsert-persona": {
      const store = new ContribStore(dbPath);
      const p = JSON.parse(flag("--json"));
      store.upsertPersona(p);
      console.log(`ok persona ${p.subject_id}`);
      return;
    }
    case "persona": {
      const store = new ContribStore(dbPath);
      const p = store.getPersona(args[0]);
      console.log(p ? JSON.stringify(p, null, 2) : `(no persona for ${args[0]})`);
      return;
    }
    case "personas": {
      const store = new ContribStore(dbPath);
      const all = store.listPersonas();
      console.log(JSON.stringify(all, null, 2));
      if (!all.length) console.error("(no personas yet — run build first)");
      return;
    }
    case "capabilities": {
      const store = new ContribStore(dbPath);
      const cfg = loadConfig(gDir);
      try {
        const caps = store.computeL4(cfg.l4.prevalence_threshold);
        for (const c of caps) {
          console.log(`${c.capability}\t${(c.prevalence * 100).toFixed(0)}%\t${c.summary}\texemplar=${c.exemplar}`);
        }
        if (!caps.length) console.log("(no common capabilities above threshold yet)");
      } catch (e) {
        if (/need >=2/.test(e.message)) { console.log("need >=2 subjects with personas to synthesise L4"); return; }
        throw e;
      }
      return;
    }
    case "sync": {
      const store = new ContribStore(dbPath);
      const { VectorStore } = req("vector_store.js");
      const { embedViaDaemon } = req("embed_client.js");
      const vec = new VectorStore(path.join(contribRoot, "vectors.db"));
      const id = args[0];
      const cfg2 = loadConfig(gDir);
      const subjects = id ? [id] : cfg2.subjects.map((s) => s.id);
      let n = 0;
      for (const sid of subjects) {
        for (const a of store.getAtoms(sid)) {
          try {
            const emb = await embedViaDaemon(a.content);
            if (emb && emb.length) { vec.upsertVec(a.record_id, emb); n += 1; }
          } catch { /* daemon down — skip, FTS still works */ }
        }
      }
      console.log(`embedded ${n} atom(s) into ${path.join(contribRoot, "vectors.db")}`);
      return;
    }
    case "search": {
      const store = new ContribStore(dbPath);
      const query = args.filter((a) => !a.startsWith("--")).join(" ");
      const subjectId = flag("--subject");
      const ftsHits = store.searchAtoms(query, { subjectId, limit: 10 });
      let merged = ftsHits.map((r) => r.record_id);
      try {
        const { VectorStore, rrfMerge } = req("vector_store.js");
        const { embedViaDaemon } = req("embed_client.js");
        const emb = await embedViaDaemon(query);
        if (emb && emb.length) {
          const vec = new VectorStore(path.join(contribRoot, "vectors.db"));
          const vHits = vec.searchVec(emb, 10).map((r) => r.record_id || r.recordId);
          merged = rrfMerge([merged, vHits]).map((r) => r.id || r);
        }
      } catch { /* vector unavailable — FTS-only */ }
      const seen = new Set();
      let shown = 0;
      for (const rid of merged) {
        if (seen.has(rid)) continue; seen.add(rid);
        const rec = store.getAtomById(rid);
        if (rec) { console.log(`[${rec.dimension}] ${rec.subject_id}: ${rec.content}`); shown += 1; }
      }
      if (!shown) console.log("(no matches)");
      return;
    }
    case "team": {
      const { addTeamMembers, getTeam } = req("contrib_config.js");
      const action = args[0];
      if (action === "add") {
        const teamId = args[1];
        const members = args.slice(2);
        const t = addTeamMembers(gDir, teamId, members);
        console.log(`team ${t.id}: ${t.members.join(", ")}`);
        return;
      }
      if (action === "capabilities") {
        const teamId = args[1];
        const team = getTeam(gDir, teamId);
        if (!team) { console.error(`unknown team: ${teamId}`); process.exitCode = 1; return; }
        const store = new ContribStore(dbPath);
        const cfg = loadConfig(gDir);
        try {
          const caps = store.computeL4(cfg.l4.prevalence_threshold, { subjectIds: team.members, persist: false });
          const tag = team.members.length < 3 ? " (preliminary, <3 members)" : "";
          console.log(`# team ${teamId} capabilities${tag}`);
          for (const c of caps) {
            console.log(`${c.capability}\t${(c.prevalence * 100).toFixed(0)}%\t${c.summary}\texemplar=${c.exemplar}`);
          }
          if (!caps.length) console.log("(no shared capabilities above threshold)");
        } catch (e) {
          if (/need >=2/.test(e.message)) { console.log("team needs >=2 members with personas"); return; }
          throw e;
        }
        return;
      }
      console.log("usage: tmem contrib team <add <teamId> <subjectId...> | capabilities <teamId>>");
      return;
    }
    case "trajectory": {
      const id = args[0];
      const rawPath = path.join(contribRoot, "raw", id, "raw.json");
      if (!fs.existsSync(rawPath)) { console.error(`no raw data for ${id} — run: tmem contrib raw ${id}`); process.exitCode = 1; return; }
      const { computeTrajectory } = req("contrib_ingest.js");
      const traj = computeTrajectory(JSON.parse(fs.readFileSync(rawPath, "utf8")));
      if (!traj.length) { console.log("(no dated activity)"); return; }
      console.log(`# trajectory: ${id}  (cadence + style by year; PR LOC not measured)`);
      console.log("year\tcommits\tprs\treviews\tavgSubjLen\tconv%");
      for (const r of traj) {
        console.log(`${r.year}\t${r.commits}\t${r.prs}\t${r.reviewsGiven}\t${r.avgSubjectLen}\t${r.convPrefixPct}`);
      }
      return;
    }
    case "compare": {
      const store = new ContribStore(dbPath);
      const [a, b] = args;
      const pa = store.getPersona(a), pb = store.getPersona(b);
      if (!pa || !pb) { console.error("both subjects need a persona (run build first)"); process.exitCode = 1; return; }
      const { DIMENSIONS } = req("contrib_store.js");
      console.log(`# ${a}  vs  ${b}\n`);
      for (const d of DIMENSIONS) {
        console.log(`## ${d}`);
        console.log(`  ${a}: ${pa.dimensions[d] || "-"}`);
        console.log(`  ${b}: ${pb.dimensions[d] || "-"}\n`);
      }
      return;
    }
    default:
      console.log("usage: tmem contrib <add|list-subjects|raw|upsert-atom|atoms|upsert-persona|persona|personas|capabilities|sync|search|compare|trajectory|team>");
  }
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
  scene <name>               Print one full scene block (project-first, then global)
  scenes [list|dedup]        List or deduplicate scene blocks
    --dry-run                Preview dedup without removing
  changelog [--last N]       Show recent memory changes
  persona                    Show current persona
  sync [--full]              Embed missing vectors (delta); --full rebuilds the index
  mark-done                  Mark consolidation complete + release lock
  unlock                     Release stale consolidation lock
  config [consolidate-every [N] | scene-max-tokens [N]]  Show config, or get/set a setting
  daemon <start|status|stop>  Manage the resident embed daemon (warm vector recall)
  contrib <add|ingest|build|persona|playbook|compare|capabilities>  Contributor intelligence`);
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
    case "scene": return cmdScene(restStr);
    case "scenes": return cmdScenes(rest[0], rest);
    case "changelog": return cmdChangelog(rest);
    case "persona": return cmdPersona();
    case "sync": return cmdSync(rest);
    case "mark-done": return cmdMarkDone();
    case "unlock": return cmdUnlock();
    case "config": return cmdConfig(rest);
    case "daemon": return cmdDaemon(rest[0]);
    case "contrib": return cmdContrib(rest);
    default:
      console.error(`Unknown command: ${cmd}. Run 'tmem --help' for usage.`);
      process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
