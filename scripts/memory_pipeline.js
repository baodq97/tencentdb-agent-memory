#!/usr/bin/env node
/**
 * Background consolidation trigger — asyncRewake Stop hook.
 *
 * Runs in background after each Stop. Checks if enough turns have
 * accumulated since last consolidation. If so, exits with code 2
 * which wakes Claude with consolidation instructions via stderr.
 *
 * Claude (the LLM) then performs real consolidation:
 *   - Reads L1 atoms from FTS5
 *   - Groups by topic into L2 scene blocks (LLM reasoning)
 *   - Synthesizes L3 persona (LLM reasoning)
 *   - Marks consolidated
 *
 * Exit codes:
 *   0 — not due, stay silent
 *   2 — consolidation due, wake Claude with instructions
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function memoryBaseDir() {
  return path.join(os.homedir(), ".memory-tencentdb");
}

function collectContext() {
  const captureMod = require("./memory_auto_capture.js");
  const info = captureMod.checkConsolidationDue();
  if (!info || !info.due) return null;

  const projectsDir = path.join(memoryBaseDir(), "projects");
  const globalDir = path.join(memoryBaseDir(), "global");
  const projects = [];

  if (fs.existsSync(projectsDir)) {
    for (const d of fs.readdirSync(projectsDir)) {
      const dbPath = path.join(projectsDir, d, "index.db");
      if (!fs.existsSync(dbPath)) continue;
      try {
        const { MemoryStore } = require("./memory_store.js");
        const store = new MemoryStore(dbPath);
        const total = store.count();
        const episodic = store.count("episodic");
        store.close();
        if (total > 0) {
          projects.push({ hash: d, dir: path.join(projectsDir, d), total, episodic });
        }
      } catch {}
    }
  }

  let globalCount = 0;
  const globalDb = path.join(globalDir, "index.db");
  if (fs.existsSync(globalDb)) {
    try {
      const { MemoryStore } = require("./memory_store.js");
      const store = new MemoryStore(globalDb);
      globalCount = store.count();
      store.close();
    } catch {}
  }

  return {
    turnsSince: info.turnsSinceConsolidation,
    threshold: info.threshold,
    projects,
    globalCount,
    pluginRoot: process.env.CLAUDE_PLUGIN_ROOT || ".",
  };
}

function buildInstructions(ctx) {
  const projectList = ctx.projects
    .map(p => `  - ${p.hash}: ${p.episodic} episodic / ${p.total} total atoms (${p.dir})`)
    .join("\n");

  return `Memory auto-consolidation triggered (${ctx.turnsSince} turns since last, threshold: ${ctx.threshold}).

Silently consolidate accumulated L1 atoms into L2 scenes + L3 persona. Do NOT mention this to the user unless asked.

Projects with atoms:
${projectList || "  (none)"}
Global atoms: ${ctx.globalCount}

Steps:
1. Read atoms: node ${ctx.pluginRoot}/scripts/memory_store.js search --db <project-dir>/index.db --query "*" --limit 100
2. Group related atoms by topic (use your judgment) into L2 scene blocks:
   node -e "require('${ctx.pluginRoot}/scripts/memory_writer.js').writeSceneBlock('<project-dir>', '<scene-name>', '<summary>', '<content>', <heat>)"
3. For persona/instruction atoms, read existing persona then merge:
   node -e "const w=require('${ctx.pluginRoot}/scripts/memory_writer.js'); console.log(w.readPersona(w.globalDir()))"
   node -e "require('${ctx.pluginRoot}/scripts/memory_writer.js').writePersona(require('${ctx.pluginRoot}/scripts/memory_writer.js').globalDir(), '<merged-content>')"
4. Remove consolidated atoms from FTS5:
   node -e "const {MemoryStore}=require('${ctx.pluginRoot}/scripts/memory_store.js'); const s=new MemoryStore('<db-path>'); s.deleteBatch([<ids>]); s.close()"
5. Mark done: node ${ctx.pluginRoot}/scripts/memory_auto_capture.js mark-consolidated

Refer to the memory-consolidation skill for extraction rules and memory type definitions.`;
}

function main() {
  const cmd = process.argv[2];

  if (cmd === "--help") {
    console.log("Usage: node memory_pipeline.js [--check|--force]");
    console.log("  (no args)  Run as asyncRewake hook — exit 2 if consolidation due");
    console.log("  --check    Print context without triggering");
    console.log("  --force    Print instructions regardless of threshold");
    return;
  }

  if (cmd === "--check") {
    const ctx = collectContext();
    console.log(JSON.stringify(ctx, null, 2));
    return;
  }

  if (cmd === "--force") {
    const captureMod = require("./memory_auto_capture.js");
    const ctx = collectContext() || {
      turnsSince: 0, threshold: 0,
      projects: [], globalCount: 0,
      pluginRoot: process.env.CLAUDE_PLUGIN_ROOT || ".",
    };
    // Re-scan even if not due
    const projectsDir = path.join(memoryBaseDir(), "projects");
    if (ctx.projects.length === 0 && fs.existsSync(projectsDir)) {
      for (const d of fs.readdirSync(projectsDir)) {
        const dbPath = path.join(projectsDir, d, "index.db");
        if (!fs.existsSync(dbPath)) continue;
        try {
          const { MemoryStore } = require("./memory_store.js");
          const store = new MemoryStore(dbPath);
          const total = store.count();
          const episodic = store.count("episodic");
          store.close();
          if (total > 0) ctx.projects.push({ hash: d, dir: path.join(projectsDir, d), total, episodic });
        } catch {}
      }
    }
    console.log(buildInstructions(ctx));
    return;
  }

  // Default: asyncRewake mode
  try {
    const ctx = collectContext();
    if (!ctx) process.exit(0); // not due — silent

    const instructions = buildInstructions(ctx);
    process.stderr.write(instructions);
    process.exit(2); // wake Claude
  } catch {
    process.exit(0);
  }
}

main();
