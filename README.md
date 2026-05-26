# tencentdb-agent-memory (Claude Code plugin)

Four-layer long-term memory (L0 Conversation → L1 Atom → L2 Scene → L3 Persona) for Claude Code, inspired by [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory).

Fully local — no external Gateway, no paid API, no Python. All extraction and consolidation is done by the Claude agent itself.

## Architecture

```
Claude Code session
  ├─ UserPromptSubmit hook → hybrid recall (FTS5 + vector RRF) → inject <memory-context>
  ├─ Stop hook (sync)      → auto-capture turn to local FTS5
  ├─ Stop hook (asyncRewake) → background consolidation trigger (L1→L2→L3)
  └─ SessionEnd hook       → mark session as pending for later seeding

Local storage (~/.memory-tencentdb/):
  global/    index.db (FTS5) + vectors.db (sqlite-vec) + persona.md + scenes/
  projects/  {hash}/index.db + vectors.db + scenes/
  models/    embeddinggemma-300m (downloaded on first /memory-init)
```

## Prerequisites

- **Node.js >= 22** (`node -v`)
- **npm** (for installing node-llama-cpp + sqlite-vec)

## Quick start

```bash
# Launch Claude Code with plugin
claude --plugin-dir /path/to/tencentdb-agent-memory

# Inside Claude Code — 3 steps:
/memory-init           # Create dirs, FTS5/vector indexes, download embedding model
# then use memory-seed skill to extract memories from past conversations
# then use memory-consolidate skill to build scenes + persona
```

## What happens automatically

| Claude Code event   | Action |
|---------------------|--------|
| `UserPromptSubmit`  | Hybrid recall (FTS5 keyword + vector cosine + RRF merge) → inject `<memory-context>` |
| `Stop`              | Auto-capture turn to FTS5 + vector; trigger consolidation after N turns |
| `SessionEnd`        | Mark session as pending for later seeding |

Hooks never block the conversation — all failures degrade gracefully to no injection.

## Components

### Command

- `/memory-init` — initialize local memory store + vector index

### Skills (agent-driven, trigger by context)

- `memory-seed` — extract L1 atoms from conversation history
- `memory-consolidate` — build L2 scenes + L3 persona from atoms
- `memory-architecture` — reference: L0→L3 pyramid, recall strategy, data layout
- `memory-troubleshooting` — diagnose recall failures, missing memories, hook issues

### Agent

- `memory-debugger` — trace wrong/missing recall through the L0→L3 chain

## Tech stack

- **FTS5** — keyword search via `node:sqlite` (built-in)
- **sqlite-vec** — vector cosine search (npm dependency)
- **EmbeddingGemma-300m** — local embedding via `node-llama-cpp` (npm dependency, ~80MB model)
- **RRF** (k=60) — merges FTS5 + vector results

## License

Plugin: MIT. Upstream inspiration: MIT (c) TencentDB Agent Memory Team.
