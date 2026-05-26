---
description: Consolidate L1 atoms into L2 scene blocks and L3 persona. Run after /memory-seed.
argument-hint: "[--scenes] [--persona] [--project <hash>]"
allowed-tools: Read, Glob, Grep, Bash, Agent
---

Consolidate accumulated L1 memory atoms into higher-level structures.

## How It Works

This command makes **you** (the agent) analyze L1 atoms and produce:
- **L2 Scene Blocks**: Group related memories into narrative scene files
- **L3 Persona**: Synthesize a user persona from all persona-type memories

## Steps

### 1. Load existing L1 atoms

```bash
node -e "
const { MemoryStore } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_store.js');
const { globalDir, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const { projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
const fs = require('fs');
const path = require('path');

const args = \`\$ARGUMENTS\`.trim();
let phash = '';
if (args.includes('--project')) {
  phash = args.split('--project')[1]?.trim().split(/\s+/)[0] || '';
}
if (!phash) phash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || '.');

const result = {project_hash: phash, global: [], project: []};

const gdb = path.join(globalDir(), 'index.db');
if (fs.existsSync(gdb)) {
  const store = new MemoryStore(gdb);
  result.global = store.allRecords('', 200);
  result.global_count = store.count();
  store.close();
}

const pdb = path.join(projectDir(phash), 'index.db');
if (fs.existsSync(pdb)) {
  const store = new MemoryStore(pdb);
  result.project = store.allRecords('', 200);
  result.project_count = store.count();
  store.close();
}

console.log(JSON.stringify(result, null, 2));
"
```

### 2. Generate L2 Scene Blocks (if --scenes or no flags)

Group project-scoped L1 atoms by `scene_name` and related topics. For each scene group:

```bash
node -e "
const { writeSceneBlock, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');

// AGENT: Replace with actual scene data from your analysis
const projectHash = '';  // Fill in
const sceneName = '';  // e.g. 'Plugin development session'
const summary = '';  // One-line summary
const content = '';  // Markdown body with key facts, decisions, outcomes
const heat = 1;  // 1-5, higher = more recent activity

const p = writeSceneBlock(projectDir(projectHash), sceneName, summary, content, heat);
console.log('Wrote scene:', p);
"
```

**Scene block format** (META header):
```
-----META-START-----
created: 2025-05-25T10:00:00.000Z
updated: 2025-05-25T10:00:00.000Z
summary: One-line description of the scene
heat: 3
-----META-END-----

## Key Facts
- Fact 1
- Fact 2

## Decisions
- Decision made and rationale
```

### 3. Generate L3 Persona (if --persona or no flags)

Synthesize all persona-type and instruction-type L1 atoms into a persona document:

```bash
node -e "
const { writePersona, globalDir, readPersona } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');

// AGENT: Replace with actual persona synthesis
const existing = readPersona(globalDir());
const newContent = '# User Persona\n\n## Identity\n- (synthesize)\n\n## Preferences\n- (synthesize)\n\n## Working Style\n- (synthesize)\n\n## Instructions\n- (synthesize)';

const p = writePersona(globalDir(), newContent);
console.log('Wrote persona:', p);
"
```

### 4. Update state

```bash
node -e "
const { updateState } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
updateState('consolidation', '', 'completed');
console.log('Consolidation complete');
"
```

## Guidelines

- **Scenes** should capture narrative arcs: what happened, decisions made, outcomes
- **Persona** should be a stable, evolving document — update rather than replace
- Read existing persona first and merge new insights
- Keep persona under 500 words for efficient recall injection
- Refer to the memory-consolidation skill for detailed extraction guidance
