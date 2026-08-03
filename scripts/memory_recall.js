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
const { globalDir, projectDir, readPersona, listScenes } = require("./memory_writer.js");
const { VectorStore, rrfMerge } = require("./vector_store.js");
const { getSceneMaxTokens } = require("./memory_auto_capture.js");
// Pure renderer, shared with view/transform.js so the block the agent receives and
// the block the visualiser measures can never be two different algorithms.
const { renderSceneNav } = require("./scene_nav.js");
const {
  parsePersona,
  projectTier1,
  legacyProjection,
  DEFAULT_TIER1_MAX_CHARS,
  DEFAULT_INSURANCE_MAX_CHARS,
  CHARS_PER_TOKEN,
} = require("./persona_projection.js");

const DEFAULT_MAX_TOKENS = 280;

/**
 * Per-turn persona budget (chars), OWN pool — see getPersona().
 *
 * Deliberately not `getPersonaMaxTokens()`: that (1200 tok ≈ 4800 chars) is the
 * tier-0 budget, paid once per session by the SessionStart hook. Tier 1 is paid
 * on EVERY turn, so it is sized for what a turn actually needs — an insurance
 * line plus the conditional bullets this prompt triggers.
 */
const PERSONA_TIER1_MAX_CHARS = DEFAULT_TIER1_MAX_CHARS;

/* `heatEmoji()` and the summary `truncate()` used by the scene-nav block now live
 * in scene_nav.js alongside the renderer that uses them — see buildSceneNav(). */

/**
 * Build the L2 scene-navigation block (progressive disclosure): an index of
 * scene blocks (short name + heat + summary) sorted project-first then global,
 * each group by heat desc. The agent loads a full scene on demand via the
 * `tmem scene <name>` CLI — names are injected instead of long absolute paths
 * to keep this always-on block token-cheap.
 *
 * Has its OWN char budget (sceneMaxTokens) independent of the L1 atoms budget —
 * the caller pushes the returned block WITHOUT charging it to atoms' `used`.
 * Returns "" when disabled (sceneMaxTokens <= 0) or no scenes exist.
 */
function buildSceneNav(projectHash, sceneMaxTokens = getSceneMaxTokens()) {
  if (!sceneMaxTokens || sceneMaxTokens <= 0) return "";
  const byHeat = (arr) => arr.slice().sort((x, y) => (parseInt(y.heat, 10) || 0) - (parseInt(x.heat, 10) || 0));
  const project = projectHash ? byHeat(listScenes(projectDir(projectHash))) : [];
  const global = byHeat(listScenes(globalDir()));
  const ordered = [...project, ...global]; // project first → global dropped first under budget
  if (!ordered.length) return "";

  // What stays here: the I/O, and the project-before-global order (a recall
  // policy — it decides who drops first under budget). What moved to
  // scene_nav.js: the rendering and the budgeted fill, because the view needs the
  // same arithmetic to report how many scenes the agent can actually see, and it
  // was previously a hand copy that nothing forced to stay in step.
  //
  // Normalised here, at the boundary: `listScenes` yields `filename`, the block
  // prints a bare name, so the extension is stripped on the way in rather than
  // inside the shared core.
  return renderSceneNav(
    ordered.map((s) => ({
      name: (s.filename || "").replace(/\.md$/, ""),
      heat: s.heat,
      summary: s.summary || "",
    })),
    sceneMaxTokens * CHARS_PER_TOKEN,
  ).text;
}

function recall(query, projectHash = "", maxTokens = DEFAULT_MAX_TOKENS, topK = 5) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts = [];
  let used = 0;

  // L3 persona, tier 1 (own budget — NOT charged to atoms' `used`, same
  // convention as the scene-nav block below). Charging it used to eat 425 of
  // the 1120-char atom pool before a single memory was considered.
  const persona = getPersona(query);
  if (persona) parts.push(`<persona>\n${persona}\n</persona>`);

  // L2 scene navigation (own budget — NOT charged to atoms' `used`)
  const sceneNav = buildSceneNav(projectHash);
  if (sceneNav) parts.push(sceneNav);

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
      // Skip, don't break: one oversized atom used to abort every lower-ranked
      // atom behind it, leaving hundreds of chars of the pool unspent (a single
      // 509-char line could be the ONLY memory injected out of five candidates).
      // Rank order is preserved for everything that does fit.
      if (used + line.length + 2 > maxChars) continue;
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

