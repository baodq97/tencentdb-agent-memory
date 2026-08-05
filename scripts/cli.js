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

// Resolve a `--scope global|project` flag to its store dir. One definition shared
// by the persona read + write commands so they can't drift on what a scope means.
function resolveScope(args, usage) {
  const i = args.indexOf("--scope");
  const scope = i >= 0 ? (args[i + 1] || "") : "global";
  if (scope !== "global" && scope !== "project") { console.error(usage); process.exit(1); }
  const { gDir, pDir } = getDirs();
  return { scope, dir: scope === "project" ? pDir : gDir };
}

function storeRecordCount(dir) {
  const db = path.join(dir, "index.db");
  if (!fs.existsSync(db)) return 0;
  try { const { MemoryStore } = req("memory_store.js"); const s = new MemoryStore(db); const n = s.allRecords("", 100000).length; s.close(); return n; }
  catch { return 0; }
}
function storeSceneCount(dir) {
  try { return fs.readdirSync(path.join(dir, "scene_blocks")).filter(f => f.endsWith(".md")).length; }
  catch { return 0; }
}
// True iff `child` is the same path as, or nested under, `parent` (symlink-safe-ish via resolve).
function isInside(child, parent) {
  const c = path.resolve(child), p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
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
  const { recallAsync, recall, RECALL_SOURCE } = req("memory_recall.js");
  const { pHash } = getDirs();
  // `source` is stated, not sniffed: this is someone deliberately looking
  // something up, which the read log must not mix with the prompt hook's
  // unattended per-turn recall. maxTokens/topK keep their defaults.
  try {
    const ctx = await recallAsync(query, pHash, undefined, undefined, RECALL_SOURCE.CLI);
    console.log(ctx || "(no relevant memories)");
  } catch {
    console.log(recall(query, pHash, undefined, undefined, RECALL_SOURCE.CLI) || "(no relevant memories)");
  }
}

// ── search ──
// tmem search <query>                  global + current project (default)
// tmem search <query> --all            global + EVERY project store (cross-project)
// tmem search <query> --project <slug> global + one named project store
function cmdSearch(rest) {
  const args = Array.isArray(rest) ? rest : [String(rest || "")];
  const all = args.includes("--all");
  const projIdx = args.indexOf("--project");
  const onlyProj = projIdx !== -1 ? args[projIdx + 1] : null;
  const query = args
    .filter((a, i) => a !== "--all" && a !== "--project" && !(projIdx !== -1 && i === projIdx + 1))
    .join(" ").trim();
  if (!query) { console.error("Usage: tmem search <query> [--all | --project <slug>]"); process.exit(1); }

  const { MemoryStore } = req("memory_store.js");
  const { globalDir, projectDir, listProjectHashes } = req("memory_writer.js");
  const { pHash } = getDirs();

  // [label, dir] stores to search, in display order.
  const targets = [["global", globalDir()]];
  if (all) {
    for (const h of listProjectHashes()) targets.push([h, projectDir(h)]);
  } else if (onlyProj) {
    targets.push([onlyProj, projectDir(onlyProj)]);
  } else {
    targets.push([pHash, projectDir(pHash)]);
  }

  let total = 0;
  for (const [label, dir] of targets) {
    const db = path.join(dir, "index.db");
    if (!fs.existsSync(db)) continue;
    const store = new MemoryStore(db);
    const hits = store.search(query, 10);
    store.close();
    if (!hits.length) continue;
    if (all || onlyProj) console.log(`\n# ${label}  (${hits.length})`);
    for (const r of hits) {
      console.log(`[${r.type || "?"}] (p=${r.priority}) ${r.content}`);
    }
    total += hits.length;
  }
  if (!total) console.log("No matches for:", query);
}

// ── projects ── discover every memory store (incl. fragments) for cross-project work
function cmdProjects() {
  const { globalDir, projectDir, listProjectHashes } = req("memory_writer.js");
  const { pHash } = getDirs();

  const rows = [["global", globalDir()], ...listProjectHashes().map(h => [h, projectDir(h)])]
    .map(([slug, dir]) => ({ slug, recs: storeRecordCount(dir), scenes: storeSceneCount(dir) }))
    .sort((a, b) => b.recs - a.recs);

  console.log(`STORE${" ".repeat(67)} recs scenes`);
  for (const r of rows) {
    const cur = r.slug === pHash ? " *" : "";
    const name = (r.slug.length > 70 ? "…" + r.slug.slice(-69) : r.slug).padEnd(70);
    console.log(`${name} ${String(r.recs).padStart(4)} ${String(r.scenes).padStart(6)}${cur}`);
  }
  console.log(`\n${rows.length} stores  (* = current project)  ·  search one: tmem search <q> --project <slug>  ·  all: tmem search <q> --all`);
}

