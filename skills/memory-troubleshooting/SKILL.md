---
name: memory-troubleshooting
description: Diagnose tencentdb-agent-memory plugin failures — hooks timing out, recall returning nothing, persona.md missing, data dir not found, "node not on PATH", FTS5 index empty. Use when the user reports memory misbehaviour, `/memory-status` shows zero records, or recall doesn't inject context.
---

# Troubleshooting

A symptom → root-cause map. For each, jump to the fix and verify with `/memory-status`.

## `/memory-init` fails

1. **Node missing or too old.** `node -v` must report `>= 22`. Install Node, re-run `/memory-init`.
2. **Permission denied.** Check write access to `~/.memory-tencentdb/`. On Windows, ensure the directory isn't read-only.

## Hooks always inject empty context

**Each turn looks like recall returned nothing even though `/memory-search` finds atoms.**

1. **No memories seeded yet.** Run `/memory-seed` first to extract L1 atoms from past conversations, then `/memory-consolidate` for persona.
2. **Hook timing out.** `hooks/hooks.json` budgets are 4–8s. If FTS5 search + persona read is slower (large DB), raise the timeout.
3. **FTS5 query mismatch.** FTS5 is keyword-based. If the query shares no tokens with stored memories, it returns empty. The persona section catches some of these misses.
4. **Wrong project hash.** The hook uses `CLAUDE_PROJECT_DIR` to determine the project hash. If running from a different directory, project-scoped memories won't be found.

## `/memory-search` returns empty results

1. **No L1 atoms exist.** Run `/memory-seed` to extract from past conversations, or have a few conversations first (auto-capture stores raw turns).
2. **Auto-capture not running.** The `Stop` hook must fire after each turn. Check that `hooks/hooks.json` is loaded correctly (no plugin errors on startup).
3. **Query too broad/narrow.** FTS5 works on word tokens. Try simpler queries: `/memory-search "Go"` instead of `/memory-search "what language do I prefer"`.

## Persona never generates

1. **Haven't run `/memory-consolidate`.** Persona is generated during consolidation, not automatically on every turn.
2. **No L1 atoms of type "persona".** `/memory-seed` must extract persona-type atoms. Check: `/memory-search` for any results.
3. **asyncRewake not triggered.** The consolidation pipeline runs after N turns (configured in `capture_state.json`). For immediate persona generation, run `/memory-consolidate` manually.

## Data dir not where you expect

Default: `~/.memory-tencentdb/`

Structure:
```
~/.memory-tencentdb/
├── global/           # Cross-project (persona, instructions)
│   ├── index.db      # FTS5 index
│   ├── l1/           # JSONL shards
│   ├── scenes/       # L2 scene blocks
│   └── persona.md    # L3 persona
├── projects/<hash>/  # Per-project (episodic)
├── state.json        # Session tracking
└── capture_state.json # Auto-capture state
```

## Auto-capture not working

1. **Stop hook not firing.** Check Claude Code startup for plugin errors. The hook must be registered in `hooks/hooks.json`.
2. **`memory_auto_capture.js` missing.** Verify file exists at `scripts/memory_auto_capture.js`.
3. **No transcript path.** The Stop hook reads `payload.transcript_path` from stdin. If missing, nothing is captured.

## Token budget exceeded

Default budget: 300 tokens (~1200 chars). If injection is too large:
- Reduce `topK` in `memory_recall.js` (default 5)
- Shorten persona (keep top 5 attributes)
- The recall function auto-truncates and stops adding memories at the budget limit

## Reset everything

```bash
# Back up first
cp -r ~/.memory-tencentdb/ ~/.memory-tencentdb.bak/

# Delete and re-init
rm -rf ~/.memory-tencentdb/
/memory-init
/memory-seed
/memory-consolidate
```
