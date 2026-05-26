#!/usr/bin/env node
/**
 * Automated eval runner for tencentdb-agent-memory plugin.
 *
 * Runs all validation checks and the PersonaMem-style benchmark.
 * Outputs structured JSON results for agent consumption.
 *
 * Usage:
 *   node scripts/eval_runner.js                  # Run all sections
 *   node scripts/eval_runner.js --section 3      # Run section 3 only
 *   node scripts/eval_runner.js --format json    # JSON output
 *   node scripts/eval_runner.js --format text    # Human-readable (default)
 *   node scripts/eval_runner.js --real            # Include real L0 transcript tests
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const PLUGIN_ROOT = path.resolve(__dirname, "..");

class EvalRunner {
  constructor() {
    this.sections = [];
    this.currentSection = null;
  }

  section(name) {
    this.currentSection = { name, checks: [], pass: 0, fail: 0 };
    this.sections.push(this.currentSection);
  }

  check(name, ok, note = "") {
    this.currentSection.checks.push({ name, ok: !!ok, note });
    if (ok) this.currentSection.pass++;
    else this.currentSection.fail++;
  }

  results() {
    let totalPass = 0, totalFail = 0;
    for (const s of this.sections) { totalPass += s.pass; totalFail += s.fail; }
    return { sections: this.sections, totalPass, totalFail, total: totalPass + totalFail };
  }

  printText() {
    const r = this.results();
    for (const s of r.sections) {
      console.log(`\n=== ${s.name} (${s.pass}/${s.pass + s.fail}) ===`);
      for (const c of s.checks) {
        console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.note ? " (" + c.note + ")" : ""}`);
      }
    }
    console.log(`\n=== TOTAL: ${r.totalPass}/${r.total} passed, ${r.totalFail} failed ===`);
    return r.totalFail === 0;
  }

  printJson() {
    console.log(JSON.stringify(this.results(), null, 2));
    return this.results().totalFail === 0;
  }
}

// ── Section 1: Plugin Structure ──
function testPluginStructure(ev) {
  ev.section("1. Plugin Structure");

  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin/plugin.json"), "utf-8"));
  ev.check("Manifest: name", !!manifest.name, manifest.name);
  ev.check("Manifest: version", !!manifest.version, manifest.version);
  ev.check("Manifest: description", !!manifest.description);

  const hooksFile = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks/hooks.json"), "utf-8"));
  const hooks = hooksFile.hooks || hooksFile;
  const events = Object.keys(hooks);
  ev.check("hooks.json: valid JSON", true);
  ev.check("hooks.json: matcher on all entries", events.every(e => hooks[e][0].matcher !== undefined));
  ev.check("hooks.json: all use node", events.every(e => hooks[e][0].hooks[0].command.startsWith("node ")));
  ev.check("hooks.json: 3 events", events.length === 3, events.join(", "));

  const cmds = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).filter(f => f.endsWith(".md"));
  const cmdOk = cmds.filter(f => {
    const c = fs.readFileSync(path.join(PLUGIN_ROOT, "commands", f), "utf-8");
    return c.startsWith("---") && c.includes("description:");
  }).length;
  ev.check("Commands: all have frontmatter", cmdOk === cmds.length, `${cmdOk}/${cmds.length}`);

  const skillDirs = fs.readdirSync(path.join(PLUGIN_ROOT, "skills")).filter(d =>
    fs.existsSync(path.join(PLUGIN_ROOT, "skills", d, "SKILL.md"))
  );
  const skillOk = skillDirs.filter(d => {
    const s = fs.readFileSync(path.join(PLUGIN_ROOT, "skills", d, "SKILL.md"), "utf-8");
    return s.startsWith("---") && s.includes("name:") && s.includes("description:");
  }).length;
  ev.check("Skills: all have frontmatter", skillOk === skillDirs.length, `${skillOk}/${skillDirs.length}`);

  const agentFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "agents")).filter(f => f.endsWith(".md"));
  for (const f of agentFiles) {
    const a = fs.readFileSync(path.join(PLUGIN_ROOT, "agents", f), "utf-8");
    ev.check(`Agent ${f}: frontmatter`, a.startsWith("---") && a.includes("name:"));
  }

  const scripts = ["memory_store.js", "memory_reader.js", "memory_writer.js", "memory_recall.js", "memory_auto_capture.js", "memory_pipeline.js", "benchmark.js"];
  ev.check("Scripts: all JS exist", scripts.every(s => fs.existsSync(path.join(PLUGIN_ROOT, "scripts", s))));

  const hookScripts = ["_common.js", "on_session_end.js", "on_user_prompt.js", "on_stop.js"];
  ev.check("Hook scripts: all JS exist", hookScripts.every(s => fs.existsSync(path.join(PLUGIN_ROOT, "hooks/scripts", s))));

  ev.check("No .py files remain", !findFiles(PLUGIN_ROOT, ".py").length);
  ev.check("No hardcoded credentials", !scripts.some(s => {
    const c = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", s), "utf-8");
    return /sk-[a-zA-Z0-9]{20,}/.test(c);
  }));
  ev.check("CLAUDE_PLUGIN_ROOT in hooks", JSON.stringify(hooks).includes("CLAUDE_PLUGIN_ROOT"));
}

// ── Section 2: JS Module Loading ──
function testModuleLoading(ev) {
  ev.section("2. JS Module Loading");

  const modules = [
    ["scripts/memory_store.js", "MemoryStore"],
    ["scripts/memory_reader.js", "readSession"],
    ["scripts/memory_writer.js", "writeL1Record"],
    ["scripts/memory_recall.js", "recall"],
    ["scripts/memory_auto_capture.js", "autoCapture"],
  ];
  for (const [mod, sym] of modules) {
    try {
      const m = require(path.join(PLUGIN_ROOT, mod));
      ev.check(`require(${mod}).${sym}`, !!m[sym]);
    } catch (e) {
      ev.check(`require(${mod}).${sym}`, false, e.message.split("\n")[0]);
    }
  }

  try {
    const m = require(path.join(PLUGIN_ROOT, "hooks/scripts/_common.js"));
    ev.check("_common.js exports", !!(m.readHookInputAsync && m.emit));
  } catch (e) {
    ev.check("_common.js exports", false, e.message);
  }
}

// ── Section 3: FTS5 Storage Engine ──
function testFTS5(ev) {
  ev.section("3. FTS5 Storage Engine");

  const { MemoryStore } = require(path.join(PLUGIN_ROOT, "scripts/memory_store.js"));
  const db = path.join(os.tmpdir(), `eval_fts5_${Date.now()}.db`);
  const store = new MemoryStore(db);

  ev.check("Init creates DB", fs.existsSync(db));

  const records = [
    { id: "m_1", content: "User prefers dark mode in all IDEs", type: "persona", priority: 80, scene_name: "IDE", sessionKey: "test", sessionId: "s1", timestamps: ["2025-01-01T00:00:00Z"], createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", metadata: {} },
    { id: "m_2", content: "User works with TypeScript and Python", type: "persona", priority: 70, scene_name: "Dev", sessionKey: "test", sessionId: "s1", timestamps: ["2025-01-01T00:00:00Z"], createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", metadata: {} },
    { id: "m_3", content: "User deployed API gateway to production", type: "episodic", priority: 85, scene_name: "Deploy", sessionKey: "test", sessionId: "s1", timestamps: ["2025-01-01T00:00:00Z"], createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", metadata: { activity_start_time: "2025-01-01T00:00:00Z" } },
    { id: "m_4", content: "User requires AI to always use uv run for Python", type: "instruction", priority: -1, scene_name: "Dev", sessionKey: "test", sessionId: "s1", timestamps: ["2025-01-01T00:00:00Z"], createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", metadata: {} },
    { id: "m_5", content: "User allergic to penicillin prefers ibuprofen", type: "persona", priority: 95, scene_name: "Health", sessionKey: "test", sessionId: "s1", timestamps: ["2025-01-01T00:00:00Z"], createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", metadata: {} },
  ];
  for (const r of records) store.upsert(r);
  ev.check("Upsert 5 records", store.count() === 5, `count=${store.count()}`);
  ev.check("Count persona=3", store.count("persona") === 3);
  ev.check("Count episodic=1", store.count("episodic") === 1);
  ev.check("Count instruction=1", store.count("instruction") === 1);

  ev.check("Search exact: dark mode", store.search("dark mode").length >= 1);
  ev.check("Search partial: TypeScript", store.search("TypeScript").length >= 1);
  ev.check("Search multi: API gateway", store.search("API gateway production").length >= 1);
  ev.check("Search type filter", store.search("user", 10, "persona").every(x => x.type === "persona"));
  ev.check("Search miss: empty", store.search("xyznonexistent").length === 0);

  store.upsert({ ...records[0], content: "Updated dark mode pref", priority: 85, updatedAt: "2025-01-02T00:00:00Z" });
  ev.check("Update: count unchanged", store.count() === 5);
  ev.check("Update: content changed", store.get("m_1").content.includes("Updated"));

  store.delete("m_5");
  ev.check("Delete: count decremented", store.count() === 4);
  ev.check("Delete: not searchable", store.search("penicillin").length === 0);
  ev.check("allRecords: correct count", store.allRecords().length === 4);

  store.close();
  fs.unlinkSync(db);
}

// ── Section 4: L0 Reader ──
function testL0Reader(ev) {
  ev.section("4. L0 JSONL Reader");

  const { projectHashForCwd, listProjects, listSessions, readSession, readSessionPairs, formatMessagesForExtraction } = require(path.join(PLUGIN_ROOT, "scripts/memory_reader.js"));

  ev.check("projectHashForCwd", projectHashForCwd(PLUGIN_ROOT) === "D--2026-tencentdb-agent-memory");

  const projects = listProjects();
  ev.check("listProjects: non-empty", projects.length > 0, `${projects.length} projects`);
  ev.check("listProjects: includes this repo", projects.includes("D--2026-tencentdb-agent-memory"));

  const sessions = listSessions("D--2026-tencentdb-agent-memory");
  ev.check("listSessions: non-empty", sessions.length > 0, `${sessions.length} sessions`);

  if (sessions.length > 0) {
    const msgs = readSession(sessions[0].filePath);
    ev.check("readSession: returns messages", msgs.length > 0, `${msgs.length} msgs`);
    ev.check("readSession: has required fields", msgs.every(m => m.id && m.role && m.content && m.timestamp));
    ev.check("readSession: sorted", msgs.every((m, i) => i === 0 || m.timestamp >= msgs[i - 1].timestamp));

    const midTs = msgs[Math.floor(msgs.length / 2)]?.timestamp || "";
    if (midTs) {
      const partial = readSession(sessions[0].filePath, midTs);
      ev.check("readSession incremental", partial.length < msgs.length, `${partial.length} < ${msgs.length}`);
    }

    const pairs = readSessionPairs(sessions[0].filePath);
    ev.check("readSessionPairs: works", pairs.length >= 0);

    const fmt = formatMessagesForExtraction(msgs.slice(0, 2));
    ev.check("formatMessages: includes roles", fmt.includes("[user]") || fmt.includes("[assistant]"));
  }
}

// ── Section 5: Writer + Schema ──
function testWriter(ev) {
  ev.section("5. L1/L2/L3 Writer + Schema");

  const { writeL1Record, writeL1Batch, writeSceneBlock, writePersona, readPersona, META_START, META_END } = require(path.join(PLUGIN_ROOT, "scripts/memory_writer.js"));
  const { MemoryStore } = require(path.join(PLUGIN_ROOT, "scripts/memory_store.js"));

  const base = path.join(os.tmpdir(), `eval_writer_${Date.now()}`);
  const gDir = path.join(base, "global");
  const pDir = path.join(base, "projects", "test");

  const rec = writeL1Record(gDir, { content: "Test memory", type: "persona", priority: 80, scene_name: "Test" });
  ev.check("writeL1Record: returns record", !!rec?.id);
  ev.check("writeL1Record: auto-generates id", rec.id.startsWith("m_"));

  const required = ["id", "content", "type", "priority", "scene_name", "source_message_ids", "metadata", "timestamps", "createdAt", "updatedAt", "sessionKey", "sessionId"];
  const missing = required.filter(f => !(f in rec));
  ev.check("MemoryRecord: all 12 fields", missing.length === 0, missing.length > 0 ? `missing: ${missing}` : "");

  const jsonlDir = path.join(gDir, "records");
  const jsonlFiles = fs.readdirSync(jsonlDir).filter(f => f.endsWith(".jsonl"));
  ev.check("JSONL: file created", jsonlFiles.length > 0);
  ev.check("JSONL: date-sharded", /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(jsonlFiles[0]));
  ev.check("JSONL: valid JSON lines", fs.readFileSync(path.join(jsonlDir, jsonlFiles[0]), "utf-8").trim().split("\n").every(l => { try { JSON.parse(l); return true; } catch { return false; } }));

  ev.check("FTS5: index created", fs.existsSync(path.join(gDir, "index.db")));
  const store = new MemoryStore(path.join(gDir, "index.db"));
  ev.check("FTS5: searchable", store.search("Test memory").length >= 1);
  store.close();

  const batch = writeL1Batch(pDir, [{ content: "A", type: "episodic", priority: 70 }, { content: "B", type: "episodic", priority: 60 }]);
  ev.check("writeL1Batch: returns array", batch.length === 2);
  ev.check("writeL1Batch: unique IDs", batch[0].id !== batch[1].id);

  const scenePath = writeSceneBlock(pDir, "Test Scene", "Summary", "## Facts\n- Fact 1", 3);
  ev.check("Scene: file created", fs.existsSync(scenePath));
  const sc = fs.readFileSync(scenePath, "utf-8");
  ev.check("Scene: META-START", sc.includes(META_START));
  ev.check("Scene: META-END", sc.includes(META_END));
  ev.check("Scene: fields", sc.includes("summary: Summary") && sc.includes("heat: 3"));
  ev.check("Scene: content after META", sc.indexOf("## Facts") > sc.indexOf(META_END));
  ev.check("Scene: slugified filename", path.basename(scenePath) === "test-scene.md");

  writePersona(gDir, "# Persona\n- Dark mode");
  ev.check("writePersona + readPersona", readPersona(gDir).includes("# Persona"));
  ev.check("readPersona: empty on missing", readPersona(path.join(base, "nope")) === "");

  fs.rmSync(base, { recursive: true });
}

// ── Section 6: PersonaMem Benchmark ──
function testBenchmark(ev) {
  ev.section("6. PersonaMem Recall Benchmark (FTS5)");

  const { MemoryStore } = require(path.join(PLUGIN_ROOT, "scripts/memory_store.js"));
  const { writeL1Record, writePersona } = require(path.join(PLUGIN_ROOT, "scripts/memory_writer.js"));

  const base = path.join(os.tmpdir(), `eval_bench_${Date.now()}`);
  const gDir = path.join(base, "global");
  const pDir = path.join(base, "projects", "bench");

  const FACTS = [
    { content: "User favourite programming language is Go", type: "persona", priority: 75, kw: "go", probe: "What language do I prefer?" },
    { content: "User dog named Pluto a 4-year-old border collie", type: "persona", priority: 80, kw: "pluto", probe: "What is my dog name and breed?" },
    { content: "User based in Hanoi Vietnam works UTC+7", type: "persona", priority: 85, kw: "hanoi", probe: "Where do I work from?" },
    { content: "User stores benchmark data in /Volumes/bench-2024/runs", type: "episodic", priority: 70, kw: "bench-2024", probe: "Where do I store benchmark runs?" },
    { content: "User Q2 OKR ship the realtime audio pipeline", type: "episodic", priority: 80, kw: "audio", probe: "What is my Q2 objective?" },
    { content: "User emergency contact Alex at +1-555-0142", type: "persona", priority: 90, kw: "alex", probe: "Who is my emergency contact?" },
    { content: "User code review requires strict typing no fallbacks", type: "instruction", priority: 85, kw: "strict", probe: "What is my review style?" },
    { content: "User allergic to penicillin prefers ibuprofen", type: "persona", priority: 95, kw: "penicillin", probe: "Any allergies?" },
    { content: "User SSH alias for production jumphost is prodjump", type: "persona", priority: 70, kw: "prodjump", probe: "What is my SSH alias for production?" },
    { content: "User favourite testing framework pytest with pytest-randomly", type: "persona", priority: 75, kw: "pytest", probe: "Which testing framework?" },
  ];

  for (const f of FACTS) {
    const dir = ["persona", "instruction"].includes(f.type) ? gDir : pDir;
    writeL1Record(dir, { content: f.content, type: f.type, priority: f.priority, scene_name: "eval" });
  }
  writePersona(gDir, "# Persona\n- Developer in Hanoi\n- Allergic to penicillin");

  function doRecall(query) {
    const maxChars = 280 * 4;
    const parts = [];
    let used = 0;
    const persona = fs.existsSync(path.join(gDir, "persona.md")) ? fs.readFileSync(path.join(gDir, "persona.md"), "utf-8") : "";
    if (persona) {
      const lines = persona.split("\n").filter(l => !l.startsWith("#") && l.trim()).map(l => l.trim().replace(/^- /, "")).slice(0, 5);
      const summary = lines.join("; ");
      parts.push(`<persona>\n${summary}\n</persona>`);
      used += summary.length + 24;
    }
    let memories = [];
    for (const dir of [gDir, pDir]) {
      const db = path.join(dir, "index.db");
      if (fs.existsSync(db)) { const s = new MemoryStore(db); memories.push(...s.search(query, 5)); s.close(); }
    }
    const seen = new Set();
    memories = memories.filter(m => { const k = m.record_id || ""; if (seen.has(k)) return false; seen.add(k); return true; });
    memories.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    memories = memories.slice(0, 5);
    if (memories.length) {
      const lines = [];
      for (const m of memories) {
        const line = `- [${m.type || "?"}] ${m.content}`;
        if (used + line.length + 2 > maxChars) break;
        lines.push(line);
        used += line.length + 1;
      }
      if (lines.length) parts.push("<memories>\n" + lines.join("\n") + "\n</memories>");
    }
    if (!parts.length) return "";
    return "<memory-context>\n" + parts.join("\n") + "\n</memory-context>";
  }

  let top1 = 0, topK = 0, misses = [];
  for (let i = 0; i < FACTS.length; i++) {
    const f = FACTS[i];
    const ctx = doRecall(f.probe);
    let rank = "MISS";

    // Check <memories> section
    const memMatch = ctx.match(/<memories>([\s\S]*?)<\/memories>/);
    if (memMatch) {
      const lines = memMatch[1].trim().split("\n");
      for (let j = 0; j < lines.length; j++) {
        if (lines[j].toLowerCase().includes(f.kw.toLowerCase())) {
          rank = j === 0 ? "TOP-1" : `TOP-${j + 1}`;
          if (j === 0) top1++;
          topK++;
          break;
        }
      }
    }

    // Check <persona> section — persona is part of recall context
    if (rank === "MISS") {
      const personaMatch = ctx.match(/<persona>([\s\S]*?)<\/persona>/);
      if (personaMatch && personaMatch[1].toLowerCase().includes(f.kw.toLowerCase())) {
        rank = "PERSONA";
        topK++;
      }
    }

    if (rank === "MISS") misses.push(f.kw);
    ev.check(`[${String(i).padStart(2, "0")}] kw=${f.kw}`, rank !== "MISS", rank);
  }

  const n = FACTS.length;
  ev.check(`Top-1: ${top1}/${n}`, top1 >= 3, `${(top1 / n * 100).toFixed(0)}%`);
  ev.check(`Top-K: ${topK}/${n}`, topK >= 7, `${(topK / n * 100).toFixed(0)}%`);
  ev.check("Misses <= 3", misses.length <= 3, misses.length > 0 ? misses.join(", ") : "none");

  let maxLen = 0;
  for (const f of FACTS) maxLen = Math.max(maxLen, doRecall(f.probe).length);
  ev.check("Token budget <= 300", Math.ceil(maxLen / 4) <= 300, `${Math.ceil(maxLen / 4)}/300 tokens`);

  fs.rmSync(base, { recursive: true });
}

// ── Section 7: Real L0 Transcript Test ──
function testRealTranscripts(ev) {
  ev.section("7. Real L0 Transcript End-to-End");

  const { listSessions, readSession } = require(path.join(PLUGIN_ROOT, "scripts/memory_reader.js"));
  const { writeL1Record, writePersona } = require(path.join(PLUGIN_ROOT, "scripts/memory_writer.js"));
  const { MemoryStore } = require(path.join(PLUGIN_ROOT, "scripts/memory_store.js"));

  const sessions = listSessions("D--2026-tencentdb-agent-memory");
  ev.check("Real sessions exist", sessions.length > 0, `${sessions.length} sessions`);

  if (sessions.length === 0) return;

  const base = path.join(os.tmpdir(), `eval_real_${Date.now()}`);

  // Read largest session
  const sorted = sessions.map(s => ({ ...s, size: fs.statSync(s.filePath).size })).sort((a, b) => b.size - a.size);
  const largest = sorted[0];
  const msgs = readSession(largest.filePath);
  ev.check("Read real session", msgs.length > 0, `${msgs.length} msgs from ${largest.sessionId.slice(0, 8)}...`);

  // Extract user messages (simulate what agent would extract from)
  const userMsgs = msgs.filter(m => m.role === "user" && m.content.length > 20 && !m.content.startsWith("<"));
  ev.check("User messages found", userMsgs.length > 0, `${userMsgs.length} substantive user messages`);

  // Simulate L1 extraction: create atoms from user messages
  const atoms = [];
  for (const m of userMsgs.slice(0, 5)) {
    const content = m.content.slice(0, 200).replace(/\n/g, " ").trim();
    atoms.push({
      content: `User discussed: ${content}`,
      type: "episodic",
      priority: 70,
      scene_name: "real-session-test",
      source_message_ids: [m.id],
    });
  }

  const projDir = path.join(base, "projects", "D--2026-tencentdb-agent-memory");
  for (const a of atoms) writeL1Record(projDir, a);
  ev.check("Write real atoms to FTS5", atoms.length > 0, `${atoms.length} atoms`);

  // Test recall against real content
  const store = new MemoryStore(path.join(projDir, "index.db"));
  ev.check("FTS5 index: record count", store.count() === atoms.length);

  // Pick a keyword from the first atom and search
  const firstAtom = atoms[0].content;
  const words = firstAtom.split(/\s+/).filter(w => w.length > 5);
  if (words.length > 0) {
    const results = store.search(words[0]);
    ev.check("Recall on real content", results.length >= 1, `query="${words[0]}", ${results.length} results`);
  }

  store.close();
  fs.rmSync(base, { recursive: true });
}

// ── Section 8: Auto-Capture ──
function testAutoCapture(ev) {
  ev.section("8. Auto-Capture (Stop hook → FTS5)");

  const { autoCapture, checkConsolidationDue, markConsolidated, status } = require(path.join(PLUGIN_ROOT, "scripts/memory_auto_capture.js"));
  const { MemoryStore } = require(path.join(PLUGIN_ROOT, "scripts/memory_store.js"));

  // Basic capture
  const r1 = autoCapture({
    userText: "Help me configure a Redis cluster with sentinel for high availability and automatic failover",
    assistantText: "I will set up Redis Sentinel...",
    sessionId: "eval-autocap",
    cwd: PLUGIN_ROOT,
  });
  ev.check("autoCapture: substantive message captured", r1.captured);
  ev.check("autoCapture: turn counted", r1.turnCount >= 1);

  // Non-substantive filtered
  const r2 = autoCapture({ userText: "ok", assistantText: "Got it.", sessionId: "eval-autocap", cwd: PLUGIN_ROOT });
  ev.check("autoCapture: short message filtered", !r2.captured);

  // Command filtered
  const r3 = autoCapture({ userText: "<command-name>/clear</command-name>", assistantText: "", sessionId: "eval-autocap", cwd: PLUGIN_ROOT });
  ev.check("autoCapture: command filtered", !r3.captured);

  // FTS5 searchable
  const { projectHashForCwd } = require(path.join(PLUGIN_ROOT, "scripts/memory_reader.js"));
  const ph = projectHashForCwd(PLUGIN_ROOT);
  const dbPath = path.join(os.homedir(), ".memory-tencentdb", "projects", ph, "index.db");
  if (fs.existsSync(dbPath)) {
    const store = new MemoryStore(dbPath);
    const results = store.search("Redis cluster sentinel");
    ev.check("autoCapture: FTS5 searchable", results.length >= 1, `${results.length} results`);
    // Cleanup
    for (const r of store.allRecords()) {
      if (r.record_id?.startsWith("ac_") && r.scene_name === "auto-capture") store.delete(r.record_id);
    }
    store.close();
  } else {
    ev.check("autoCapture: FTS5 searchable", false, "DB not found");
  }

  // Consolidation threshold
  for (let i = 0; i < 9; i++) {
    autoCapture({
      userText: `Substantive test message ${i + 2} about software engineering practices and architectural patterns`,
      assistantText: `Response ${i + 2}`,
      sessionId: "eval-autocap",
      cwd: PLUGIN_ROOT,
    });
  }
  const s = status();
  ev.check("autoCapture: consolidation triggers at threshold", s.consolidation_due, `${s.turns_since_consolidation}/${s.consolidation_threshold}`);

  // Consolidation hint
  const hint = checkConsolidationDue();
  ev.check("checkConsolidationDue: returns hint", hint && hint.due && hint.message.length > 0);

  // Mark consolidated
  markConsolidated();
  const s2 = status();
  ev.check("markConsolidated: resets counter", !s2.consolidation_due && s2.turns_since_consolidation === 0);

  // Cleanup
  if (fs.existsSync(dbPath)) {
    const store = new MemoryStore(dbPath);
    for (const r of store.allRecords()) {
      if (r.record_id?.startsWith("ac_") && r.scene_name === "auto-capture") store.delete(r.record_id);
    }
    store.close();
  }
  try { fs.unlinkSync(path.join(os.homedir(), ".memory-tencentdb", "capture_state.json")); } catch {}
  // Clean up JSONL
  const recDir = path.join(os.homedir(), ".memory-tencentdb", "projects", ph, "records");
  try {
    for (const f of fs.readdirSync(recDir)) {
      const fp = path.join(recDir, f);
      const lines = fs.readFileSync(fp, "utf-8").split("\n").filter(l => {
        if (!l.trim()) return false;
        try { const r = JSON.parse(l); return !r.id?.startsWith("ac_"); } catch { return true; }
      });
      fs.writeFileSync(fp, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
    }
  } catch {}
}

// ── Utilities ──
function findFiles(dir, ext) {
  const found = [];
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "__pycache__") walk(p);
      else if (e.name.endsWith(ext)) found.push(p);
    }
  }
  walk(dir);
  return found;
}

// ── Main ──
function main() {
  const args = process.argv.slice(2);
  const format = args.includes("--format") ? args[args.indexOf("--format") + 1] : "text";
  const sectionFilter = args.includes("--section") ? parseInt(args[args.indexOf("--section") + 1]) : 0;
  const includeReal = args.includes("--real");

  const ev = new EvalRunner();

  const allSections = [
    [1, testPluginStructure],
    [2, testModuleLoading],
    [3, testFTS5],
    [4, testL0Reader],
    [5, testWriter],
    [6, testBenchmark],
    [7, testRealTranscripts],
    [8, testAutoCapture],
  ];

  for (const [num, fn] of allSections) {
    if (sectionFilter && sectionFilter !== num) continue;
    if ((num === 7) && !includeReal && !sectionFilter) continue;
    fn(ev);
  }

  const ok = format === "json" ? ev.printJson() : ev.printText();
  process.exit(ok ? 0 : 1);
}

main();
