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
const { memoryBaseDir, globalDir, projectDir, readPersona, listScenes } = require("./memory_writer.js");
const { VectorStore, rrfMerge } = require("./vector_store.js");
const { getSceneMaxTokens } = require("./memory_auto_capture.js");
// Pure renderer + ranker, shared with view/transform.js so the block the agent
// receives and the block the visualiser measures can never be two different
// algorithms.
const { renderSceneNav, rankScenes } = require("./scene_nav.js");
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
 * scene blocks (short name + heat + summary), project group first then global,
 * each group ranked by relevance to `query` and by heat within ties. The agent
 * loads a full scene on demand via the `tmem scene <name>` CLI — names are
 * injected instead of long absolute paths to keep this always-on block
 * token-cheap.
 *
 * WHY THE QUERY IS NOW AN ARGUMENT: without it this block was byte-identical on
 * every turn of every session. With 219 scenes and an 800-char budget it showed
 * the same 78 and 141 could never appear at all, so it was pure query-independent
 * overhead — a fixed per-turn tax that no prompt could redirect. Ranking makes
 * the slice a function of the turn; see scene_nav.rankScenes for the scorer and
 * for why an empty query reproduces the previous ordering exactly.
 *
 * Ranking is per GROUP, not across the concatenation: project-before-global
 * decides who drops first under budget, which is a recall policy and not
 * something a lexical score gets to overturn.
 *
 * Has its OWN char budget (sceneMaxTokens) independent of the L1 atoms budget —
 * the caller pushes the returned block WITHOUT charging it to atoms' `used`.
 * Returns "" when disabled (sceneMaxTokens <= 0) or no scenes exist.
 */
function buildSceneNav(projectHash, query = "", sceneMaxTokens = getSceneMaxTokens()) {
  if (!sceneMaxTokens || sceneMaxTokens <= 0) return "";

  // Normalised here, at the boundary: `listScenes` yields `filename`, the block
  // prints a bare name, so the extension is stripped on the way in rather than
  // inside the shared core. Heat desc is the FALLBACK order rankScenes keeps
  // when the query says nothing about a scene.
  const group = (dir) =>
    rankScenes(
      listScenes(dir)
        .map((s) => ({
          name: (s.filename || "").replace(/\.md$/, ""),
          heat: parseInt(s.heat, 10) || 0,
          summary: s.summary || "",
        }))
        .sort((x, y) => y.heat - x.heat),
      query,
    );

  const project = projectHash ? group(projectDir(projectHash)) : [];
  const global = group(globalDir());
  const ordered = [...project, ...global]; // project first → global dropped first under budget
  if (!ordered.length) return "";

  // What stays here: the I/O and the group order. What lives in scene_nav.js:
  // the ranking, the rendering and the budgeted fill, because the view needs the
  // same arithmetic to report how many scenes the agent can actually see, and it
  // was previously a hand copy that nothing forced to stay in step.
  return renderSceneNav(ordered, sceneMaxTokens * CHARS_PER_TOKEN).text;
}

// ── Recall log ──

/**
 * Which caller asked for this recall. Not cosmetic: the automatic hook fires on
 * every prompt whether or not anyone wanted memory, while `tmem recall` /
 * `tmem search` is someone deliberately looking something up. Mixing the two
 * would make the log's hit rate meaningless.
 */
const RECALL_SOURCE = Object.freeze({ HOOK: "hook", CLI: "cli" });

/**
 * Infer the source from the entry point, so no call site has to be rewritten.
 *
 * Both existing callers pass exactly `(query, projectHash)` — `hooks/scripts/
 * on_user_prompt.js` and `cli.js:cmdRecall` — so nothing in the arguments can
 * tell them apart. They ARE distinct processes though: cli.js is spawned by the
 * `tmem` launcher (scripts/tmem.js spawns it with `spawnSync`), and the hook is
 * spawned by Claude Code. `require.main` therefore already carries the answer.
 *
 * An explicit `source` argument overrides this and is the preferred way for any
 * NEW caller to identify itself; the sniff exists so adding the log did not
 * require editing files on the hot path to get a correct first data point.
 */
function detectSource() {
  const entry = (require.main && require.main.filename) || "";
  return /(^|[\\/])cli\.js$/.test(entry) ? RECALL_SOURCE.CLI : RECALL_SOURCE.HOOK;
}

/**
 * Append-only READ log, one line per recall, at the memory root beside
 * `state.json` — root rather than per-store because a single recall reads the
 * global store AND the project store and produces one merged answer; splitting
 * it in two would misreport both.
 *
 * WHY IT EXISTS: every WRITE is logged twice (`<store>/changelog.jsonl` and
 * `records/*.jsonl`) and no READ was logged anywhere, so "which memories are
 * ever actually used" was unanswerable — ranking had no feedback term available
 * even in principle. `droppedIds` is the half that was hardest to recover after
 * the fact: candidates that ranked high enough to be considered and were then
 * silently discarded for not fitting the budget. A memory that is repeatedly
 * dropped is evidence about the budget; one that is never even a candidate is
 * evidence about the index.
 *
 * `query` is stored VERBATIM. That is not a new exposure: `records/*.jsonl`
 * already stores full prompts, and a truncated query cannot be re-run, which
 * would make the log unusable for exactly the offline evaluation it is for.
 *
 * No SQLite involved, by design — a schema change to record reads would put the
 * read path behind a write lock.
 */
