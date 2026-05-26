# tencentdb-agent-memory (Claude Code plugin)

Four-layer long-term memory (L0 Conversation → L1 Atom → L2 Scene → L3 Persona) for Claude Code, inspired by [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory).

Fully local — no external Gateway, no paid API, no Python. All extraction and consolidation is done by the Claude agent itself.

## Quick start

```bash
claude --plugin-dir /path/to/tencentdb-agent-memory

# Inside Claude Code:
/memory-init
# → installs deps, links tmem CLI, creates store
# → hints: "ask me to seed memories"
# then say "seed memories" → agent extracts L1 atoms
# then say "consolidate memories" → agent builds scenes + persona
# done — hybrid recall is now active automatically
```

## What happens automatically

| Hook | Action |
|------|--------|
| `UserPromptSubmit` | Hybrid recall (FTS5 + vector + RRF) → inject `<memory-context>` |
| `Stop` | Auto-capture turn + background consolidation after N turns |
| `SessionEnd` | Mark session as pending for later seeding |

Hooks never block — failures degrade to no injection.

## Components

| Type | Name | Purpose |
|------|------|---------|
| Command | `/memory-init` | Install deps, link tmem CLI, init store |
| Skill | `memory-seed` | Agent extracts L1 atoms from conversation history |
| Skill | `memory-consolidate` | Agent builds L2 scenes + L3 persona |
| Skill | `tmem-cli` | CLI reference for memory inspection/management |
| Agent | `memory-consolidator` | Background worker dispatched by asyncRewake |

## tmem CLI

Installed automatically by `/memory-init`. Available in terminal and used by skills.

```
tmem status                     Memory stats
tmem search <query>             FTS5 keyword search
tmem recall <query>             Hybrid recall (FTS5 + vector + RRF)
tmem persona                    Show persona
tmem scenes list                List scene blocks
tmem scenes dedup [--dry-run]   Remove duplicate scenes
tmem changelog [--last N]       Recent memory changes
tmem sync                       Embed records missing from vector index
tmem atoms [global|project|all] Dump L1 atoms as JSON
tmem sessions                   List pending sessions
tmem reindex                    Rebuild entire vector index
tmem init                       Initialize memory store
tmem mark-done                  Mark consolidation complete
```

## Architecture

```
~/.memory-tencentdb/
├── global/           index.db (FTS5) + vectors.db (sqlite-vec) + persona.md + scenes/
├── projects/{hash}/  index.db + vectors.db + scenes/
└── models/           embeddinggemma-300m (~80MB, downloaded on first init)
```

## Tech stack

- **FTS5** — keyword search via `node:sqlite` (built-in)
- **sqlite-vec** — vector cosine search (npm)
- **EmbeddingGemma-300m** — local embedding via `node-llama-cpp` (npm, ~80MB model)
- **RRF** (k=60) — merges FTS5 + vector results

## License

Plugin: MIT. Upstream inspiration: MIT (c) TencentDB Agent Memory Team.
