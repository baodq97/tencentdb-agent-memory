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
const { renderSceneNav, rankScenes, byHeatDesc } = require("./scene_nav.js");
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
 * Open an FTS MemoryStore READ-ONLY for recall, returning null (never throwing)
 * when the store cannot contribute. This is the per-store degradation gate: the
 * read path must never create schema, so three failure modes that schema-creation
 * used to mask are now real and must each degrade THIS store to "no memories" —
 * WITHOUT taking down the sibling store (a missing PROJECT store must still let
 * the GLOBAL store answer, and vice versa):
 *   - the DB file does not exist yet          → DatabaseSync throws SQLITE_CANTOPEN
 *   - the file exists but has no l1_fts table  → the probe SELECT throws "no such table"
 *   - any other open/schema surprise           → treated the same
 * The probe fires the "no such table" failure here, at open time, instead of
 * mid-search, so callers get a clean null-or-usable store.
 */
function openMemoryStoreRO(dbPath) {
  let store = null;
  try {
    store = new MemoryStore(dbPath, { readOnly: true });
    store.db.prepare("SELECT 1 FROM l1_fts LIMIT 1").get();
    return store;
  } catch {
    if (store) { try { store.close(); } catch {} }
    return null;
  }
}

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
 * every turn of a session in a given project — a fixed per-turn tax no prompt
 * could redirect. Ranking makes the slice a function of the turn; see
 * scene_nav.rankScenes for the scorer and for why an empty query reproduces the
 * previous ordering exactly.
 *
 * WHAT THIS BLOCK CONTAINS — READ THIS BEFORE QUOTING A NUMBER. One call renders
 * ONE project's scenes plus global's. It never renders the store. Verified
 * against all 52 stores: the 219 scenes people quote are spread over 19 separate
 * projects, so NO block has ever contained 219 candidates and none ever can. A
 * real block is about 5 lines: the busiest project shows 5 of its 75, the next 5
 * of 25, a third 5 of 23.
 *
 * So the store-wide "77 shown / 142 hidden" figure is a SUM over 19 independent
 * blocks with 19 independent budgets. Reading it as one block's shown-vs-hidden
 * says this function drops ~142 scenes it had in hand, which is false by two
 * orders of magnitude — it has ~5-80 in hand and drops from that. That misreading
 * has already reached a downstream metric TWICE. Any per-block claim has to be
 * measured per project, against the projectHash actually passed in.
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
  // when the query says nothing about a scene — `byHeatDesc` rather than a local
  // sort, because the view has to reproduce this order exactly for its
  // visible-scene count to be a count of THIS block.
  const group = (dir) =>
    rankScenes(
      byHeatDesc(listScenes(dir).map((s) => ({
        name: (s.filename || "").replace(/\.md$/, ""),
        heat: parseInt(s.heat, 10) || 0,
        summary: s.summary || "",
      }))),
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
 *
 * Every caller states which it is via `recall()`/`recallAsync()`'s `source`
 * argument. It defaults to HOOK because the hook is the caller that fires
 * unattended on every prompt; the two deliberate entry points (`cli.js:cmdRecall`
 * and this file's own `main()`) pass CLI explicitly.
 *
 * VIEW is the visualiser's `/api/recall` probe: a real recall, but reader-driven
 * curiosity, not the agent's own turn. It is logged so the line is honest, and
 * excluded from usage stats (extract/transform filter it) so tracing a prompt in
 * the UI never inflates a memory's measured hit rate.
 */
const RECALL_SOURCE = Object.freeze({ HOOK: "hook", CLI: "cli", VIEW: "view" });

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

/**
 * Rotate at 2 MB, keeping exactly ONE previous generation (`.jsonl.1`).
 *
 * Sized from the measured growth of a real store: 35-50 KB/day, i.e. ~15 MB/year
 * with no rotation at all, of verbatim user prompts nothing prunes. 2 MB is
 * ~40-60 days of traffic, so the generation that is kept is on its own longer
 * than any window this log is read over (ranking feedback is a weeks-scale
 * question), and the steady-state ceiling is 4 MB — current + `.1` — instead of
 * unbounded.
 *
 * ONE generation on purpose. A `.1/.2/.3` cascade renames N files per rotation
 * on the UserPromptSubmit hot path and buys history nobody has asked for; the
 * choice here is a bound, not an archive. Anyone who wants the archive can copy
 * `.1` out — it only turns over every ~6 weeks.
 */
const RECALL_LOG_MAX_BYTES = 2 * 1024 * 1024;

function recallLogPath() {
  return path.join(memoryBaseDir(), RECALL_LOG_FILE);
}

/**
 * Rename the log aside once it passes the threshold, dropping whatever `.1` held.
 *
 * Called from inside appendRecallLog's catch-all, and deliberately not defended
 * any further than that: a missing file (ENOENT from stat) is the fresh-install
 * case, and a rename that fails leaves an over-sized log that still accepts
 * appends. Both are "the log is imperfect", never "the turn has no context".
 *
 * rename() over unlink()+rename(): it replaces an existing `.1` atomically on
 * POSIX, so there is no window in which neither generation exists.
 */
function rotateRecallLogIfNeeded(file) {
  if (fs.statSync(file).size < RECALL_LOG_MAX_BYTES) return;
  fs.renameSync(file, file + ".1");
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
    // Its OWN catch: on a fresh install stat throws ENOENT, and rotation failing
    // must never cost us the append it was supposed to precede.
    try { rotateRecallLogIfNeeded(file); } catch {}
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

/**
 * Close out a recall: append the rendered atoms to `parts`, wrap the whole thing
 * in `<memory-context>`, log the read, and hand back the block.
 *
 * Shared by recall() and recallAsync() for the same reason renderMemories() is:
 * these two paths differ only in how they FIND candidates, and when the tail was
 * copy-pasted the log schema was defined twice and free to drift. One definition
 * of what a log row contains, one definition of the wrapper.
 */
function finishRecall(parts, rendered, { source, query }) {
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

function recall(query, projectHash = "", maxTokens = DEFAULT_MAX_TOKENS, topK = 5, source = RECALL_SOURCE.HOOK) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts = [];

  // L3 persona, tier 1 (own budget — NOT charged to atoms' `used`, same
  // convention as the scene-nav block below). Charging it used to eat 425 of
  // the 1120-char atom pool before a single memory was considered.
  const persona = getPersona(query, PERSONA_TIER1_MAX_CHARS, projectHash);
  if (persona) parts.push(`<persona>\n${persona}\n</persona>`);

  // L2 scene navigation (own budget — NOT charged to atoms' `used`)
  const sceneNav = buildSceneNav(projectHash, query);
  if (sceneNav) parts.push(sceneNav);

  let memories = [];
  const gDir = globalDir();
  const gDb = path.join(gDir, "index.db");
  if (fs.existsSync(gDb)) {
    const store = openMemoryStoreRO(gDb);
    if (store) {
      memories.push(...store.search(query, topK));
      store.close();
    }
  }

  if (projectHash) {
    const pDir = projectDir(projectHash);
    const pDb = path.join(pDir, "index.db");
    if (fs.existsSync(pDb)) {
      const store = openMemoryStoreRO(pDb);
      if (store) {
        memories.push(...store.search(query, topK));
        store.close();
      }
    }
  }

  memories = dedupeAndRank(memories, topK);

  return finishRecall(parts, renderMemories(memories, maxChars), { source, query });
}

/**
 * Scope context for tier-1 persona selection: `{slug, hasPath}` for the project
 * `projectHash` keys, or null when there is no project context (CLI outside a
 * repo) — persona_projection then behaves exactly as before.
 *
 * The slug is a LOSSY flattening of the project root (both `/` and a literal `-`
 * became `-`), so there is no cheap reverse mapping and no registry of project
 * names anywhere in the store. Two honest consequences:
 *   - name matching runs against the slug itself, which still contains every
 *     path segment, so a tag like "(orchard-ops)" is found without resolving anything;
 *   - path existence needs a real root, and the only reverse mapping that exists
 *     is `pathFromSlugProbe`, which walks the filesystem with backtracking
 *     (~16 statSync calls, ~0.5 ms cold). When it returns null — the directory
 *     was deleted or renamed — there is no path evidence either way, so
 *     `hasPath` answers TRUE for everything and every path-scoped bullet is
 *     kept. Keep-on-uncertainty is the whole asymmetry of this design.
 *
 * The root is resolved LAZILY, on the first `hasPath` call, and memoised. Only
 * bullets carrying a repo-relative path hint ever reach `hasPath` (8 of 85 in the
 * real persona — a name-tagged bullet is decided by the slug alone), so probing
 * eagerly spent that ~0.5 ms on every turn to answer a question most turns never
 * ask. `hasPath` memoises its own answers too: the same handful of paths is
 * probed for several bullets, and this is the per-turn hot path.
 */
function projectScopeFor(projectHash) {
  if (!projectHash) return null;

  let root; // undefined = not probed yet; null = probed, unresolvable
  const resolveRoot = () => {
    if (root === undefined) {
      try {
        const { pathFromSlugProbe } = require("./memory_reader.js");
        root = pathFromSlugProbe(projectHash) || null;
      } catch { root = null; }
    }
    return root;
  };

  const cache = new Map();
  const hasPath = (rel) => {
    // No root → "cannot tell", and cannot-tell keeps the bullet. Same answer the
    // eager version produced by OMITTING hasPath entirely (admitsProject treats a
    // missing hasPath as true), just decided here instead of at the call site.
    if (!resolveRoot()) return true;
    if (cache.has(rel)) return cache.get(rel);
    let ok = false;
    try {
      const abs = path.resolve(root, rel);
      // Containment guard: `rel` comes out of persona text, never trust it to
      // stay inside the repo even though the extractor rejects "..".
      ok = abs.startsWith(root + path.sep) && fs.existsSync(abs);
    } catch { ok = false; }
    cache.set(rel, ok);
    return ok;
  };
  return { slug: projectHash, hasPath };
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
 *
 * `projectHash` scopes the selection to the current project: persona.md is a
 * single GLOBAL document, so without it a conditional bullet written for another
 * repo is injected here as a standing rule (see persona_projection's
 * project-scope note). Empty projectHash = no project context = today's exact
 * behaviour.
 */
function getPersona(query = "", maxChars = PERSONA_TIER1_MAX_CHARS, projectHash = "") {
  const persona = readPersona(globalDir());
  if (!persona || !persona.trim()) return "";
  try {
    const sections = parsePersona(persona);
    const projection = projectTier1(sections, {
      query,
      maxChars,
      insuranceChars: DEFAULT_INSURANCE_MAX_CHARS,
      projectScope: projectScopeFor(projectHash),
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
    const rid = memoryId(m);
    if (seen.has(rid)) continue;
    seen.add(rid);
    unique.push(m);
  }
  unique.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return unique.slice(0, limit);
}

/* `truncate()` moved to scene_nav.js: the scene-nav summary cut was its only
 * caller, and the renderer that needs it now lives there. */

async function recallAsync(query, projectHash = "", maxTokens = DEFAULT_MAX_TOKENS, topK = 5, source = RECALL_SOURCE.HOOK) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts = [];

  // L3 persona, tier 1 (own budget — NOT charged to atoms' `used`, same
  // convention as the scene-nav block below). Charging it used to eat 425 of
  // the 1120-char atom pool before a single memory was considered.
  const persona = getPersona(query, PERSONA_TIER1_MAX_CHARS, projectHash);
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
    const store = openMemoryStoreRO(db);
    if (!store) continue;
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
          const vecStore = new VectorStore(vecDb, undefined, { readOnly: true });
          if (!vecStore.degraded) {
            const hits = vecStore.searchVec(queryVec, topK * 2);
            const ftsDb = path.join(dir, "index.db");
            if (fs.existsSync(ftsDb)) {
              const ftsStore = openMemoryStoreRO(ftsDb);
              if (ftsStore) {
                for (const hit of hits) {
                  const meta = ftsStore.get(hit.record_id);
                  if (meta) vecResults.push({ ...meta, distance: hit.distance });
                }
                ftsStore.close();
              }
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

  return finishRecall(parts, renderMemories(memories, maxChars), { source, query });
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
      // Running this file directly is someone at a terminal, not the prompt hook.
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

// Exported: what another file or a test actually reads. The log's own plumbing
// (recallLogPath, appendRecallLog, RECALL_LOG_FILE) stays private — it has no
// caller outside this file, and the tests assert against the log ON DISK, which
// is the contract that matters.
module.exports = {
  recall, recallAsync, buildSceneNav, renderMemories, projectScopeFor,
  RECALL_SOURCE, RECALL_LOG_MAX_BYTES,
};