const RECALL_LOG_FILE = "recall_log.jsonl";

function recallLogPath() {
  return path.join(memoryBaseDir(), RECALL_LOG_FILE);
}

/**
 * LOGGING MUST NEVER BREAK RECALL. This runs on the UserPromptSubmit hot path
 * behind an 8s hook timeout; a read-only filesystem, a full disk or a missing
 * memory root are all ordinary conditions here, and none of them is a reason to
 * return the user a turn with no context. Every failure is swallowed, including
 * the mkdir — appending to a directory that does not exist is the common case on
 * a fresh install, and it must degrade to "no log", not to "no memory".
 */
function appendRecallLog(entry) {
  try {
    const file = recallLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {}
}

/** The id a log entry refers to a memory by — same key dedupeAndRank uses. */
function memoryId(m) {
  return (m && (m.record_id || m.id)) || "";
}

/**
 * Render the ranked memories into `<memories>`, recording what fitted and what
 * did not. Shared by recall() and recallAsync() so the two paths cannot start
 * reporting different things about the same budget.
 *
 * Skip, don't break: one oversized atom used to abort every lower-ranked atom
 * behind it, leaving hundreds of chars of the pool unspent (a single 509-char
 * line could be the ONLY memory injected out of five candidates). Rank order is
 * preserved for everything that does fit.
 */
function renderMemories(memories, maxChars) {
  const lines = [];
  const injectedIds = [];
  const droppedIds = [];
  let used = 0;
  for (const m of memories) {
    const line = `- [${m.type || "?"}] ${m.content}`;
    if (used + line.length + 2 > maxChars) { droppedIds.push(memoryId(m)); continue; }
    lines.push(line);
    injectedIds.push(memoryId(m));
    used += line.length + 1;
  }
  return {
    text: lines.length ? "<memories>\n" + lines.join("\n") + "\n</memories>" : "",
    injectedIds,
    droppedIds,
  };
}

function recall(query, projectHash = "", maxTokens = DEFAULT_MAX_TOKENS, topK = 5, source = detectSource()) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts = [];

  // L3 persona, tier 1 (own budget — NOT charged to atoms' `used`, same
  // convention as the scene-nav block below). Charging it used to eat 425 of
  // the 1120-char atom pool before a single memory was considered.
  const persona = getPersona(query);
  if (persona) parts.push(`<persona>\n${persona}\n</persona>`);

  // L2 scene navigation (own budget — NOT charged to atoms' `used`)
  const sceneNav = buildSceneNav(projectHash, query);
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

  const rendered = renderMemories(memories, maxChars);
  if (rendered.text) parts.push(rendered.text);

  const context = parts.length ? "<memory-context>\n" + parts.join("\n") + "\n</memory-context>" : "";
  // Logged on EVERY path, including the empty one: a recall that returned
  // nothing is the most interesting row in the file.
  appendRecallLog({
    at: new Date().toISOString(),
    source,
    query,
    injectedIds: rendered.injectedIds,
    droppedIds: rendered.droppedIds,
    chars: context.length,
  });
  return context;
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

async function recallAsync(query, projectHash = "", maxTokens = DEFAULT_MAX_TOKENS, topK = 5, source = detectSource()) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts = [];

  // L3 persona, tier 1 (own budget — NOT charged to atoms' `used`, same
  // convention as the scene-nav block below). Charging it used to eat 425 of
  // the 1120-char atom pool before a single memory was considered.
  const persona = getPersona(query);
  if (persona) parts.push(`<persona>\n${persona}\n</persona>`);

  // L2 scene navigation (own budget — NOT charged to atoms' `used`)
  const sceneNav = buildSceneNav(projectHash, query);
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

  const rendered = renderMemories(memories, maxChars);
  if (rendered.text) parts.push(rendered.text);

  const context = parts.length ? "<memory-context>\n" + parts.join("\n") + "\n</memory-context>" : "";
  appendRecallLog({
    at: new Date().toISOString(),
    source,
    query,
    injectedIds: rendered.injectedIds,
    droppedIds: rendered.droppedIds,
    chars: context.length,
  });
  return context;
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
      parseInt(flag("--top-k") || "5"),
      // Explicit: detectSource() only recognises cli.js, and running this file
      // directly is still someone at a terminal, not the prompt hook.
      RECALL_SOURCE.CLI
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

module.exports = {
  recall, recallAsync, buildSceneNav, renderMemories,
  RECALL_SOURCE, RECALL_LOG_FILE, recallLogPath, appendRecallLog, detectSource,
};
