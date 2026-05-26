---
name: memory-architecture
description: Explains the TencentDB-Agent-Memory four-layer pyramid (L0 Conversation → L1 Atom → L2 Scene → L3 Persona) and local FTS5 recall. Use when the user asks how memory is structured, what L0/L1/L2/L3 mean, where persona.md / scene blocks / index.db live, how recall works, or what gets injected into each turn.
---

# Memory architecture

Standalone local memory system for Claude Code. All extraction and consolidation is done by the Claude agent itself — no external Gateway or paid API required.

## Layered long-term memory (L0 → L3)

A semantic pyramid, narrow at the top:

| Layer | What | Storage | Purpose |
|------|------|---------|---------|
| **L0 Conversation** | Raw turns (user + assistant) | Claude Code JSONL transcripts (`~/.claude/projects/`) | Ground-truth evidence. Read-only source. |
| **L1 Atom** | Atomic facts extracted by agent | FTS5 SQLite (`index.db`) + JSONL shards | Per-fact recall; the unit returned by `/memory-search`. |
| **L2 Scene** | Aggregated themes ("Project X work", "Coding preferences") | Markdown files under `scenes/` | Mid-level grouping for coherent topics. |
| **L3 Persona** | Top-level user profile | `persona.md` | Stable user attributes, injected on every turn. |

**Drill-down rule.** Upper layers carry judgment; lower layers carry evidence. Every L3 sentence traces to L2 scenes; every L2 scene to L1 atoms; every atom to L0 messages.

## What flows into each turn

When `UserPromptSubmit` fires, the hook searches local FTS5 and injects `<memory-context>` via `additionalContext`:

- **L3 persona** (stable profile, always included — top 5 attributes)
- **L1 recalled memories** (top-K FTS5 keyword match, ranked by priority)
- Total budget: ~77/300 tokens, 74% headroom

## Extraction pipeline

Memory extraction is agent-driven, not LLM-API-driven:

1. **Auto-capture** (`Stop` hook): each turn's user text is stored as a raw capture in FTS5 for immediate recall.
2. **`/memory-seed`**: Claude agent reads past L0 transcripts and extracts structured L1 atoms (persona, episodic, instruction types).
3. **`/memory-consolidate`**: Claude agent groups L1 atoms into L2 scenes and synthesizes L3 persona.
4. **asyncRewake pipeline** (`Stop` hook): after N turns, background consolidation triggers automatically.

## Where everything lives on disk

```
~/.memory-tencentdb/
├── global/                    # Cross-project memories
│   ├── index.db               # FTS5 search index
│   ├── l1/                    # JSONL shards (YYYY-MM-DD.jsonl)
│   ├── scenes/                # L2 scene blocks (*.md)
│   └── persona.md             # L3 user profile
├── projects/
│   └── <project-hash>/        # Per-project memories
│       ├── index.db
│       ├── l1/
│       └── scenes/
├── state.json                 # Session tracking (pending/completed)
└── capture_state.json         # Auto-capture turn counter + consolidation flag
```

## Memory types

Three types with scope routing:

- **persona** (priority 50-100) → global storage. Stable user attributes, preferences, skills.
- **episodic** (priority 60-100) → project storage. Events, decisions, plans with timestamps.
- **instruction** (priority 70-100) → global storage. Long-term AI behavior rules.

## Recall strategy

Hybrid recall: local FTS5 keyword search + EmbeddingGemma-300m vector cosine similarity, merged via Reciprocal Rank Fusion (RRF, k=60).

- FTS5 searches both global and project-scoped `index.db` (keyword matching)
- sqlite-vec searches `vectors.db` using cosine distance (semantic matching)
- Results merged via RRF: items appearing in both lists get boosted scores
- Graceful degradation: if embedding not ready or sqlite-vec unavailable, falls back to FTS5-only
- Persona section always injected as safety net
- Token budget: ~280 tokens max

First run requires `/memory-reindex` to build vectors from existing memories.

## How this maps to Claude Code hooks

- **UserPromptSubmit** → hybrid recall (FTS5 + vector + RRF) → `additionalContext` with `<memory-context>` block
- **Stop** → auto-capture latest turn to FTS5 + consolidation check (asyncRewake)
- **SessionEnd** → mark session as "pending" for later `/memory-seed`

Search commands: `/memory-search <query>` (L1 FTS5) and `/memory-conversation-search <query>` (L0 transcripts).
