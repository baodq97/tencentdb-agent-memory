#!/usr/bin/env node
/**
 * SessionStart hook — three best-effort jobs, none of which may ever break a session:
 *
 *  1. Keep the global `tmem` shim in sync with the loaded plugin (idempotent + safe:
 *     installs when missing, refreshes a stale shim of ours, NEVER clobbers a foreign
 *     file the user owns).
 *  2. Detect legacy cwd-keyed fragment stores for the CURRENT project and surface a
 *     one-line hint so the user can consolidate them with `tmem migrate-fragments`.
 *     We deliberately DO NOT auto-merge here — that mutates the user's memory, so the
 *     destructive step stays user-triggered. Detection is cheap (slug prefix compare,
 *     no filesystem probing) and runs once per session.
 *  3. Inject the TIER-0 persona core exactly once per session. The persona is ~39k
 *     chars, far too large to carry per turn, so `persona_projection` splits it by
 *     duty class: tier 0 `always` here, tier 1 `conditional` per turn in
 *     memory_recall, tier 2 `reference` on demand. This is the only place tier 0 is
 *     paid for, which is what makes a generous (~1200 char) budget affordable.
 *     One file read + a pure parse; no DB, no network.
 */
"use strict";

const path = require("node:path");
const { emit } = require(path.join(__dirname, "_common.js"));

// Plugin scripts dir — constant per process; computed once instead of in each job.
const scriptsDir = path.join(process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..", ".."), "scripts");

// 0) Prewarm the embedding daemon, fire-and-forget. On a cold session the model
// load takes ~2s (measured), which is longer than the 1500ms per-turn embed
// timeout in memory_recall — so WITHOUT this the first query embeds null and
// recall silently falls back to keyword ranking (measured: paraphrase surfacing
// 48% cold vs 91% once warm, a 43pp hit on turn 1). embedViaDaemonStatus already
// self-revives on a `down` turn, but that starts the ~2s load AT turn 1; kicking
// it here overlaps the load with the user reading this session's context and
// typing, so the daemon answers within the timeout by the real first query.
// ensureDaemon is detached + unref'd (survives this hook's exit), non-blocking
// and never throws; a spawn failure just leaves today's cold-start behaviour.
try {
  const { ensureDaemon } = require(path.join(scriptsDir, "embed_client.js"));
  ensureDaemon(); // fire-and-forget; result intentionally unused
} catch { /* never break the session */ }

// 1) Shim self-heal — most important; runs regardless of detection below.
try {
  const { ensureLauncherInstalled } = require(path.join(__dirname, "..", "..", "scripts", "tmem.js"));
  ensureLauncherInstalled(); // silent on success; result intentionally unused
} catch { /* never break the session */ }

// 2) Fragmentation hint for the current project.
function fragmentHint() {
  try {
    const { projectHashForCwd } = require(path.join(scriptsDir, "memory_reader.js"));
    const { listProjectHashes } = require(path.join(scriptsDir, "memory_writer.js"));
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const root = projectHashForCwd(cwd);
    if (!root) return "";
    // A fragment of this project is a store whose slug extends the root slug.
    const frags = listProjectHashes().filter((h) => h !== root && h.startsWith(root + "-"));
    if (!frags.length) return "";
    return `This project has ${frags.length} legacy cwd-keyed memory fragment store(s) (created before project-root keying) whose memories won't surface in recall. Suggest the user run \`tmem migrate-fragments\` (dry-run) then \`--apply\` to consolidate them into this project's store.`;
  } catch { return ""; }
}

// 3) Tier-0 blocks, once per session. The hybrid model injects TWO independent
// tier-0 blocks — the cross-project `<persona-core>` (global store) and this
// repo's `<project-doctrine>` (project store) — each projected under its OWN
// budget, so a long project doctrine can never crowd the global persona below
// its floor (they do not share a budget). Both are computed by one helper.
function renderTier0Block(text, tag, intro) {
  try {
    if (!text || !String(text).trim()) return "";
    // CHARS_PER_TOKEN comes from the projection module rather than a local copy:
    // it is the unit the tier-0 budget is defined in, and a second declaration
    // here is exactly the drift this file's own comment used to warn about.
    const { parsePersona, annotate, projectTier0, CHARS_PER_TOKEN } =
      require(path.join(scriptsDir, "persona_projection.js"));
    const { getPersonaMaxTokens } = require(path.join(scriptsDir, "memory_auto_capture.js"));

    // `persona-max-tokens` governs tier 0 — one knob, so the CLI setting and the
    // projection budget cannot drift apart. Each block gets the full budget.
    const maxChars = Math.max(0, Number(getPersonaMaxTokens()) || 0) * CHARS_PER_TOKEN;
    const sections = annotate(parsePersona(text));
    const proj = projectTier0(sections, { maxChars });
    if (!proj || !proj.text || !proj.text.trim()) return "";

    // The index lists EVERY section, including ones tier 0 carried nothing from —
    // exactly the all-reference sections the agent would otherwise never learn
    // exist, which makes the tier-2 pointer unusable. Built outside the projection
    // budget so growth truncates bullets, never the index. The pointer is
    // load-bearing: tier 2 is never injected, so without it the agent has no way
    // to know the rest of the document exists.
    const names = sections.map((s) => s.name).filter(Boolean);
    return [
      `<${tag}>`,
      intro,
      names.length ? `Sections: ${names.join(", ")}.` : "",
      proj.text,
      `</${tag}>`,
    ].filter(Boolean).join("\n");
  } catch { return ""; } // never break the session
}

function personaCore() {
  try {
    const { globalDir, readPersona } = require(path.join(scriptsDir, "memory_writer.js"));
    return renderTier0Block(
      readPersona(globalDir()),
      "persona-core",
      "Durable facts about this user (tier-0 persona core, injected once per session — treat as standing context, not a request). Fuller detail per section on demand: `tmem persona --section <name>`.",
    );
  } catch { return ""; }
}

function projectDoctrine() {
  try {
    const { projectDir, readPersona } = require(path.join(scriptsDir, "memory_writer.js"));
    const { projectHashForCwd } = require(path.join(scriptsDir, "memory_reader.js"));
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const hash = projectHashForCwd(cwd);
    if (!hash) return "";
    return renderTier0Block(
      readPersona(projectDir(hash)),
      "project-doctrine",
      "This project's Operating Doctrine (per-project rules, SOPs, anti-patterns; injected once per session). The persona-core above is cross-project; this block is specific to THIS repo.",
    );
  } catch { return ""; }
}

// All jobs share the single additionalContext channel; none may clobber another.
// Global persona first, then this repo's doctrine, then the fragment hint.
const parts = [personaCore(), projectDoctrine(), fragmentHint()].filter(Boolean);
if (parts.length) {
  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n\n") } });
} else emit({});