// ── migrate-fragments ── collapse cwd-keyed fragment stores into their project root.
// Legacy stores keyed by a subdir/worktree cwd (before project-root keying) are merged
// into the store of their real project root. Dry-run by default; --apply executes.
// Safety: records dedup by id (idempotent), scenes keep the newer on name clash, and
// fragments are ARCHIVED (never deleted) under <base>/.migrated/.
function cmdMigrateFragments(args) {
  const apply = (args || []).includes("--apply");
  const { MemoryStore } = req("memory_store.js");
  const { memoryBaseDir, projectDir, listProjectHashes, parseSceneMeta } = req("memory_writer.js");
  const { projectHashForCwd, pathFromSlugProbe, findProjectRoot } = req("memory_reader.js");

  const base = memoryBaseDir();
  const projectsRoot = path.join(base, "projects");
  const archiveRoot = path.join(base, ".migrated");

  const slugs = listProjectHashes();

  // Pass 1 — probe each store to its directory, then classify via the GIT project root.
  // gitRoots holds only slugs backed by a real `.git` (dir or worktree) — used both to
  // detect fragments and, crucially, as the ONLY valid recovery targets so orphans never
  // get dumped into a generic non-git directory store (e.g. ~/projects).
  const gitRoots = new Set();
  const probed = new Map(); // slug -> { target, isGitRoot } | null
  for (const slug of slugs) {
    const p = pathFromSlugProbe(slug);
    if (!p) { probed.set(slug, null); continue; }
    const r = findProjectRoot(p);           // non-null only when a .git was found
    const target = projectHashForCwd(p);     // slug of r, or raw-path slug when no .git
    probed.set(slug, { target, hasGit: !!r });
    if (r && target === slug) gitRoots.add(slug);
  }
  for (const v of probed.values()) if (v && v.hasGit) gitRoots.add(v.target);

  // Pass 2 — classify. A deleted-dir fragment (probe null) or a misprobe is recovered by
  // the LONGEST git root that prefixes its slug; its slug still embeds the live root.
  const merges = [], unresolved = [];
  const longestGitRootPrefix = (slug) => {
    let best = null;
    for (const r of gitRoots) if (r !== slug && slug.startsWith(r + "-") && (!best || r.length > best.length)) best = r;
    return best;
  };
  for (const slug of slugs) {
    const v = probed.get(slug);
    if (v && v.hasGit && v.target === slug) continue; // a real git root — keep as-is
    let target = (v && v.hasGit && v.target !== slug && slug.startsWith(v.target + "-")) ? v.target : null;
    if (!target) target = longestGitRootPrefix(slug);
    if (!target) {
      const reason = !v ? "original dir gone" : "no git root (kept as its own store)";
      unresolved.push({ slug, reason });
      continue;
    }
    const dir = projectDir(slug);
    merges.push({ slug, target, recs: storeRecordCount(dir), scenes: storeSceneCount(dir) });
  }

  if (!merges.length) {
    console.log("No fragments to migrate — every resolvable store already keys to its project root.");
    if (unresolved.length) console.log(`(${unresolved.length} store(s) unresolved — original dir gone; left untouched. Inspect with: tmem search <q> --project <slug>)`);
    return;
  }

  console.log(apply ? "Migrating fragments:" : "Migration plan (dry-run — pass --apply to execute):");
  for (const m of merges) console.log(`  ${m.slug}\n    → ${m.target}   (${m.recs} recs, ${m.scenes} scenes)`);
  for (const u of unresolved) console.log(`  ${u.slug}\n    → SKIP (${u.reason})`);
  if (!apply) {
    console.log(`\n${merges.length} mergeable, ${unresolved.length} unresolved. Re-run with --apply to execute (fragments are archived, not deleted).`);
    return;
  }

  const sceneUpdated = (file) => {
    const meta = parseSceneMeta(file); // takes a filepath, reads + parses it
    return (meta && meta.updated) || "";
  };

  let movedRecs = 0, movedScenes = 0, archived = 0;
  for (const m of merges) {
    const srcDir = path.resolve(projectDir(m.slug));
    const tgtDir = projectDir(m.target);
    if (!isInside(srcDir, projectsRoot)) { console.error(`  ! refuse (escapes ${projectsRoot}): ${srcDir}`); continue; }

    // 1) records — source of truth is the fragment's records/*.jsonl (original atom shape).
    //    Dedup by id against the target index; upsert is idempotent.
    const tgtDb = path.join(tgtDir, "index.db");
    const existing = new Set();
    if (fs.existsSync(tgtDb)) { const t = new MemoryStore(tgtDb); for (const r of t.allRecords("", 100000)) existing.add(r.record_id || r.id); t.close(); }
    const srcRecordsDir = path.join(srcDir, "records");
    const atoms = [];
    if (fs.existsSync(srcRecordsDir)) {
      for (const f of fs.readdirSync(srcRecordsDir).filter(x => x.endsWith(".jsonl"))) {
        for (const line of fs.readFileSync(path.join(srcRecordsDir, f), "utf-8").split("\n")) {
          if (!line.trim()) continue;
          try { atoms.push(JSON.parse(line)); } catch {}
        }
      }
    }
    const fresh = atoms.filter(a => a.id && !existing.has(a.id));
    if (fresh.length) {
      fs.mkdirSync(path.join(tgtDir, "records"), { recursive: true });
      fs.appendFileSync(path.join(tgtDir, "records", "migrated.jsonl"),
        fresh.map(a => JSON.stringify(a)).join("\n") + "\n", "utf-8");
      const t = new MemoryStore(tgtDb);
      for (const a of fresh) { t.upsert(a); movedRecs++; }
      t.close();
    }

    // 2) scenes — copy; on name clash keep whichever was updated more recently.
    const srcScenes = path.join(srcDir, "scene_blocks");
    if (fs.existsSync(srcScenes)) {
      const tgtScenes = path.join(tgtDir, "scene_blocks");
      fs.mkdirSync(tgtScenes, { recursive: true });
      for (const f of fs.readdirSync(srcScenes).filter(x => x.endsWith(".md"))) {
        const sp = path.join(srcScenes, f), tp = path.join(tgtScenes, f);
        if (fs.existsSync(tp) && sceneUpdated(tp) >= sceneUpdated(sp)) continue;
        fs.copyFileSync(sp, tp);
        movedScenes++;
      }
    }

    // 3) archive the fragment (never delete).
    fs.mkdirSync(archiveRoot, { recursive: true });
    const dest = path.join(archiveRoot, m.slug);
    if (!isInside(dest, archiveRoot)) { console.error(`  ! refuse archive (escapes ${archiveRoot}): ${dest}`); continue; }
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    fs.renameSync(srcDir, dest);
    archived++;
  }

  console.log(`\nDone: merged ${movedRecs} records + ${movedScenes} scenes from ${archived} fragment(s). Archived under ${archiveRoot} (delete when satisfied).`);
  console.log(`Next: run \`tmem sync\` in each affected project to embed the migrated records' vectors.`);
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
// Tier 2 of the persona delivery model. Tier 0 (`always`) rides the session
// preamble and tier 1 (`conditional`) is injected per turn, but everything
// classified `reference` is never injected at all — `## Environment & Access`
// is 9-of-9 reference, so without an on-demand read it is unreachable. This
// mirrors `tmem scene <name>`: the always-on surface carries the index, the
// full block is fetched by name when someone actually needs it.

// Fold a section name or a user's guess at one into a comparable slug, so
// "Working Style", "working style" and "working-style" all collapse to the same
// key. `&` becomes a separator rather than being dropped, which keeps
// "environment-access" (what a human types) matching "Environment & Access".
function personaSlug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Split the raw persona on `##`+ headings so a requested section can be printed
// byte-for-byte. parsePersona() normalizes bullets (markers stripped, newlines
// collapsed) which is right for projection but wrong for a verbatim read, so we
// use it for names/counts and this for the text.
function personaRawSections(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const out = new Map();
  let name = null, buf = [];
  const flush = () => { if (name !== null && !out.has(name)) out.set(name, buf.join("\n").replace(/\n+$/, "")); };
  for (const line of lines) {
    const h = /^(#{2,6})\s+(.*)$/.exec(line);
    if (h) { flush(); name = h[2].trim(); buf = [line]; continue; }
    if (name !== null) buf.push(line);
  }
  flush();
  return out;
}

// Exact slug match wins; otherwise prefix, then substring. Each fallback is
// applied only when the previous produced nothing, so a section whose name is a
// prefix of another ("Working" vs "Working Style") still resolves exactly.
function resolvePersonaSection(sections, query) {
  const q = personaSlug(query);
  if (!q) return { status: "empty" };
  const slugs = sections.map(s => ({ section: s, slug: personaSlug(s.name) }));
  for (const pick of [
    slugs.filter(x => x.slug === q),
    slugs.filter(x => x.slug.startsWith(q)),
    slugs.filter(x => x.slug.includes(q)),
  ]) {
    if (pick.length === 1) return { status: "ok", section: pick[0].section };
    if (pick.length > 1) return { status: "ambiguous", matches: pick.map(x => x.section) };
  }
  return { status: "missing" };
}

function printPersonaSectionList(sections, dutyCounts, prefix) {
  for (const s of sections) {
    const c = dutyCounts([s]);
    console.log(`${prefix}${s.name}  (${personaSlug(s.name)})  ${s.bullets.length} bullets  always=${c.always} conditional=${c.conditional} reference=${c.reference}`);
  }
}

function cmdPersona(args) {
  const { readPersona } = req("memory_writer.js");
  const argv = args || [];
  // --scope project reads THIS repo's Operating Doctrine; default is the global persona.
  const { dir } = resolveScope(argv, "usage: tmem persona [--scope global|project] [--sections | --section <name>]");
  const p = readPersona(dir);

  const wantList = argv.includes("--sections");
  const secIdx = argv.indexOf("--section");
  const wantSection = secIdx !== -1;
  // Section names contain spaces; take every token after --section UP TO the next
  // flag, so `--section Working Style` works and a trailing `--scope project`
  // doesn't bleed its value into the section name.
  const sectionName = wantSection
    ? (() => {
        const tail = [];
        for (const a of argv.slice(secIdx + 1)) { if (a.startsWith("--")) break; tail.push(a); }
        return tail.join(" ");
      })()
    : "";

  if (!wantList && !wantSection) { console.log(p || "(no persona yet)"); return; }

  if (!p) { console.error("(no persona yet)"); process.exit(1); }

  const { parsePersona, annotate, dutyCounts } = req("persona_projection.js");
  const sections = annotate(parsePersona(p)).filter(s => s.name);
  if (!sections.length) { console.error("Persona has no `##` sections to address."); process.exit(1); }

  if (wantList) {
    const total = dutyCounts(sections);
    console.log(`Persona sections (${sections.length}, ${p.length} chars, ${total.always + total.conditional + total.reference} bullets):`);
    printPersonaSectionList(sections, dutyCounts, "  ");
    console.log(`\nTotals: always=${total.always} conditional=${total.conditional} reference=${total.reference}`);
    console.log(`Read one: tmem persona --section <name>`);
    return;
  }

  const res = resolvePersonaSection(sections, sectionName);
  if (res.status === "empty") {
    console.error("Usage: tmem persona --section <name>  (names from `tmem persona --sections`)");
    process.exit(1);
  }
  if (res.status === "ambiguous") {
    console.error(`Ambiguous section: ${sectionName}. Matches:`);
    for (const s of res.matches) console.error(`  ${s.name}  (${personaSlug(s.name)})`);
    process.exit(1);
  }
  if (res.status === "missing") {
    console.error(`Persona section not found: ${sectionName}. Available:`);
    for (const s of sections) console.error(`  ${s.name}  (${personaSlug(s.name)})  ${s.bullets.length} bullets`);
    process.exit(1);
  }

  const raw = personaRawSections(p).get(res.section.name);
  if (raw) console.log(raw);
  else {
    // No verbatim block recovered (heading shapes disagreed) — fall back to the
    // parsed bullets so the content is still reachable.
    console.log(`## ${res.section.name}`);
    for (const b of res.section.bullets) console.log(`- ${b.text}`);
  }
  const c = dutyCounts([res.section]);
  console.log(`\n(${res.section.bullets.length} bullets — always=${c.always} conditional=${c.conditional} reference=${c.reference})`);
}

// ── sync ──
// Embed records into the vector index. Default: delta only (newest records missing
// vectors). With --full: re-embed every record (former `reindex`).
async function cmdSync(args) {
  const full = (args || []).includes("--full");
  const all = (args || []).includes("--all");
  const { MemoryStore } = req("memory_store.js");
  const { VectorStore } = req("vector_store.js");
  const { getEmbeddingService } = req("embedding_service.js");

  // Target stores. Default: current project + global (matches recall's view).
  // --all: global + every project store. Shared with prune/dedup so the "which
  // stores does a whole-root op touch" rule lives in ONE place (maintenanceTargets).
  const targets = maintenanceTargets(all);

  // Decide which records to embed, per dir.
  const todo = []; // [{ dir, ...record }]
  let degradedStores = 0; // stores skipped because sqlite-vec would not load
  for (const [label, dir] of targets) {
    const dbPath = path.join(dir, "index.db");
    if (!fs.existsSync(dbPath)) continue;
    const ftsStore = new MemoryStore(dbPath);
    const records = ftsStore.allRecords("", 10000);
    ftsStore.close();
    if (!records.length) continue;

    const vecStore = new VectorStore(path.join(dir, "vectors.db"));
    // Degraded is NOT "in sync": the vector engine failed to load, so nothing
    // could be embedded. Counting it silently as done reported "all in sync" on a
    // store with zero vectors — the exact false-positive this tool exists to
    // catch. Surface it instead so the missing-vector gap stays visible.
    if (vecStore.degraded) { vecStore.close(); degradedStores++; continue; }
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

  if (degradedStores > 0) {
    console.error(`⚠ ${degradedStores} store(s) skipped: sqlite-vec did not load, so vectors cannot be embedded here. Run where the vector engine is available (installed plugin / daemon host).`);
  }
  if (!todo.length) {
    console.log(degradedStores > 0
      ? "No vectors embedded (vector engine unavailable — see warning above)."
      : (full ? "No records to embed." : "All vectors in sync."));
    return;
  }

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

// ── prune / dedup shared plumbing ──
//
// Target stores for a whole-root operation. Default: current project + global
// (what recall sees). --all: global + every project store. This is the ONE
// definition of "which stores does a whole-root op touch" — sync, prune and dedup
// all read it, so the enumeration rule cannot drift between them.
function maintenanceTargets(all) {
  const { globalDir, projectDir, listProjectHashes } = req("memory_writer.js");
  if (!all) {
    const { gDir, pDir, pHash } = getDirs();
    return [["global", gDir], [pHash || "project", pDir]];
  }
  const targets = [["global", globalDir()]];
  for (const h of listProjectHashes()) {
    if (projectDir(h) === globalDir()) continue;
    targets.push([h, projectDir(h)]);
  }
  return targets;
}

/**
 * Remove `records` from ONE already-open store, ARCHIVING first so the sweep is
 * reversible. The caller owns `store` (it read the records off it) and closes it;
 * taking the open handle here avoids re-opening the same index.db a second time.
 *
 * Order matters: write the archive, then delete from FTS (index.db), then from
 * vectors.db. index.db is authoritative for recall (nothing rebuilds it from the
 * records/*.jsonl log during normal use), so a record gone from index.db is gone
 * from recall; the append-only JSONL log is left intact as history and the
 * archive under `<dir>/.pruned/` is the restore point. Returns #removed.
 */
function applyRemoval(store, dir, records, { reason, apply }) {
  if (!records.length) return 0;
  if (!apply) return records.length; // dry-run: count only, touch nothing

  const { VectorStore } = req("vector_store.js");

  // Archive (full record JSON) before anything is deleted.
  const archiveDir = path.join(dir, ".pruned");
  fs.mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(archiveDir, `${reason}-${stamp}.jsonl`);
  fs.appendFileSync(archivePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");

  const vecPath = path.join(dir, "vectors.db");
  const vec = fs.existsSync(vecPath) ? new VectorStore(vecPath) : null;
  let removed = 0;
  for (const r of records) {
    try {
      store.delete(r.record_id);
      if (vec && !vec.degraded) { try { vec.deleteVec(r.record_id); } catch {} }
      removed++;
    } catch {}
  }
  if (vec) vec.close();
  return removed;
}

/**
 * Walk the target stores once, let `select(records)` choose what to remove per
 * store, archive+delete it, and return per-store results plus totals. Shared by
 * prune and dedup so the open-once/read/apply/close/accumulate plumbing lives in
 * ONE place; each command supplies only its selector and its own log wording.
 * `select` returns `{ targets, meta }` — `meta` is opaque per-store detail the
 * command aggregates (e.g. dedup's group count).
 */
function sweepStores(all, apply, { reason, select }) {
  const { MemoryStore } = req("memory_store.js");
  const perStore = [];
  let totalTargets = 0, totalRemoved = 0;
  for (const [label, dir] of maintenanceTargets(all)) {
    const dbPath = path.join(dir, "index.db");
    if (!fs.existsSync(dbPath)) continue;
    const store = new MemoryStore(dbPath);
    const records = store.allRecords("", 100000);
    const { targets, meta } = select(records);
    const removed = targets.length ? applyRemoval(store, dir, targets, { reason, apply }) : 0;
    store.close();
    if (!targets.length) continue;
    totalTargets += targets.length;
    totalRemoved += removed;
    perStore.push({ label, total: records.length, targets: targets.length, removed, meta });
  }
  return { perStore, totalTargets, totalRemoved };
}

// ── prune (low-signal) ──
//
// Remove ONLY records the system itself treats as safe to destroy — the
// NOISE_GATE_CLASSES (taskNotification, skillEcho, empty), via low_signal's
// `noiseClasses()`. This is deliberately NARROWER than classifyLowSignal(): the
// full classifier also flags `pasteDump` (any record ≥ a length threshold) and
// `slashOrTag`, which catch legitimate long content — meeting transcripts, notes
// that quote a command. Those are REPORTED by the health snapshot but must never
// be auto-deleted (see the "reporting junk ≠ destroying it" note in low_signal.js).
// Dry-run by default; --apply archives then removes.
async function cmdPrune(args) {
  const a = args || [];
  if (!a.includes("--low-signal")) {
    console.error("Usage: tmem prune --low-signal [--all] [--apply]");
    process.exit(1);
  }
  const all = a.includes("--all");
  const apply = a.includes("--apply");
  const { noiseClasses } = req("low_signal.js");

  const perClass = {};
  const { perStore, totalTargets, totalRemoved } = sweepStores(all, apply, {
    reason: "low-signal",
    select: (records) => {
      const targets = [];
      for (const r of records) {
        const classes = noiseClasses(r.content);
        if (classes.length) {
          targets.push(r);
          for (const c of classes) perClass[c] = (perClass[c] || 0) + 1;
        }
      }
      return { targets };
    },
  });

  for (const s of perStore) {
    console.log(`${s.label}: ${apply ? `removed ${s.removed}` : `${s.targets} would be removed`} (of ${s.total})`);
  }
  const cls = Object.entries(perClass).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  if (cls) console.log(`Classes: ${cls}`);
  if (apply) console.log(`\nPruned ${totalRemoved} low-signal records (archived under each store's .pruned/).`);
  else console.log(`\n${totalTargets} low-signal records would be pruned. Re-run with --apply to remove (archived, reversible).`);
}

// ── dedup (atoms) ──
//
// Remove exact-duplicate atoms, keeping the NEWEST of each group. Uses the SAME
// exactKey the health snapshot's duplicate count uses, so the number pruned
// matches the number reported. Dry-run by default; --apply archives then removes.
async function cmdDedup(args) {
  const a = args || [];
  if (!a.includes("--atoms")) {
    console.error("Usage: tmem dedup --atoms [--all] [--apply]");
    process.exit(1);
  }
  const all = a.includes("--all");
  const apply = a.includes("--apply");
  const { exactKey } = require(path.join(SCRIPTS_DIR, "view", "transform.js"));

  const { perStore, totalTargets, totalRemoved } = sweepStores(all, apply, {
    reason: "dedup",
    select: (records) => {
      // Group by exact content key; keep the newest, target the rest.
      const byKey = new Map();
      for (const r of records) {
        const k = exactKey(r.content);
        if (!k) continue;
        let bucket = byKey.get(k);
        if (!bucket) { bucket = []; byKey.set(k, bucket); }
        bucket.push(r);
      }
      const targets = [];
      let groups = 0;
      for (const bucket of byKey.values()) {
        if (bucket.length < 2) continue;
        groups++;
        bucket.sort((x, y) => (y.updated_time || "").localeCompare(x.updated_time || ""));
        targets.push(...bucket.slice(1)); // keep [0] (newest), drop rest
      }
      return { targets, meta: { groups } };
    },
  });

  const totalGroups = perStore.reduce((n, s) => n + (s.meta.groups || 0), 0);
  for (const s of perStore) {
    console.log(`${s.label}: ${apply ? `removed ${s.removed}` : `${s.targets} would be removed`} across ${s.meta.groups} group(s)`);
  }
  if (apply) console.log(`\nDe-duplicated ${totalRemoved} atoms in ${totalGroups} group(s) (archived under each store's .pruned/).`);
  else console.log(`\n${totalTargets} duplicate atoms in ${totalGroups} group(s) would be removed. Re-run with --apply (archived, reversible).`);
}

// ── atoms ──
function cmdAtoms(args) {
  const { MemoryStore } = req("memory_store.js");
  const { gDir, pDir, pHash } = getDirs();
  const typeFilter = "";
  const limit = 500;
  const scope = args.find((a) => ["global", "project", "all"].includes(a)) || "all";

  // Incremental read (upstream last_extraction_updated_time parity): scope the
  // load to atoms updated after a cursor so consolidation reads the DELTA, not
  // the whole pool. `--since <ts>` is an explicit cursor; `--since-last` resolves
  // the stored per-project watermark. Empty cursor ⇒ full pool (cold start).
  let since = "";
  const iSince = args.indexOf("--since");
  if (iSince !== -1 && args[iSince + 1]) since = args[iSince + 1];
  if (args.includes("--since-last")) {
    const st = req("memory_writer.js").readState();
    since = (st.projects && st.projects[pHash] && st.projects[pHash].last_consolidated) || "";
  }

  const load = (db) => {
    if (!fs.existsSync(db)) return [];
    const store = new MemoryStore(db);
    const rows = store.recordsSince(since, typeFilter, limit); // "" ⇒ allRecords
    store.close();
    return rows;
  };

  const result = {};
  if (scope === "all" || scope === "global") result.global = load(path.join(gDir, "index.db"));
  if (scope === "all" || scope === "project") result.project = load(path.join(pDir, "index.db"));
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
  const { projectHashForCwd, claudeProjectsDir, readSession } = req("memory_reader.js");
  const { filterGrounded } = req("grounding.js");

  let data = "";
  try { data = fs.readFileSync(0, "utf-8"); } catch {}
  if (!data.trim()) { console.error("Pipe JSON array to stdin. E.g.: echo '[{...}]' | tmem write-l1"); process.exit(1); }

  const records = JSON.parse(data);
  const pHash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || ".");
  const sessionId = args.find((a, i) => args[i - 1] === "--session") || "";

  // Grounding gate (PR #266, graceful): when the transcript resolves, drop atoms
  // whose content isn't grounded in their cited source messages. No source text
  // available (no --session / unresolvable ids) → keep all, as before.
  let toWrite = Array.isArray(records) ? records : [records];
  let droppedCount = 0;
  if (sessionId) {
    const idToText = new Map();
    try {
      const file = path.join(claudeProjectsDir(), pHash, `${sessionId}.jsonl`);
      for (const m of readSession(file)) if (m.id) idToText.set(m.id, m.content);
    } catch {}
    const { kept, dropped } = filterGrounded(toWrite, idToText);
    toWrite = kept;
    droppedCount = dropped.length;
    for (const d of dropped) {
      console.error(`Dropped ungrounded atom: "${String(d.content || "").slice(0, 80)}"`);
    }
  }

  let count = 0;
  for (const rec of toWrite) {
    const base = ["persona", "instruction"].includes(rec.type) ? globalDir() : projectDir(pHash);
    writeL1Record(base, rec);
    count++;
  }
  if (sessionId) updateState(sessionId, pHash, "completed");
  console.log(`Wrote ${count} L1 atoms${droppedCount ? ` (dropped ${droppedCount} ungrounded)` : ""}`);
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
function cmdWritePersona(args = []) {
  const { writePersona } = req("memory_writer.js");
  const force = args.includes("--force");
  // --scope global (default) → the cross-project persona; --scope project → this
  // repo's Operating Doctrine (the hybrid model: common traits global, per-project
  // deltas in the project store). Family/caps by scope are layered on in WS2b.
  const { scope, dir: targetDir } = resolveScope(args, "usage: tmem write-persona [--scope global|project] [--force]");
  let content = "";
  try { content = fs.readFileSync(0, "utf-8"); } catch {}
  if (!content.trim()) { console.error("Pipe persona content to stdin. E.g.: echo '# Persona...' | tmem write-persona"); process.exit(1); }

  // WS2 budget gate: a persona is only useful if every standing (`always`) rule
  // actually reaches the agent. The reader can only drop, never condense, so
  // overflow is SILENT data loss on standing instructions. Reject at write time
  // (gate-not-convention) so the consolidator must compress rather than bloat.
  // `--force` is the escape hatch for a deliberate raw write.
  // WS7 hygiene: the GLOBAL persona propagates into every project, so it must not
  // carry machine/infra secrets (redirect URIs, subscription/tenant ids, tokens).
  // Reject at write time; the agent should abstract the value or use --scope project.
  // Project doctrine is exempt — a repo's own doctrine may name its own hosts.
  if (scope === "global" && !force) {
    const { isSensitive, redactSensitive } = req("redact.js");
    if (isSensitive(content)) {
      console.error("Global persona rejected — it contains sensitive/infra values that would leak into every project:");
      console.error("  " + redactSensitive(content.trim()).split("\n").filter((l) => l.includes("‹redacted:")).slice(0, 8).join("\n  "));
      console.error("Abstract the value, drop it, or write it to --scope project. Use --force to override.");
      process.exit(1);
    }
  }

  // Validate against the SAME budget the SessionStart reader uses
  // (persona-max-tokens × CHARS_PER_TOKEN), not the hard default — otherwise a
  // user who lowered the config passes the gate here yet still silently drops a
  // standing rule at injection time, the exact failure this gate exists to reject.
  const { getPersonaMaxTokens } = req("memory_auto_capture.js");
  const { checkPersonaBudget, CHARS_PER_TOKEN } = req("persona_projection.js");
  const maxChars = Math.max(0, Number(getPersonaMaxTokens()) || 0) * CHARS_PER_TOKEN;
  const budget = checkPersonaBudget(content.trim(), maxChars ? { maxChars } : {});
  if (!budget.ok && !force) {
    console.error("Persona rejected — it would silently drop standing rules:");
    for (const v of budget.violations) {
      if (v.kind === "tier0_overflow") {
        console.error(`  • tier-0 overflow: ${v.droppedCount} of ${v.alwaysCount} always-rules won't be delivered (budget ${v.budgetChars} chars). Compress or demote bullets to reference sections.`);
      } else if (v.kind === "bullet_over_max") {
        console.error(`  • bullet too long (${v.chars} > ${v.max} chars) in "${v.section}" line ${v.lineNo}: "${v.preview}…" — split into one rule per bullet.`);
      }
    }
    console.error("Fix the bullets, or pass --force to write anyway.");
    process.exit(1);
  }

  writePersona(targetDir, content.trim());
  const forced = force && !budget.ok ? " (budget gate forced)" : "";
  console.log(`Persona updated (${scope})${forced}.`);
}

// ── mark-done ──
function cmdMarkDone() {
  const { markConsolidated } = req("memory_auto_capture.js");
  markConsolidated();
  // Advance the per-project read cursor to the newest atom folded this run, so
  // the next `atoms --since-last` sees only what arrived after now. Best-effort:
  // a failure here must not block releasing the lock.
  try {
    const { MemoryStore } = req("memory_store.js");
    const { setConsolidatedWatermark } = req("memory_writer.js");
    const { pDir, pHash } = getDirs();
    const db = path.join(pDir, "index.db");
    if (pHash && fs.existsSync(db)) {
      const store = new MemoryStore(db);
      const maxTs = store.maxUpdatedTime();
      store.close();
      if (maxTs) setConsolidatedWatermark(pHash, maxTs);
    }
  } catch {}
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
  const { getConsolidateEvery, setConsolidateEvery, getSceneMaxTokens, setSceneMaxTokens, getPersonaMaxTokens, setPersonaMaxTokens, getNoiseGateEnabled, setNoiseGateEnabled, parseBoolish, loadConfig } = req("memory_auto_capture.js");
  const key = args[0];

  if (!key) {
    const { projectHashForCwd } = req("memory_reader.js");
    const { getRecallEnabled } = req("memory_writer.js");
    const pHash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || ".");
    console.log(JSON.stringify({
      consolidate_every: getConsolidateEvery(),
      scene_max_tokens: getSceneMaxTokens(),
      persona_max_tokens: getPersonaMaxTokens(),
      noise_gate: getNoiseGateEnabled() ? "on" : "off",
      recall: getRecallEnabled(pHash) ? "on" : "off",
      recall_project: pHash,
      stored: loadConfig(),
      env_override: {
        MEMORY_CONSOLIDATE_EVERY: process.env.MEMORY_CONSOLIDATE_EVERY || null,
        MEMORY_SCENE_MAX_TOKENS: process.env.MEMORY_SCENE_MAX_TOKENS || null,
        MEMORY_PERSONA_MAX_TOKENS: process.env.MEMORY_PERSONA_MAX_TOKENS || null,
        MEMORY_NOISE_GATE: process.env.MEMORY_NOISE_GATE || null,
      },
    }, null, 2));
    return;
  }

  if (key === "recall") {
    const { projectHashForCwd } = req("memory_reader.js");
    const { setRecallEnabled, getRecallEnabled } = req("memory_writer.js");
    const pHash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || ".");
    if (args[1] === undefined) { console.log(getRecallEnabled(pHash) ? "on" : "off"); return; }
    // The same parser `config noise-gate` goes through, not a second accept-list:
    // one `tmem config` command must not take `yes` for one key and exit 1 for
    // another.
    const enabled = parseBoolish(args[1]);
    if (enabled === null) {
      console.error("usage: tmem config recall <on|off> (also accepts 1/0, true/false, yes/no)");
      process.exit(1);
    }
    setRecallEnabled(pHash, enabled);
    console.log(`recall ${enabled ? "on" : "off"} for this project (${pHash})`);
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

  if (key === "persona-max-tokens") {
    if (args[1] === undefined) { console.log(getPersonaMaxTokens()); return; }
    try {
      const v = setPersonaMaxTokens(args[1]);
      console.log(`persona-max-tokens set to ${v}`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  // The one switch here that governs whether input is DISCARDED rather than how
  // much output is injected, so it is spelled on/off and shown in the summary
  // above: someone hunting a missing turn must be able to see it in one command.
  if (key === "noise-gate") {
    if (args[1] === undefined) { console.log(getNoiseGateEnabled() ? "on" : "off"); return; }
    try {
      const v = setNoiseGateEnabled(args[1]);
      console.log(`noise-gate ${v ? "on" : "off"} (skips are logged to changelog.jsonl as action=skipped)`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown config key: ${key}. Supported: consolidate-every, scene-max-tokens, persona-max-tokens, noise-gate, recall`);
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

// ── view ──
// The memory visualiser. This command IS the implementation surface: the skill and
// any docs shell out to `tmem view`, and scripts/view/serve.js is an internal module,
// never a second entry point. Everything below is argument handling — no metric, no
// route and no payload shape is computed here; those live in view/{extract,transform}.js.

const VIEW_USAGE = `tmem view — open the memory visualiser

Usage: tmem view [--query <q>] [--snapshot|--no-serve] [--static] [--port N] [--root <dir>]

  (no flags)        Start the live session server and print the keyed URL.
  --query <q>       Open on "Try a prompt" and trace this query.
  --snapshot        Run extract -> transform once, write the payload JSON, exit.
  --no-serve        Alias of --snapshot.
  --stdout          With --snapshot: write the payload to stdout so it can be
                    piped. The summary moves to stderr so stdout stays valid JSON.
  --static          Serve with the snapshot pinned, so numbers cannot move
                    under a reader mid-measurement.
  --port N          Listen on this port (default: an OS-assigned free port).
  --root <dir>      Read a different memory store root (default: ~/.memory-tencentdb).

The URL carries a per-session key and is required verbatim — the page renders raw
captured prompts from every project, so localhost alone is not the boundary.
Session output goes to <root>/view/, never inside a repo.`;

// Flags that take a value. Anything else beginning with `--` is a boolean.
const VIEW_VALUE_FLAGS = new Set(["query", "port", "root"]);

function parseViewArgs(argv) {
  const out = { _unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._unknown.push(a); continue; }
    const key = a.slice(2);
    if (VIEW_VALUE_FLAGS.has(key)) { out[key] = argv[i + 1]; i += 1; }
    else out[key] = true;
  }
  return out;
}

/** Human byte size; the payload is ~228 KB, so KB/MB is the only range that matters. */
function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function viewFail(msg) {
  console.error(`tmem view: ${msg}`);
  process.exit(1);
}

/**
 * How many snapshot files `<root>/view/` retains.
 *
 * Ten, because each file is ~280 KB and nothing in this system ever reads one
 * back (serve.js always recomputes live) — they exist so a human can diff two
 * states around a change or attach one to a bug report. Ten covers a full
 * debugging session with room to spare (an unpruned real store accumulated 14
 * over a single afternoon) while bounding the directory at ~2.8 MB, so an
 * unattended cron'd `--snapshot` can no longer grow without limit. Retention is
 * by mtime, not by id: ids are content-derived, so re-taking an unchanged
 * snapshot rewrites the same file and its freshness is what should count.
 */
const SNAPSHOT_KEEP = 10;

/**
 * The snapshot filename, in ONE place: the writer below composes it and the
 * pruner takes it apart. `view/` also holds events.jsonl, server-info.json and
 * lockfiles, and the pruner deletes, so only what this affix pair produces —
 * wrapped around an id the CONTRACT recognises — is ever a candidate.
 */
const SNAPSHOT_FILE_PREFIX = "snapshot-";
const SNAPSHOT_FILE_EXT = ".json";
const snapshotFileName = (id) => `${SNAPSHOT_FILE_PREFIX}${id}${SNAPSHOT_FILE_EXT}`;

/**
 * Is `name` a file this CLI wrote? The id grammar is not restated here — it is
 * `contract.isSnapshotId()`, the same predicate that validates ids everywhere
 * else. A local regex was the earlier spelling and it is the wrong shape for a
 * deleter: change the id format and a stale copy silently stops matching,
 * retention silently stops running, and the only symptom is a directory that
 * grows. Deriving it means the deleter cannot fall behind the format.
 *
 * @param {(v: string) => boolean} isSnapshotId  Injected so the pruner resolves
 *   the contract once rather than per directory entry.
 */
function isSnapshotFileName(name, isSnapshotId) {
  if (!name.startsWith(SNAPSHOT_FILE_PREFIX) || !name.endsWith(SNAPSHOT_FILE_EXT)) return false;
  return isSnapshotId(name.slice(SNAPSHOT_FILE_PREFIX.length, name.length - SNAPSHOT_FILE_EXT.length));
}

/**
 * Delete all but the newest `keep` snapshots in `dir`. Best-effort by design:
 * housekeeping must never turn a successful export into a failed command, so
 * every failure path returns/continues rather than throwing.
 *
 * Conservative on every axis: this directory only, never recursive, and
 * `isFile()` on a Dirent is lstat-based — so a directory or a symlink pointing
 * anywhere is not a candidate whatever it is named.
 *
 * @param {string} dir       The `view/` directory. Not searched recursively.
 * @param {number} keep
 * @param {string} [protect] Path that must survive regardless (the file just written).
 * @returns {string[]} Paths actually removed.
 */
function pruneSnapshots(dir, keep, protect) {
  const removed = [];
  // No contract, no candidates: a deleter that cannot check the id grammar must
  // delete nothing at all.
  let isSnapshotId;
  try { ({ isSnapshotId } = req(path.join("view", "contract.js"))); } catch { return removed; }
  if (typeof isSnapshotId !== "function") return removed;
  try {
    const protectReal = protect ? path.resolve(protect) : null;
    const files = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !isSnapshotFileName(ent.name, isSnapshotId)) continue;
      const full = path.join(dir, ent.name);
      try {
        files.push({ full, mtime: fs.statSync(full).mtimeMs });
      } catch { /* vanished or unreadable — leave it alone */ }
    }
    if (files.length <= keep) return removed;
    // Newest first; name as a tiebreaker so the order is total and deterministic.
    files.sort((a, b) => b.mtime - a.mtime || (a.full < b.full ? -1 : 1));
    for (const f of files.slice(keep)) {
      if (protectReal && path.resolve(f.full) === protectReal) continue;
      try {
        fs.unlinkSync(f.full);
        removed.push(f.full);
      } catch { /* best-effort */ }
    }
  } catch { /* unreadable dir — nothing to prune */ }
  return removed;
}

/**
 * `--snapshot` writes the payload to a FILE and prints a summary, rather than
 * dumping it to stdout. The payload measures ~228 KB / ~5 500 records: a terminal
 * dump is unreadable, and piping it would make the summary (which is the part a
 * human acts on) impossible to show at all. The filename carries the snapshotId,
 * so two exports taken around a change are self-labelling and cannot be confused —
 * which is the whole point of a pinned baseline. The path is printed, so a script
 * that wants the JSON reads it from there.
 *
 * `--stdout` exists for pipelines, and moves the summary to stderr rather than
 * dropping it: a flag whose output cannot be fed to `jq` would defeat itself. The
 * file is still written, so a piped run and a plain run leave the same artifact.
 */
// Build the SAME snapshot the visualiser serves: extract every store, transform
// to the health model. ONE definition of the extract→transform pipeline, shared
// by `doctor` and `view --snapshot`. Throws on a load/parse failure; callers map
// that to their own error style. Returns `{ root, snapshot }`.
function loadSnapshot(rootDir) {
  const { extractAll } = require(path.join(SCRIPTS_DIR, "view", "extract.js"));
  const { transformRoot } = require(path.join(SCRIPTS_DIR, "view", "transform.js"));
  if (typeof extractAll !== "function") throw new Error("scripts/view/extract.js does not export extractAll()");
  if (typeof transformRoot !== "function") throw new Error("scripts/view/transform.js does not export transformRoot()");
  const root = extractAll({ rootDir });
  return { root, snapshot: transformRoot(root) };
}

// gap.kind → the impure function that repairs it, scoped by the plan's scope.
// This is the executor half; doctor.js FIX_BY_KIND is the pure DISPLAY half
// (command string + tier). applyDoctorFixes prints `finding.fix.command` (from
// doctor.js) and runs the matching entry here, so a kind is routed in ONE table
// rather than an if/else chain. doctor.js must stay pure, so the executors live
// here. Both vector kinds share cmdSync; applyDoctorFixes dedupes by command so
// it embeds once.
const DOCTOR_FIX_RUNNERS = {
  vectors_missing:      (scope) => cmdSync(scope === "all" ? ["--all"] : []),
  vectors_unmeasurable: (scope) => cmdSync(scope === "all" ? ["--all"] : []),
  duplicate_records:    () => cmdDedup(["--atoms", "--apply"]),
  low_signal_records:   () => cmdPrune(["--low-signal", "--apply"]),
};

// ── doctor ──
//
// Builds the SAME snapshot the visualiser serves (loadSnapshot), then delegates
// to doctor.js for the gap→fix mapping and rendering. No health metric is
// computed here — this command is a front-end over buildGaps()/totals.
async function cmdDoctor(rest) {
  const args = rest || [];
  const wantJson = args.includes("--json");
  const scope = args.includes("--all") ? "all" : "current";
  const wantFix = args.includes("--fix");
  const wantApply = args.includes("--apply");

  let buildPlan, renderPlanText, snapshot;
  try {
    ({ buildPlan, renderPlanText } = req("doctor.js"));
    ({ snapshot } = loadSnapshot(path.join(os.homedir(), ".memory-tencentdb")));
  } catch (e) {
    console.error(`tmem doctor: ${e.message}`);
    process.exit(1);
  }

  let currentSlug = "";
  try { currentSlug = getDirs().pHash || ""; } catch {}

  const plan = buildPlan(snapshot, { scope, currentSlug });

  if (wantJson) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(renderPlanText(plan));

  // Upgrade nudges: activate the new memory features on existing stores (no schema
  // migration exists because none is needed — all changes are additive; the value
  // is just latent until re-consolidation). Human-only; --json keeps the machine plan.
  try {
    const { buildUpgradeNudges } = req("doctor.js");
    const { readPersona } = req("memory_writer.js");
    const { CHARS_PER_TOKEN } = req("persona_projection.js");
    const { getPersonaMaxTokens } = req("memory_auto_capture.js");
    const { gDir, pDir } = getDirs();
    const maxChars = Math.max(0, Number(getPersonaMaxTokens()) || 0) * CHARS_PER_TOKEN;
    const nudges = buildUpgradeNudges(
      { globalPersona: readPersona(gDir), projectPersona: readPersona(pDir), projectAtomCount: storeRecordCount(pDir), globalAtomCount: storeRecordCount(gDir) },
      { maxChars },
    );
    if (nudges.length) {
      console.log("\nActivate new memory features (re-consolidate to apply):");
      for (const n of nudges) console.log(`  • ${n}`);
    }
  } catch {}

  if (wantFix) {
    console.log("");
    await applyDoctorFixes(plan, { apply: wantApply });
  }
}

/**
 * Run the fixes a plan calls for. `--fix` alone runs ONLY tier=auto (idempotent,
 * additive). tier=confirm additionally needs `--apply` AND is destructive-with-
 * archive, so each is announced and run only then. tier=manual is never executed
 * — it is printed for the human/consolidator to act on. The displayed command is
 * `finding.fix.command` (doctor.js) and the executed one is DOCTOR_FIX_RUNNERS —
 * routed by the same kind, so what is shown cannot diverge from what is run.
 */
async function applyDoctorFixes(plan, { apply = false } = {}) {
  const withCount = (tier) => plan.findings.filter((f) => f.count > 0 && f.fix.tier === tier);
  const auto = withCount("auto");
  const confirm = withCount("confirm");
  const manual = withCount("manual");

  // auto: run each distinct command once (both vector kinds share one embed pass).
  const ranAuto = new Set();
  for (const f of auto) {
    const run = DOCTOR_FIX_RUNNERS[f.kind];
    if (!run || ranAuto.has(f.fix.command)) continue;
    ranAuto.add(f.fix.command);
    console.log(`→ auto: ${f.fix.command}…`);
    await run(plan.scope);
  }
  if (!ranAuto.size && !(apply && confirm.length)) {
    console.log("Nothing to auto-fix." + (confirm.length ? ` ${confirm.length} confirm-tier fix(es) need \`--fix --apply\`.` : ""));
  }

  if (confirm.length) {
    if (!apply) {
      console.log(`\n${confirm.length} confirm-tier fix(es) skipped — re-run with \`--fix --apply\` to run them (each archives before removing):`);
      for (const f of confirm) console.log(`    ${f.fix.command}`);
    } else {
      for (const f of confirm) {
        const run = DOCTOR_FIX_RUNNERS[f.kind];
        if (!run) continue;
        console.log(`→ confirm: ${f.fix.command}…`);
        await run(plan.scope);
      }
    }
  }

  if (manual.length) {
    console.log(`\n${manual.length} manual fix(es) — need your decision:`);
    for (const f of manual) console.log(`    ${f.kind}: ${f.fix.command}`);
  }
}

function cmdViewSnapshot(opts) {
  const os_ = require("node:os");
  const rootDir = opts.root ? path.resolve(opts.root) : path.join(os_.homedir(), ".memory-tencentdb");

  const t0 = process.hrtime.bigint();
  let root, snapshot;
  try {
    ({ root, snapshot } = loadSnapshot(rootDir));
  } catch (e) {
    viewFail(`snapshot failed — ${e.message}`);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const sessionDir = path.join(root && root.rootDir ? root.rootDir : rootDir, "view");
  const id = (snapshot && snapshot.snapshotId) || "unknown";
  const outPath = path.join(sessionDir, snapshotFileName(id));
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(snapshot)}\n`);
  } catch (e) {
    viewFail(`could not write ${outPath} — ${e.message}`);
  }

  const pruned = pruneSnapshots(sessionDir, SNAPSHOT_KEEP, outPath);

  const bytes = fs.statSync(outPath).size;
  const stores = Array.isArray(snapshot.stores) ? snapshot.stores.length : 0;
  const gaps = Array.isArray(snapshot.gaps) ? snapshot.gaps.length : 0;
  const totals = snapshot.totals || {};

  // With --stdout, stdout carries the payload and nothing else — a summary line
  // interleaved into it would make the JSON unparseable and the flag pointless.
  const say = opts.stdout ? console.error : console.log;
  say(`snapshot ${id}`);
  say(`  root      ${root && root.rootDir ? root.rootDir : rootDir}`);
  say(`  stores    ${stores}`);
  if (totals.records !== undefined) say(`  records   ${totals.records}`);
  if (totals.scenes !== undefined) say(`  scenes    ${totals.scenes}`);
  say(`  gaps      ${gaps}`);
  say(`  pipeline  ${ms.toFixed(1)} ms`);
  say(`  wrote     ${outPath}  (${humanBytes(bytes)})`);
  if (pruned.length) say(`  pruned    ${pruned.length} older snapshot${pruned.length === 1 ? "" : "s"} (keeping ${SNAPSHOT_KEEP})`);

  // Zero stores is a real, honest reading of an empty root — but it looks exactly
  // like a healthy system with nothing in it, and the commonest cause is a typo'd
  // --root. Name the discriminator rather than let the reader guess.
  if (stores === 0) {
    console.error(
      `\ntmem view: 0 stores under ${root && root.rootDir ? root.rootDir : rootDir} — ` +
      `that root has no global/ or projects/ store. This is an empty reading, not an error; ` +
      `check --root if you expected data.`,
    );
  }

  if (opts.stdout) process.stdout.write(`${JSON.stringify(snapshot)}\n`);
}

/**
 * Live/pinned server. serve.js is spawned rather than required so that its
 * module-level argv parsing sees a clean argv, and so a crash there cannot take
 * the CLI's error reporting with it. Its startup JSON is consumed here and the URL
 * is re-emitted with the lens parameters applied — forwarding serve's own line too
 * would print a second, less complete URL and invite the user to paste the wrong one.
 */
function cmdViewServe(opts) {
  const { spawn } = require("node:child_process");
  const serveJs = path.join(SCRIPTS_DIR, "view", "serve.js");
  if (!fs.existsSync(serveJs)) viewFail(`missing ${serveJs}`);

  const argv = [serveJs];
  if (opts.port !== undefined) argv.push("--port", String(opts.port));
  if (opts.root) argv.push("--root", opts.root);
  if (opts.static) argv.push("--static");

  const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "inherit"] });

  return new Promise((resolve) => {
    let buf = "";
    let ready = false;
    const timer = setTimeout(() => {
      if (ready) return;
      console.error("tmem view: server did not report ready within 20s — giving up.");
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      process.exit(1);
    }, 20000);

    child.stdout.on("data", (chunk) => {
      if (ready) return; // post-startup stdout is only serve's own URL banner
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let info;
        try { info = JSON.parse(line); } catch { continue; }
        if (info.type !== "server-started") continue;
        ready = true;
        clearTimeout(timer);
        child.stdout.resume(); // keep draining so the child never blocks on a full pipe
        printViewReady(info, opts);
        resolve();
        return;
      }
    });

    child.on("error", (e) => { clearTimeout(timer); viewFail(`could not start the server — ${e.message}`); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!ready) {
        console.error(`tmem view: server exited before it was ready (code ${code}).`);
        process.exit(code === 0 ? 1 : (code || 1));
      }
      process.exit(code || 0);
    });

    // Ctrl-C reaches the child through the process group, but be explicit so the
    // server is also stopped when the CLI is terminated on its own.
    const stop = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function printViewReady(info, opts) {
  const u = new URL(info.url);
  // `?view=trace` is the "Try a prompt" screen — the one a query belongs on. The
  // shell's screens are health | memories | about-you | trace; the old lens names
  // (context/signal/scenes/gaps) are gone, without aliases, on the owner's call.
  if (opts.query) { u.searchParams.set("view", "trace"); u.searchParams.set("q", opts.query); }
  if (opts.static) u.searchParams.set("static", "1");

  console.log(`tmem view — ${info.mode} mode, pid ${info.pid}, ${info.rootDir}`);
  if (info.snapshotId) console.log(`snapshot ${info.snapshotId} (${info.pipelineMs} ms)`);
  if (info.pipelineError) console.error(`tmem view: pipeline error — ${info.pipelineError}`);
  if (opts.query) console.log(`Opens on "Try a prompt", tracing: ${opts.query}`);
  console.log(`\nOpen this URL verbatim — the session key is required:\n  ${u.toString()}\n`);
  console.log(`Session dir: ${info.sessionDir}`);
  console.log(`Stop with Ctrl-C, or: kill ${info.pid}   (auto-stops after ${info.idleTimeoutMinutes}m idle)`);
}

function cmdView(rest) {
  const args = rest || [];
  if (args.includes("--help") || args.includes("-h")) { console.log(VIEW_USAGE); return; }

  const opts = parseViewArgs(args);
  for (const stray of opts._unknown) viewFail(`unexpected argument: ${stray}. Run 'tmem view --help'.`);

  // `in`, not `!== undefined`: a trailing `--query` with nothing after it parses to
  // undefined, which is exactly the case this must catch.
  if ("query" in opts && (typeof opts.query !== "string" || !opts.query.trim())) {
    viewFail("--query needs a value. Run 'tmem view --help'.");
  }
  if ("port" in opts) {
    const n = Number(opts.port);
    if (!Number.isInteger(n) || n < 0 || n > 65535) viewFail(`--port must be an integer 0-65535, got: ${opts.port}`);
    opts.port = n;
  }
  if ("root" in opts) {
    if (typeof opts.root !== "string") viewFail("--root needs a directory. Run 'tmem view --help'.");
    const abs = path.resolve(opts.root);
    // Checked here, not at first read: a store root that cannot be listed should
    // fail before a server is bound, not as a 500 on the first page load.
    let st;
    try { st = fs.statSync(abs); }
    catch (e) { viewFail(`--root ${abs} — ${e.code || e.message}`); }
    if (!st.isDirectory()) viewFail(`--root ${abs} is not a directory`);
    try { fs.accessSync(abs, fs.constants.R_OK | fs.constants.X_OK); }
    catch (e) { viewFail(`--root ${abs} is not readable — ${e.code || e.message}`); }
    opts.root = abs;
  }

  const noServe = Boolean(opts.snapshot || opts["no-serve"]);
  if (opts.stdout && !noServe) {
    viewFail("--stdout only applies to --snapshot. There is no payload to pipe from a live server.");
  }
  if (noServe) {
    // --query only opens a screen in the UI; there is no UI here.
    if (opts.query) console.error("tmem view: --query is ignored with --snapshot (it only opens a screen in the UI).");
    return cmdViewSnapshot(opts);
  }
  return cmdViewServe(opts);
}

// ── main ──
/**
 * Warn (non-fatal) if this cli.js is a different version than the plugin Claude
 * Code actually loaded ($CLAUDE_PLUGIN_ROOT). Surfaces version drift, e.g. a stale
 * `tmem` shim left pointing at an old cache dir. Best-effort; never throws.
 */
function warnIfVersionDrift() {
  try {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (!root) return;
    const own = require(path.join(__dirname, "..", "package.json")).version;
    const loaded = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")).version;
    if (own && loaded && own !== loaded) {
      console.error(`tmem: warning — running v${own} but Claude Code loaded plugin v${loaded}. Run /memory-init to re-sync the tmem command.`);
    }
  } catch { /* best-effort */ }
}

async function main() {
  warnIfVersionDrift();
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
  search <query> [--all|--project <slug>]  Search L1 atoms (FTS5); --all = every project store
  projects                   List all memory stores (slug, records, scenes) for cross-project work
  migrate-fragments [--apply]  Merge legacy cwd-keyed fragment stores into their project root (dry-run by default)
  atoms [global|project|all] [--since <iso> | --since-last]  Dump L1 atoms as JSON (--since-last = only atoms since last consolidation)
  sessions                   List pending sessions for seeding
  read-session <path>        Format session for extraction
  write-l1 [--session id]    Write L1 atoms from stdin JSON
  write-scene --name --summary --heat  Write scene block (content from stdin)
  write-persona [--scope global|project] [--force]  Write persona (global) or this repo's doctrine (project) from stdin; gate rejects budget overflow unless --force
  scene <name>               Print one full scene block (project-first, then global)
  scenes [list|dedup]        List or deduplicate scene blocks
    --dry-run                Preview dedup without removing
  changelog [--last N]       Show recent memory changes
  persona [--scope global|project] [--sections | --section <name>]  Show the global persona or this repo's project doctrine; list sections; or print one section on demand (tier 2)
  sync [--full] [--all]      Embed missing vectors (delta); --full re-embeds all; --all = every store, not just current+global
  prune --low-signal [--all] [--apply]  Remove low-signal noise records (dry-run unless --apply; archived under .pruned/)
  dedup --atoms [--all] [--apply]       Remove exact-duplicate atoms, keep newest (dry-run unless --apply; archived)
  mark-done                  Mark consolidation complete + release lock
  unlock                     Release stale consolidation lock
  config [consolidate-every [N] | scene-max-tokens [N] | persona-max-tokens [N] | noise-gate [on|off] | recall [on|off]]  Show config, or get/set a setting (noise-gate = refuse low-signal turns at capture; recall = per-project context injection)
  daemon <start|status|stop>  Manage the resident embed daemon (warm vector recall)
  view [--query <q>] [--snapshot [--stdout]] [--static] [--port N] [--root <dir>]  Open the memory visualiser (live server); --snapshot exports the payload instead (tmem view --help)
  doctor [--all] [--json] [--fix] [--apply]  Health verdict + ranked fix plan (same metrics as the visualiser); --json for an agent, --fix runs the auto-fixable set
  contrib <add|ingest|build|persona|playbook|compare|capabilities>  Contributor intelligence`);
    return;
  }

  switch (cmd) {
    case "init": return cmdInit();
    case "status": return cmdStatus();
    case "recall": return cmdRecall(restStr);
    case "search": return cmdSearch(rest);
    case "projects": return cmdProjects();
    case "migrate-fragments": return cmdMigrateFragments(rest);
    case "atoms": return cmdAtoms(rest);
    case "sessions": return cmdSessions();
    case "read-session": return cmdReadSession(restStr);
    case "write-l1": return cmdWriteL1(rest);
    case "write-scene": return cmdWriteScene(rest);
    case "write-persona": return cmdWritePersona(rest);
    case "scene": return cmdScene(restStr);
    case "scenes": return cmdScenes(rest[0], rest);
    case "changelog": return cmdChangelog(rest);
    case "persona": return cmdPersona(rest);
    case "sync": return cmdSync(rest);
    case "mark-done": return cmdMarkDone();
    case "unlock": return cmdUnlock();
    case "config": return cmdConfig(rest);
    case "daemon": return cmdDaemon(rest[0]);
    case "view": return cmdView(rest);
    case "doctor": return cmdDoctor(rest);
    case "prune": return cmdPrune(rest);
    case "dedup": return cmdDedup(rest);
    case "contrib": return cmdContrib(rest);
    default:
      console.error(`Unknown command: ${cmd}. Run 'tmem --help' for usage.`);
      process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
