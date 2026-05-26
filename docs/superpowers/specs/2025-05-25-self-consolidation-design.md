# Self-Consolidation: Agent-Driven Memory Extraction

**Date**: 2025-05-25
**Status**: Implemented (2025-05-26)

## Problem

The TencentDB-Agent-Memory Gateway requires an external paid LLM API for L1/L2/L3 memory extraction. Without it, conversations are captured but never consolidated into searchable atoms, scenes, or persona.

## Goal

**Zero paid services.** The user's own agent (Claude Code session) performs extraction via slash commands. FTS5 keyword search replaces vector search. No external LLM or embedding service needed.

## Architecture

```
SessionEnd hook
│ (saves session metadata as "pending" to state.json)
│
/memory-seed (user-triggered, agent-driven)
│ Reads pending JSONL sessions → agent extracts L1 atoms
│ Writes records/*.jsonl + FTS5 index
│
/memory-consolidate (user-triggered, agent-driven)
│ Groups L1 atoms → L2 scene blocks (scene_blocks/*.md)
│ Synthesizes L3 persona (persona.md)
│
UserPromptSubmit hook
  Searches FTS5 → injects <memory-context> (< 300 tokens)
  Falls back from Gateway recall to local FTS5 recall
```

Key design decision: Agent hooks (`type: agent`) only have Read/Grep/Glob — no Write tool. SessionEnd is non-blocking. Therefore L1 extraction is deferred to `/memory-seed` where the agent session does the reasoning and writing.

## Storage Layout

```
~/.memory-tencentdb/
├── global/
│   ├── records/*.jsonl              (L1: persona + global instructions)
│   ├── persona.md                   (L3)
│   └── index.db                     (SQLite FTS5)
├── projects/
│   ├── {project-hash}/
│   │   ├── records/*.jsonl          (L1: episodic + project instructions)
│   │   ├── scene_blocks/*.md        (L2 with META header)
│   │   └── index.db                 (SQLite FTS5)
│   └── ...
└── state.json                       (incremental timestamps, pending sessions)
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
```

### L3 Persona (persona.md)

```markdown
# User Persona

## Identity
- Software developer, works primarily with TypeScript and Python

## Preferences
- Dark mode in all tools
- Prefers concise responses

## Standing Instructions
- Always use uv run for Python execution
```

## Components

| # | File | Purpose |
|---|------|---------|
| 1 | scripts/memory_store.js | SQLite FTS5 storage — init, upsert, search, delete, count |
| 2 | scripts/memory_reader.js | Read L0 JSONL — list projects/sessions, parse messages |
| 3 | scripts/memory_writer.js | Write L1/L2/L3 — JSONL + FTS5, scene blocks, persona, state |
| 4 | scripts/memory_recall.js | FTS5 search + format `<memory-context>` (< 300 tokens) |
| 5 | hooks/scripts/on_session_end.js | Gateway flush + save pending session to state.json |
| 6 | hooks/scripts/on_user_prompt.js | Gateway recall → local FTS5 recall fallback |
| 7 | commands/memory-seed.md | Backfill old conversations → L1 atoms |
| 8 | commands/memory-consolidate.md | Group L1 → L2 scenes + L3 persona |
| 9 | skills/memory-consolidation/SKILL.md | Extraction skill (type/priority/scope rules) |
| 10 | skills/memory-consolidation/references/extraction-guide.md | Detailed extraction format + examples |

## Memory Types

| Type | Priority | Scope | Storage |
|------|----------|-------|---------|
| persona | 50-100 | Global | global/records/ |
| instruction | 70-100 or -1 | Global (or project) | global/ or projects/{hash}/ |
| episodic | 60-100 | Project | projects/{hash}/records/ |

## Extraction Flow

1. Agent reads JSONL conversation via `memory_reader.js`
2. Agent analyzes conversation, produces JSON array of extracted memories
3. Agent classifies scope (global vs project) by memory type
4. `memory_writer.js` writes to JSONL + FTS5 index
5. `state.json` updated with session processing status

No intermediate files, no multi-agent pipeline, no paid APIs.

## Gateway Coexistence

Existing Gateway integration preserved unchanged:
- `on_user_prompt.js`: Tries Gateway recall first, falls back to local FTS5
- `on_session_end.js`: Calls Gateway `/session/end` (best-effort) + saves local metadata
- `on_stop.js`: Unchanged (Gateway capture only)
- All existing commands (`/memory-search`, `/memory-status`, etc.) work as before

## Success Criteria

1. `/memory-seed` reads conversations, extracts L1 atoms via agent reasoning
2. `/memory-consolidate` produces L2 scenes + L3 persona
3. UserPromptSubmit injects relevant memories (< 300 tokens, < 5s)
4. Global/project memory separation works
5. state.json incremental timestamps resume correctly
6. Zero API keys needed for core memory functionality
7. Existing Gateway integration unchanged
