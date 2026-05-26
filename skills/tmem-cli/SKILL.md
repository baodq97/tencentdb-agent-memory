---
name: tmem-cli
description: Use tmem CLI to inspect and manage the local memory store — check record counts, search for specific memories, view persona, list scenes, see what changed recently, sync vectors. Trigger when the user asks "how many memories do I have", "show my persona", "what scenes exist", "search memories for X", "recent memory changes", or when you need to check memory state before or after an operation. Do NOT use for extracting or consolidating memories — those have dedicated skills.
---

# tmem CLI

The plugin provides a `tmem` command-line tool for memory inspection and management. Use these commands via Bash.

## Read / Inspect

| Command | When to use |
|---------|-------------|
| `tmem status` | Overview: record counts, vector counts, persona, scenes, capture state |
| `tmem search <query>` | Find specific memories by keyword (FTS5) |
| `tmem recall <query>` | Full hybrid recall — same as what hooks inject each turn |
| `tmem persona` | Read current persona document |
| `tmem scenes list` | List all scene blocks with metadata (heat, updated, summary) |
| `tmem changelog --last N` | See the N most recent memory writes (default 20) |
| `tmem atoms [global\|project\|all]` | Dump raw L1 atoms as JSON — use sparingly, output can be large |

## Write / Manage

| Command | When to use |
|---------|-------------|
| `echo JSON \| tmem write-l1 --session ID` | Write extracted L1 atoms (used by memory-seed skill) |
| `echo CONTENT \| tmem write-scene --name N --summary S --heat H` | Write/update a scene block (used by memory-consolidate skill) |
| `echo CONTENT \| tmem write-persona` | Write persona (used by memory-consolidate skill) |
| `tmem scenes dedup [--dry-run]` | Find and remove duplicate scenes by keyword overlap |
| `tmem sync` | Embed records missing from vector index (delta only) |
| `tmem reindex` | Rebuild entire vector index from scratch |
| `tmem mark-done` | Mark consolidation complete + release lock |
| `tmem init` | Initialize memory store (normally via /memory-init command) |

## Fallback

If `tmem` is not on PATH, use the full path:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js <command>
```
