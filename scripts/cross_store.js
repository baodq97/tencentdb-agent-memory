"use strict";
// Cross-store awareness — the two things the per-project pipeline was blind to:
//
//  GAP-5  Blind stores. Consolidation dueness is a single GLOBAL turn counter, but
//         the consolidator only ever touches the CURRENT project. A store visited
//         briefly then left is never "current" at a due moment, so its atoms never
//         become scenes and stay unrecallable forever (measured: 19 stores, 161
//         atoms). classifyBlind names them so the pipeline can dispatch a targeted
//         consolidate — the Law-0 back-edge from the doctor's blind measurement.
//
//  Persona promotion. A durable USER fact captured mid-project lands as an episodic
//         atom in one project store; nothing lifts it to the global persona. The
//         cheapest evidence that a fact is global (not project-local) is that the
//         SAME fact recurs as episodic across ≥N different project stores.
//         groupPersonaCandidates surfaces those for a human/consolidator to gate
//         (never auto-promote: a wrong global rule pollutes every repo).
//
// Pure cores (classifyBlind, groupPersonaCandidates) are unit-tested; the fs
// wrappers (listBlindStores, findPersonaCandidates) read the real stores.

const fs = require("node:fs");
const path = require("node:path");

const SCRIPTS_DIR = __dirname;
function req(name) { return require(path.join(SCRIPTS_DIR, name)); }

// ── GAP-5: blind stores ──────────────────────────────────────────────────────

/**
 * PURE. Given per-store health descriptors, pick the stores that captured memory
 * but have no scene coverage — episodic atoms with zero scenes. Only stores with
 * a resolved real path are actionable (the consolidator targets them via
 * CLAUDE_PROJECT_DIR); a store whose path no longer resolves is likely a deleted
 * project — a prune candidate, not a consolidate one — so it is excluded.
 * @param {Array<{hash:string, episodicCount:number, sceneCount:number, realPath:string}>} stores
 * @param {{minAtoms?:number}} [opts]
 */
function classifyBlind(stores, opts = {}) {
  const minAtoms = opts.minAtoms == null ? 5 : opts.minAtoms;
  return (Array.isArray(stores) ? stores : [])
    .filter((s) => s && (s.episodicCount || 0) >= minAtoms && (s.sceneCount || 0) === 0 && s.realPath)
    .map((s) => ({ hash: s.hash, realPath: s.realPath, episodicCount: s.episodicCount }))
    .sort((a, b) => b.episodicCount - a.episodicCount);
}

/** fs wrapper: cheap per-store scan (COUNT + readdir), then classifyBlind. */
function listBlindStores(opts = {}) {
  const { MemoryStore } = req("memory_store.js");
  const { projectDir, listProjectHashes } = req("memory_writer.js");
  const { pathFromSlugProbe, projectHashForCwd } = req("memory_reader.js");
  const health = [];
  for (const hash of listProjectHashes()) {
    const dir = projectDir(hash);
    const db = path.join(dir, "index.db");
    if (!fs.existsSync(db)) continue;
    let episodicCount = 0;
    try {
      const store = new MemoryStore(db, { readOnly: true });
      episodicCount = store.count("episodic");
      store.close();
    } catch { continue; }
    if (!episodicCount) continue;
    const sb = path.join(dir, "scene_blocks");
    const sceneCount = fs.existsSync(sb) ? fs.readdirSync(sb).filter((f) => f.endsWith(".md")).length : 0;
    // Resolve the real path only for candidates (blind = no scenes) — the probe is
    // ~16 statSync calls, so don't pay it for every store, just the actionable ones.
    // The slug is a LOSSY flattening, so REQUIRE the probed path to round-trip back
    // to this exact hash before trusting it as a consolidation target — otherwise a
    // near-collision could point the consolidator at the wrong (or an empty) store.
    let realPath = "";
    if (sceneCount === 0) {
      try {
        const p = pathFromSlugProbe(hash) || "";
        if (p && projectHashForCwd(p) === hash) realPath = p;
      } catch {}
    }
    health.push({ hash, episodicCount, sceneCount, realPath });
  }
  return classifyBlind(health, opts);
}

// ── Persona promotion: cross-store recurrence ────────────────────────────────

// Normalize an atom body to a recurrence key: lowercase, strip punctuation, collapse
// whitespace. Cheap and deterministic — two atoms with the same normalized body are
// treated as "the same fact" (a SURFACE for human review, not an auto-merge).
function normKey(text) {
  return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * PURE. Group episodic atoms that recur across DISTINCT project stores. Input is a
 * map/array of {hash, content}. A group that spans ≥minProjects distinct stores is
 * a global-persona candidate: the same user-fact showed up in several projects, so
 * it is about the user, not any one repo.
 * @param {Array<{hash:string, content:string}>} atoms
 * @param {{minProjects?:number, minLen?:number}} [opts]
 * @returns {Array<{key:string, sample:string, projects:string[], count:number}>}
 */
function groupPersonaCandidates(atoms, opts = {}) {
  const minProjects = opts.minProjects == null ? 2 : opts.minProjects;
  const minLen = opts.minLen == null ? 20 : opts.minLen;
  const groups = new Map(); // key -> { key, sample, projects:Set, count }
  for (const a of Array.isArray(atoms) ? atoms : []) {
    if (!a || !a.content) continue;
    const key = normKey(a.content);
    if (key.length < minLen) continue; // too short to be a durable fact
    let g = groups.get(key);
    if (!g) { g = { key, sample: a.content, projects: new Set(), count: 0 }; groups.set(key, g); }
    g.projects.add(a.hash);
    g.count++;
  }
  return [...groups.values()]
    .filter((g) => g.projects.size >= minProjects)
    .map((g) => ({ key: g.key, sample: g.sample, projects: [...g.projects], count: g.count }))
    .sort((a, b) => b.projects.length - a.projects.length || b.count - a.count);
}

/** fs wrapper: load episodic atoms from every project store, then group. */
function findPersonaCandidates(opts = {}) {
  const { MemoryStore } = req("memory_store.js");
  const { projectDir, listProjectHashes } = req("memory_writer.js");
  const atoms = [];
  for (const hash of listProjectHashes()) {
    const db = path.join(projectDir(hash), "index.db");
    if (!fs.existsSync(db)) continue;
    try {
      const store = new MemoryStore(db, { readOnly: true });
      for (const r of store.allRecords("episodic", 100000)) atoms.push({ hash, content: r.content });
      store.close();
    } catch {}
  }
  return groupPersonaCandidates(atoms, opts);
}

module.exports = { classifyBlind, listBlindStores, groupPersonaCandidates, findPersonaCandidates, normKey };
