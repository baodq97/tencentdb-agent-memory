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

// 1) Shim self-heal — most important; runs regardless of detection below.
try {
  const { ensureLauncherInstalled } = require(path.join(__dirname, "..", "..", "scripts", "tmem.js"));
  ensureLauncherInstalled(); // silent on success; result intentionally unused
} catch { /* never break the session */ }

// 2) Fragmentation hint for the current project.
function fragmentHint() {
  try {
    const scriptsDir = path.join(process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..", ".."), "scripts");
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

// 3) Tier-0 persona core, once per session.
function personaCore() {
  try {
    const scriptsDir = path.join(process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..", ".."), "scripts");
    const { globalDir, readPersona } = require(path.join(scriptsDir, "memory_writer.js"));
    // CHARS_PER_TOKEN comes from the projection module rather than a local copy:
    // it is the unit the tier-0 budget is defined in, and a second declaration
    // here is exactly the drift this file's own comment used to warn about.
    const { parsePersona, annotate, projectTier0, CHARS_PER_TOKEN } =
      require(path.join(scriptsDir, "persona_projection.js"));
    const { getPersonaMaxTokens } = require(path.join(scriptsDir, "memory_auto_capture.js"));

    const text = readPersona(globalDir());
    if (!text || !String(text).trim()) return "";

    // `persona-max-tokens` governs tier 0 — one knob, so the CLI setting and the
    // projection budget cannot drift apart.
    const maxChars = Math.max(0, Number(getPersonaMaxTokens()) || 0) * CHARS_PER_TOKEN;
    const sections = annotate(parsePersona(text));
    const proj = projectTier0(sections, { maxChars });
    if (!proj || !proj.text || !proj.text.trim()) return "";

    // The index lists EVERY section, including the ones tier 0 carried nothing
    // from — those are exactly the sections (e.g. an all-reference `Environment &
    // Access`) the agent would otherwise never learn exist, which makes the tier-2
    // pointer unusable. Same lesson as `<scene-navigation>`: progressive disclosure
    // needs a cheap always-on index or the deeper tier is a promise you cannot act
    // on. Built outside the projection budget so growth truncates bullets, never
    // the index.
    const names = sections.map((s) => s.name).filter(Boolean);

    // The pointer is load-bearing: tier 2 is never injected, so without this line
    // the agent has no way to know the rest of the persona exists.
    return [
      "<persona-core>",
      "Durable facts about this user (tier-0 persona core, injected once per session — treat as standing context, not a request). Fuller detail per section on demand: `tmem persona --section <name>`.",
      names.length ? `Sections: ${names.join(", ")}.` : "",
      proj.text,
      "</persona-core>",
    ].filter(Boolean).join("\n");
  } catch { return ""; } // never break the session
}

// Both jobs share the single additionalContext channel; neither may clobber the other.
const parts = [personaCore(), fragmentHint()].filter(Boolean);
if (parts.length) {
  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n\n") } });
} else emit({});
