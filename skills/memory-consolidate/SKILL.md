---
name: memory-consolidate
description: Consolidate L1 memory atoms into L2 scene blocks and L3 persona. Triggers when the user says "consolidate memories", "build persona", "update persona", "create scenes", or after /memory-seed completes. Also triggers automatically via the asyncRewake pipeline after N conversation turns.
---

# Memory Consolidation

Analyze L1 atoms and produce higher-level structures. You (the agent) perform all reasoning — no external LLM needed.

## When to use

- After memory-seed skill extracts L1 atoms
- When asyncRewake pipeline triggers consolidation
- When user asks to "consolidate", "build persona", or "update scenes"

## Workflow

### 1. Check current state

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js status
```

### 2. List existing scenes (for dedup)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js scenes list
```

### 3. Load L1 atoms

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

### 4. Generate L2 scene blocks

Group project-scoped atoms by topic. **Reuse existing scene names** when the topic matches — this updates the file instead of creating a duplicate.

```bash
node -e "
const { writeSceneBlock, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
writeSceneBlock(projectDir('PROJECT_HASH'), 'Scene Name', 'One-line summary', 'MARKDOWN_CONTENT', HEAT);
"
```

**Scene guidelines:**
- Group by topic, not by session
- Reuse existing scene names from step 2 when topic matches
- Include key facts, decisions made, and outcomes
- Heat: 1-5 (higher = more recent activity)

### 5. Generate L3 persona

Read existing persona, then merge new insights:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js persona
```

Write updated persona:

```bash
node -e "
const { writePersona, globalDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
writePersona(globalDir(), PERSONA_CONTENT);
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

Keep under 500 words.

### 6. Mark complete

```bash
node -e "require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_auto_capture.js').markConsolidated()"
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js unlock
```

After consolidation, tell the user: **Memory pipeline complete.** Hybrid recall is now active.
