---
name: memory-troubleshooting
description: Diagnose tencentdb-agent-memory plugin failures — hooks timing out, recall returning nothing, persona.md missing, data dir not found, "node not on PATH", FTS5 index empty. Use when the user reports memory misbehaviour, recall doesn't inject context, or memories seem missing.
---

# Troubleshooting

A symptom → root-cause map. For each, verify the fix by checking data files directly.

## `/memory-init` fails

1. **Node missing or too old.** `node -v` must report `>= 22`. Install Node, re-run `/memory-init`.
2. **Permission denied.** Check write access to `~/.memory-tencentdb/`. On Windows, ensure the directory isn't read-only.
3. **npm dependencies missing.** Run `npm install` in the plugin directory.

## Hooks always inject empty context

**Each turn looks like recall returned nothing even though memories exist.**

1. **No memories seeded yet.** Use the memory-seed skill to extract L1 atoms from past conversations, then memory-consolidate for persona.
2. **Hook timing out.** `hooks/hooks.json` budgets are 4–8s. If FTS5 search + persona read is slower (large DB), raise the timeout.
3. **FTS5 query mismatch.** FTS5 is keyword-based. If the query shares no tokens with stored memories, it returns empty. The persona section catches some of these misses. Hybrid vector recall helps when embedding is ready.
4. **Wrong project hash.** The hook uses `CLAUDE_PROJECT_DIR` to determine the project hash. If running from a different directory, project-scoped memories won't be found.

## Memories not found

1. **No L1 atoms exist.** Use the memory-seed skill, or have a few conversations first (auto-capture stores raw turns).
2. **Auto-capture not running.** The `Stop` hook must fire after each turn. Check that `hooks/hooks.json` is loaded correctly (no plugin errors on startup).
3. **Search via script.** Debug directly: `node -e "const {MemoryStore}=require('./scripts/memory_store.js'); const s=new MemoryStore('~/.memory-tencentdb/global/index.db'); console.log(s.allRecords().length); s.close()"`

## Persona never generates

1. **Haven't run consolidation.** Persona is generated during the memory-consolidate skill, not automatically on every turn.
2. **No L1 atoms of type "persona".** The memory-seed skill must extract persona-type atoms first.
3. **asyncRewake not triggered.** The consolidation pipeline runs after N turns (configured in `capture_state.json`). For immediate persona generation, invoke the memory-consolidate skill manually.

## Data dir not where you expect

Default: `~/.memory-tencentdb/`

Structure:
```
~/.memory-tencentdb/
├── global/           # Cross-project (persona, instructions)
│   ├── index.db      # FTS5 index
│   ├── vectors.db    # sqlite-vec vector index
│   ├── l1/           # JSONL shards
│   ├── scenes/       # L2 scene blocks
│   └── persona.md    # L3 persona
├── projects/<hash>/  # Per-project (episodic)
├── models/           # EmbeddingGemma GGUF cache
├── state.json        # Session tracking
└── capture_state.json # Auto-capture state
```

## Auto-capture not working

1. **Stop hook not firing.** Check Claude Code startup for plugin errors. The hook must be registered in `hooks/hooks.json`.
2. **`memory_auto_capture.js` missing.** Verify file exists at `scripts/memory_auto_capture.js`.
3. **No transcript path.** The Stop hook reads `payload.transcript_path` from stdin. If missing, nothing is captured.

## Embedding not working

1. **Model not downloaded.** Run `/memory-init` — it downloads EmbeddingGemma on first run.
2. **node-llama-cpp not installed.** Run `npm install` in the plugin directory.
3. **sqlite-vec failed to load.** Check `vectors.db` exists. If VectorStore reports `degraded`, sqlite-vec binary may not be compatible with your platform.
4. **Recall still works without embedding.** Falls back to FTS5-only automatically.

## Token budget exceeded

Default budget: 280 tokens (~1120 chars). If injection is too large:
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
# then use memory-seed and memory-consolidate skills
```
