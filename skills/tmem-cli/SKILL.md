---
name: tmem-cli
description: Use tmem CLI for memory operations — check status, search memories, view persona, list scenes, see changelog, sync vectors, recall context. Trigger when the user asks about memory status, wants to search memories, check persona, view scenes, debug recall, or any memory-related query. Also use when you need to inspect or manage the local memory store.
---

# tmem CLI

```
tmem status                     Memory stats (records, vectors, persona, scenes)
tmem search <query>             FTS5 keyword search
tmem recall <query>             Hybrid recall (FTS5 + vector + RRF)
tmem persona                    Show persona
tmem scenes list                List scene blocks
tmem scenes dedup [--dry-run]   Remove duplicate scenes
tmem changelog [--last N]       Recent memory changes
tmem atoms [global|project|all] Dump L1 atoms as JSON
tmem sync                       Embed records missing from vector index
tmem reindex                    Rebuild entire vector index
tmem init                       Initialize memory store
tmem mark-done                  Mark consolidation complete
```
