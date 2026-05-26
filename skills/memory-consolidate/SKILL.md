---
name: memory-consolidate
description: Consolidate L1 memory atoms into L2 scene blocks and L3 persona. Triggers when the user says "consolidate memories", "build persona", "update persona", "create scenes", or after /memory-seed completes. Also triggers automatically via the asyncRewake pipeline after N conversation turns.
---

# Memory Consolidation

Analyze L1 atoms and produce higher-level structures. You (the agent) perform all reasoning — no external LLM needed.

## When to use

- After `/memory-seed` extracts L1 atoms
- When asyncRewake pipeline triggers consolidation
- When user asks to "consolidate", "build persona", or "update scenes"

## Workflow

### 1. Load existing L1 atoms

```bash
node -e "
const { MemoryStore } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_store.js');
const { globalDir, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const { projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
const fs = require('node:fs');
const path = require('node:path');
const pHash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || '.');
const result = { project_hash: pHash };
for (const [label, dir] of [['global', globalDir()], ['project', projectDir(pHash)]]) {
  const db = path.join(dir, 'index.db');
  if (!fs.existsSync(db)) { result[label] = []; continue; }
  const store = new MemoryStore(db);
  result[label] = store.allRecords('', 500);
  store.close();
}
console.log(JSON.stringify(result, null, 2));
"
```

### 2. Generate L2 scene blocks

Group project-scoped atoms by topic into narrative scenes. Each scene captures a coherent work arc.

```bash
node -e "
const { writeSceneBlock, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const p = writeSceneBlock(projectDir('PROJECT_HASH'), 'Scene Name', 'One-line summary', 'MARKDOWN_CONTENT', HEAT);
console.log('Wrote scene:', p);
"
```

**Scene guidelines:**
- Group by topic, not by session
- Include key facts, decisions made, and outcomes
- Heat: 1-5 (higher = more recent activity)

### 3. Generate L3 persona

Synthesize persona-type and instruction-type atoms into a stable user profile. Read existing persona first and merge — don't replace.

```bash
node -e "
const { writePersona, globalDir, readPersona } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const existing = readPersona(globalDir());
console.log('Existing persona:', existing || '(none)');
"
```

After analyzing atoms and existing persona, write the updated version:

```bash
node -e "
const { writePersona, globalDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
writePersona(globalDir(), PERSONA_CONTENT);
console.log('Persona updated');
"
```

**Persona structure:**
```markdown
# User Persona

## Identity
- Role, background, expertise

## Preferences
- Tools, styles, communication preferences

## Working Style
- Patterns, habits, workflow characteristics

## Standing Instructions
- Long-term rules for AI behavior
```

Keep persona under 500 words for efficient recall injection.

### 4. Mark complete

```bash
node -e "
const { updateState } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
updateState('consolidation', '', 'completed');
console.log('Consolidation complete');
"
```

After consolidation, tell the user: **Memory pipeline complete.** Hybrid recall (FTS5 + vector) is now active for future sessions.
