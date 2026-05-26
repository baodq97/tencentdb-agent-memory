# Local Embedding with EmbeddingGemma-300m

Date: 2026-05-26
Status: Approved

## Goal

Add local vector embedding to the plugin using EmbeddingGemma-300m (via node-llama-cpp) + sqlite-vec, enabling hybrid recall (FTS5 keyword + vector cosine similarity merged via RRF). Zero external API calls. Fully offline.

## Architecture

### New files

**`scripts/embedding_service.js`** — Local embedding service
- EmbeddingGemma-300m GGUF model (768 dimensions, ~80MB)
- Background warmup: model downloads on first use, loads async
- State machine: idle → initializing → ready | failed
- `embed(text)` → Float32Array(768), L2-normalized
- `embedBatch(texts)` → Float32Array[] 
- Input truncation at 512 chars (model has 256-token context)
- Singleton pattern: one global instance, warmed up on first hook call

**`scripts/vector_store.js`** — sqlite-vec vector storage
- Loads `sqlite-vec` extension into `node:sqlite`
- Creates `l1_vec` virtual table: `vec0(record_id TEXT PK, embedding float[768] distance_metric=cosine)`
- `upsertVec(recordId, embedding)` — delete+insert (vec0 doesn't support ON CONFLICT)
- `searchVec(queryEmbedding, topK)` → [{record_id, distance}]
- `rrfMerge(ftsResults, vecResults, k=60)` → merged ranked list
- Graceful degradation: if sqlite-vec fails to load, returns empty results
- Uses separate `vectors.db` file (same pattern as upstream)

### Modified files

**`scripts/memory_recall.js`** — Hybrid recall
- When embedding ready: run FTS5 + vector in parallel, merge via RRF
- When embedding not ready: FTS5-only (current behavior, unchanged)
- Same token budget (280 tokens), same `<memory-context>` output format

**`scripts/memory_store.js`** — Embed on upsert
- After FTS5 upsert, also embed content and store in vectors.db
- Best-effort: if embedding not ready, skip silently (vector populated later via reindex)

**`hooks/scripts/on_user_prompt.js`** — Trigger warmup
- Call `embeddingService.startWarmup()` on first hook invocation
- Non-blocking, returns immediately

## Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `node-llama-cpp` | GGUF model runtime, auto-downloads model | ~50MB installed + ~80MB model on first run |
| `sqlite-vec` | sqlite-vec extension for `node:sqlite` | ~2MB (native binary per platform) |

Both installed via `npm install` in the plugin directory. No global installs.

## Data layout

```
~/.memory-tencentdb/
├── global/
│   ├── index.db        # FTS5 (existing)
│   └── vectors.db      # NEW: sqlite-vec vector index
├── projects/<hash>/
│   ├── index.db        # FTS5 (existing)
│   └── vectors.db      # NEW: sqlite-vec vector index
└── models/             # NEW: node-llama-cpp model cache
    └── embeddinggemma-300m-qat-Q8_0.gguf
```

## Hybrid recall algorithm

```
query → embed(query) → queryVec

FTS5 path:  toFtsQuery(query) → search l1_fts → ftsResults (ranked by BM25)
Vector path: searchVec(queryVec, topK*2) → vecResults (ranked by cosine distance)

Merge: rrfMerge([ftsResults, vecResults], k=60)
  - score(item) = sum over lists of 1/(k + rank + 1)
  - items in both lists get scores summed
  - sort by descending RRF score
  - take topK
```

## Graceful degradation

| State | Behavior |
|-------|----------|
| Embedding ready + sqlite-vec loaded | Full hybrid recall (FTS5 + vector + RRF) |
| Embedding loading | FTS5-only (current behavior) |
| Embedding failed | FTS5-only + log warning |
| sqlite-vec load failed | FTS5-only (MemoryStore works as before) |
| No vectors.db yet | FTS5-only until first embed completes |

## Reindex command

Add `/memory-reindex` command that:
1. Reads all records from `index.db`
2. Embeds each content string
3. Upserts into `vectors.db`
4. Reports progress

This is needed after first install (existing memories have no vectors) or after model change.

## What we don't port

- No L0 vector search (L0 is Claude Code JSONL, read-only)
- No remote embedding providers (local-only by design)
- No BM25 sparse vectors (FTS5 covers keyword path)
- No embedding metadata tracking for auto-reindex (manual `/memory-reindex` is sufficient)

## Success criteria

1. `node scripts/embedding_service.js --test` embeds a sample text and prints 768-dim vector
2. `node scripts/vector_store.js --test` creates vec0 table, upserts, searches
3. Hybrid recall benchmark: top-1 recall >= 80% (up from 70% FTS5-only)
4. Hook latency: UserPromptSubmit still under 8s budget
5. 87/87 existing tests still pass + new embedding tests pass