/**
 * Tier-1 (per-turn) persona slice for `query`.
 *
 * Was: the first 5 non-heading lines cut at 400 chars — ~1% of a 39k-char
 * persona, all of it `## Identity`, byte-identical on every turn, while the
 * sections that actually govern behaviour got nothing. Now the projection is
 * delegated to persona_projection.projectTier1: a small always-on insurance
 * line (cover in case compaction dropped the tier-0 session preamble) plus the
 * `conditional` bullets this prompt actually reaches for, so the block varies
 * with the turn instead of re-billing the same 400 chars forever.
 *
 * Pure + sync (one file read, no I/O beyond it) so `recall()` stays sync and
 * the hot path stays inside the 8s hook timeout.
 *
 * Falls back to `legacyProjection` — today's exact output — whenever the tiered
 * projection comes back empty (unparseable persona, nothing classified as
 * always/conditional): never emit nothing where we used to emit something.
 */
function getPersona(query = "", maxChars = PERSONA_TIER1_MAX_CHARS) {
  const persona = readPersona(globalDir());
  if (!persona || !persona.trim()) return "";
  try {
    const sections = parsePersona(persona);
    const projection = projectTier1(sections, {
      query,
      maxChars,
      insuranceChars: DEFAULT_INSURANCE_MAX_CHARS,
    });
    if (projection.text.trim()) return projection.text;
  } catch {
    // A malformed persona must degrade, not throw: recall is a hook.
  }
  return legacyProjection(persona);
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

/* `truncate()` moved to scene_nav.js: the scene-nav summary cut was its only
 * caller, and the renderer that needs it now lives there. */

async function recallAsync(query, projectHash = "", maxTokens = DEFAULT_MAX_TOKENS, topK = 5) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts = [];
  let used = 0;

  // L3 persona, tier 1 (own budget — NOT charged to atoms' `used`, same
  // convention as the scene-nav block below). Charging it used to eat 425 of
  // the 1120-char atom pool before a single memory was considered.
  const persona = getPersona(query);
  if (persona) parts.push(`<persona>\n${persona}\n</persona>`);

  // L2 scene navigation (own budget — NOT charged to atoms' `used`)
  const sceneNav = buildSceneNav(projectHash);
  if (sceneNav) parts.push(sceneNav);

  const dirs = [globalDir()];
  if (projectHash) dirs.push(projectDir(projectHash));

  let ftsResults = [];
  for (const dir of dirs) {
    const db = path.join(dir, "index.db");
    if (!fs.existsSync(db)) continue;
    const store = new MemoryStore(db);
    ftsResults.push(...store.search(query, topK * 2));
    store.close();
  }

  let vecResults = [];
  try {
    const { embedViaDaemon } = require("./embed_client.js");
    const queryVec = await embedViaDaemon(query);
    {
      if (queryVec) {
        for (const dir of dirs) {
          const vecDb = path.join(dir, "vectors.db");
          if (!fs.existsSync(vecDb)) continue;
          const vecStore = new VectorStore(vecDb);
          if (!vecStore.degraded) {
            const hits = vecStore.searchVec(queryVec, topK * 2);
            const ftsDb = path.join(dir, "index.db");
            if (fs.existsSync(ftsDb)) {
              const ftsStore = new MemoryStore(ftsDb);
              for (const hit of hits) {
                const meta = ftsStore.get(hit.record_id);
                if (meta) vecResults.push({ ...meta, distance: hit.distance });
              }
              ftsStore.close();
            }
          }
          vecStore.close();
        }
      }
    }
  } catch {}

  let memories;
  if (vecResults.length > 0 && ftsResults.length > 0) {
    memories = rrfMerge(
      [ftsResults, vecResults],
      r => r.record_id
    ).slice(0, topK);
  } else {
    memories = dedupeAndRank([...ftsResults, ...vecResults], topK);
  }

  if (memories.length) {
    const memLines = [];
    for (const m of memories) {
      const line = `- [${m.type || "?"}] ${m.content}`;
      // Skip, don't break: one oversized atom used to abort every lower-ranked
      // atom behind it, leaving hundreds of chars of the pool unspent (a single
      // 509-char line could be the ONLY memory injected out of five candidates).
      // Rank order is preserved for everything that does fit.
      if (used + line.length + 2 > maxChars) continue;
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

module.exports = { recall, recallAsync };
