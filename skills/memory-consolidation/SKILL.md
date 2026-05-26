---
name: memory-consolidation
description: This skill should be used when extracting memories from conversation logs, running "/memory-seed", running "/memory-consolidate", processing JSONL transcripts into L1 atoms, building L2 scene blocks, generating L3 persona, or when the user asks to "extract memories", "consolidate memories", "seed memory", "build persona", "create scenes from conversations". Also triggers for SessionEnd extraction tasks and any memory extraction workflow.
---

# Memory Extraction and Consolidation

Extract structured memories from Claude Code conversation logs. The agent (this session) performs all extraction — no external LLM or paid services needed.

## Three Memory Layers

| Layer | What | Storage | Trigger |
|-------|------|---------|---------|
| L1 Atoms | Individual memory facts | `records/{date}.jsonl` + FTS5 | Auto-capture (Stop hook) + `/memory-seed` |
| L2 Scenes | Grouped narrative blocks | `scene_blocks/*.md` | Auto-consolidate (every N turns) + `/memory-consolidate` |
| L3 Persona | Synthesized user profile | `persona.md` | Auto-consolidate (every N turns) + `/memory-consolidate` |

## Auto-Consolidation Flow

The Stop hook runs two commands:
1. **Sync** (`on_stop.js`): Auto-captures each turn as an L1 atom to FTS5
2. **asyncRewake** (`memory_pipeline.js`): Runs in background, checks consolidation threshold

After N turns (default 10, configurable via `MEMORY_CONSOLIDATE_EVERY` env var), the pipeline exits with code 2 which wakes Claude with consolidation instructions. Claude then uses LLM reasoning to:
1. Read all auto-captured L1 atoms from each project's FTS5 index
2. Group them by **topic** (not just session) into L2 scene blocks
3. Synthesize persona + instruction atoms into L3 `persona.md`
4. Remove consolidated atoms from FTS5
5. Mark consolidation complete

This approach gives LLM-quality consolidation (topic analysis, narrative synthesis, deduplication) while running transparently — the user only sees activity if Claude is idle when the wake happens.

## L1 Extraction Workflow

### 1. Read Conversation

Load messages from a JSONL session file:

```bash
node -e "
const { readSession, formatMessagesForExtraction } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
const msgs = readSession('PATH_TO_JSONL', 'LAST_PROCESSED_TS');
console.log(formatMessagesForExtraction(msgs));
"
```

### 2. Extract Memories

Analyze the conversation and produce a JSON array of extracted memories. Follow the extraction rules in `references/extraction-guide.md`.

**Output format** — one JSON array per session:

```json
[
  {
    "content": "User prefers dark mode in all IDEs and terminals",
    "type": "persona",
    "priority": 80,
    "scene_name": "IDE configuration discussion",
    "source_message_ids": ["uuid-1", "uuid-2"],
    "metadata": {}
  }
]
```

### 3. Route by Scope

- **persona** + **instruction** → global storage (`~/.memory-tencentdb/global/`)
- **episodic** + project-specific instructions → project storage (`~/.memory-tencentdb/projects/{hash}/`)

### 4. Write Records

```bash
node -e "
const { writeL1Record, updateState, globalDir, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');

const records = [];  // The extracted JSON array
const projectHash = '';  // From projectHashForCwd()
const sessionId = '';

for (const rec of records) {
  const base = ['persona','instruction'].includes(rec.type) ? globalDir() : projectDir(projectHash);
  writeL1Record(base, rec);
}

updateState(sessionId, projectHash, 'completed');
"
```

## L2 Scene Generation

Group related L1 atoms by `scene_name` into narrative scene block files.

**Scene block format** (matches upstream `scene-format.ts`):

```
-----META-START-----
created: 2025-05-25T10:00:00.000Z
updated: 2025-05-25T10:00:00.000Z
summary: One-line scene description
heat: 3
-----META-END-----

## Key Facts
- Fact extracted from L1 atoms

## Decisions
- What was decided and why

## Outcomes
- What resulted from the work
```

Use `writeSceneBlock()` from `memory_writer.js`.

## L3 Persona Generation

Synthesize all persona-type and instruction-type L1 atoms into a persona document.

**Structure:**

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

Read existing persona first with `readPersona()` and merge, don't replace.

## Memory Types Reference

### persona (priority 50-100)
Stable user attributes, preferences, skills, values.
- Pattern: "User prefers/is/likes/uses..."
- High priority (80-100): Health, core traits, critical preferences
- Medium priority (50-70): General likes, skills

### episodic (priority 60-100)
Objective events, decisions, plans with timestamps.
- Pattern: "User did X on [date] at [place]"
- Include `activity_start_time`/`activity_end_time` in metadata when known
- High priority (80-100): Important decisions, milestones
- Medium priority (60-70): Routine activities

### instruction (priority 70-100 or -1)
Long-term AI behavior rules.
- Pattern: "User requires AI to always/never..."
- Priority -1: Absolute rules (strict global commands)
- High priority (90-100): Core behavior rules
- Medium priority (70-80): Important preferences

## Additional Resources

### Reference Files

For detailed extraction rules, examples, and scope classification:
- **`references/extraction-guide.md`** — Complete extraction rules, filtering criteria, output format, and worked examples

### Scripts

Available in `${CLAUDE_PLUGIN_ROOT}/scripts/`:
- **`memory_reader.js`** — Read L0 JSONL files, list projects/sessions
- **`memory_writer.js`** — Write L1/L2/L3, manage state.json
- **`memory_store.js`** — FTS5 storage engine
- **`memory_recall.js`** — Search and format recall context
