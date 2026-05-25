# Self-Consolidation: Agent-Driven Memory Extraction

**Date**: 2025-05-25
**Status**: Approved for implementation

## Problem

The TencentDB-Agent-Memory Gateway requires an external paid LLM API (OpenAI/Anthropic) for L1/L2/L3 memory extraction. Without it, L0 conversations are captured but never consolidated into searchable atoms (L1), scene blocks (L2), or persona (L3).

## Goal

**Zero paid services.** The user's own agent (Claude Code, Codex, Copilot, etc.) performs extraction via a multi-agent pipeline (Understand-Anything style). Local embedding (embeddinggemma-300m, offline) handles vector search.

## Architecture (UA-style multi-agent pipeline)

```
/memory-consolidate (SKILL.md orchestrator)
│
├── Phase 0: PRE-FLIGHT
│   Check Gateway health, resolve data dir, read checkpoint
│
├── Phase 1: SCAN
│   Script: consolidate-reader.py
│   → Read L0 conversations, filter unprocessed
│   → Output: intermediate/scan-result.json
│
├── Phase 2: EXTRACT (parallel batches)
│   Agent: memory-extractor (×N concurrent)
│   → Each batch: ~10-20 conversation turns
│   → Output: intermediate/batch-{i}.json
│
├── Phase 3: MERGE + DEDUP
│   Script: merge-memories.py
│   → Combine batches, fuzzy dedup
│   → Output: intermediate/merged-memories.json
│
├── Phase 4: SCENES
│   Agent: scene-builder
│   → Group memories into L2 scene blocks
│   → Output: intermediate/scenes.json
│
├── Phase 5: PERSONA
│   Agent: persona-builder
│   → Generate L3 persona from scenes + memories
│   → Output: intermediate/persona.md
│
├── Phase 6: REVIEW
│   Agent: memory-reviewer
│   → Validate all extracted data
│   → Output: intermediate/review.json
│
└── Phase 7: WRITE
    Script: write-results.py
    → Write L1 to records/*.jsonl + SQLite
    → Write L2 to scene_blocks/*.md
    → Write L3 to persona.md
    → Update checkpoint
```

## Storage Strategy

Write directly to Gateway's data directory (no fork needed):
- **L1 atoms**: Append to `records/YYYY-MM-DD.jsonl` + upsert SQLite via Python `sqlite3`
- **L2 scenes**: Write `scene_blocks/*.md` with META header format
- **L3 persona**: Overwrite `persona.md`
- **Checkpoint**: Update `checkpoint.json` with last processed timestamp
- **Embedding**: Skip (Gateway's local embedding handles on next restart/reindex)

On next Gateway restart, it reloads from these files. For immediate searchability, the write script inserts into SQLite FTS5 tables directly (keyword search works instantly; vector search after Gateway reindex).

## New Files

```
tencentdb-agent-memory/
├── agents/
│   ├── memory-extractor.md         NEW - extract L1 atoms from conversation batches
│   ├── scene-builder.md            NEW - group memories into L2 scenes
│   ├── persona-builder.md          NEW - generate L3 persona
│   └── memory-reviewer.md          NEW - validate extracted data
│
├── skills/
│   └── memory-consolidation/
│       ├── SKILL.md                NEW - orchestrator (7 phases)
│       ├── merge-memories.py       NEW - merge batches + fuzzy dedup
│       └── write-results.py        NEW - write L1/L2/L3 to data dir
│
├── commands/
│   └── memory-consolidate.md       NEW - slash command → invokes skill
│
└── scripts/
    └── consolidate_reader.py       NEW - read L0 from data dir
```

## Data Formats

### L1 Atom (MemoryRecord in JSONL)

```json
{
  "id": "m_1716649200000_a1b2c3d4",
  "content": "User prefers dark mode in all IDEs",
  "type": "persona",
  "priority": 70,
  "scene_name": "IDE configuration discussion",
  "source_message_ids": ["msg_001", "msg_002"],
  "metadata": {},
  "timestamps": ["2025-05-25T10:00:00.000Z"],
  "createdAt": "2025-05-25T10:00:00.000Z",
  "updatedAt": "2025-05-25T10:00:00.000Z",
  "sessionKey": "claude-code:abc123",
  "sessionId": ""
}
```

### L2 Scene Block (scene_blocks/*.md)

```markdown
-----META-START-----
created: 2025-05-25T10:00:00.000Z
updated: 2025-05-25T10:00:00.000Z
summary: User configuring IDE preferences and development environment
heat: 3
-----META-END-----

## Key Facts
- User prefers dark mode
- Uses VS Code as primary editor
- Configured custom keybindings for navigation
```

### L3 Persona (persona.md)

```markdown
# User Persona

## Identity
- Software developer, works primarily with TypeScript and Python

## Preferences
- Dark mode in all tools
- Prefers concise responses

## Working Style
- Uses Claude Code for daily development
- Focuses on plugin development
```

## Extraction Prompt (adapted from upstream l1-extraction.ts)

The memory-extractor agent uses a prompt that produces 3 memory types:

1. **persona** (priority 50-100): Stable user attributes, preferences, skills
2. **episodic** (priority 60-100): Objective events, decisions, plans
3. **instruction** (priority 70-100, or -1): Long-term behavior rules for AI

Filtering rules:
- Skip trivial chatter, greetings, one-time tool requests
- Skip AI self-descriptions
- Merge related facts into single complete memories
- Each memory must be understandable without conversation context

## Gateway Configuration

```yaml
# ~/.memory-tencentdb/tdai-gateway.yaml
embedding:
  provider: local
extraction:
  enabled: false
```

- `embedding.provider: "local"` → embeddinggemma-300m, 768d, offline
- `extraction.enabled: false` → disable internal LLM pipeline

## Implementation Order

1. `scripts/consolidate_reader.py` - read L0 conversations
2. `agents/memory-extractor.md` - L1 extraction agent
3. `skills/memory-consolidation/merge-memories.py` - merge + dedup
4. `skills/memory-consolidation/write-results.py` - write to data dir
5. `agents/scene-builder.md` - L2 scene agent
6. `agents/persona-builder.md` - L3 persona agent
7. `agents/memory-reviewer.md` - validation agent
8. `skills/memory-consolidation/SKILL.md` - orchestrator
9. `commands/memory-consolidate.md` - slash command

## Success Criteria

1. `/memory-consolidate` reads L0, extracts, writes L1/L2/L3
2. `/memory-search <query>` returns agent-extracted atoms
3. `/memory-persona` shows agent-generated persona
4. `/memory-scenes` lists agent-created scene blocks
5. Zero API keys configured
6. Works on any agent platform (Claude Code, Codex, Copilot)
