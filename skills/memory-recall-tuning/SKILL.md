---
name: memory-recall-tuning
description: Tune the tencentdb-agent-memory Gateway when recall is too noisy, too sparse, slow, or stuck. Covers recall.maxResults, recall.scoreThreshold, recall.strategy, pipeline.everyNConversations, persona.triggerEveryN, extraction.maxMemoriesPerSession, and the BM25 / embedding / hybrid trade-offs. Use when the user says "memory recall is wrong / off-topic / missing", "too many memories injected", "persona never updates", or wants to make L1/L2/L3 fire more or less often.
---

# Recall tuning

All knobs live in `~/.memory-tencentdb/tdai-gateway.json` (or the equivalent OpenClaw / Hermes config). The Gateway hot-reloads most of them — restart it only when changing `storeBackend` or `embedding.*`.

## Level 1 — daily tuning (covers ~90% of cases)

| Field | Default | What it does | When to change |
|------|---------|--------------|-----------------|
| `recall.strategy` | `"hybrid"` | `keyword` (BM25) / `embedding` / `hybrid` (RRF merge) | Pure-text precision → `keyword`; semantic-heavy → `embedding`; default keeps both |
| `recall.maxResults` | `5` | top-K L1 atoms injected | Inject 3 if context budget is tight; 10 for research-heavy long sessions |
| `recall.scoreThreshold` | `0.3` | floor on RRF / cosine score | Raise to 0.4–0.5 if injection feels noisy; lower to 0.2 if recall is sparse |
| `pipeline.everyNConversations` | `5` | L1 batch fires every N turns | 3 for fast feedback while testing; 10–15 for long deep-work sessions |
| `extraction.maxMemoriesPerSession` | `20` | cap on L1 atoms per pass | Raise for fact-dense sessions; lower if dedup keeps colliding |
| `persona.triggerEveryN` | `50` | persona regenerated every N new L1 atoms | 20 while bootstrapping a new user; 100 for stable users |

## Level 2 — long-session / latency tuning

| Field | Default | What it does |
|------|---------|---------------|
| `pipeline.enableWarmup` | `true` | New session: L1 fires at turn 1, doubling (1→2→4→…→everyN). Disable for purely batch behaviour. |
| `pipeline.l1IdleTimeoutSeconds` | `600` | After this much idle, force an L1 pass even if everyN not reached |
| `pipeline.l2MinIntervalSeconds` | `900` | Floor between L2 scene-extraction passes in one session |
| `pipeline.l2MaxIntervalSeconds` | `3600` | Ceiling between L2 passes |
| `recall.timeoutMs` | `5000` | Recall budget per turn; on timeout the hook skips injection (never blocks the user) |
| `extraction.enableDedup` | `true` | Vector-based L1 dedup. Disable if you see too many "(conflict)" entries |
| `capture.excludeAgents` | `[]` | Glob patterns to skip capture for noisy agents (e.g. `bench-judge-*`) |
| `capture.l0l1RetentionDays` | `0` | `0` never cleans up; 7–30 for long-lived hosts. Setting to 1–2 needs `allowAggressiveCleanup: true` |

## Level 3 — embeddings, custom LLMs, remote backends

Embedding is **all-or-nothing**: provide `provider`, `baseUrl`, `apiKey`, `model`, `dimensions` together or it silently disables.

```json
"embedding": {
  "enabled": true,
  "provider": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "${EMBEDDING_API_KEY}",
  "model": "text-embedding-3-small",
  "dimensions": 1536,
  "recallTimeoutMs": 3000,      // user-facing, keep tight
  "captureTimeoutMs": 15000     // background, can be loose
}
```

To bypass the host LLM entirely (use any OpenAI-compatible endpoint for L1/L2/L3):

```json
"llm": {
  "enabled": true,
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "${LLM_API_KEY}",
  "model": "gpt-4o",
  "maxTokens": 4096,
  "timeoutMs": 120000
}
```

## Diagnosis flow

1. **Nothing recalls.** Run `/memory-search <some word from earlier turn>`. If empty: L1 hasn't fired yet — drop `pipeline.everyNConversations` or wait for the warm-up schedule.
2. **Recall returns junk / off-topic atoms.** Raise `recall.scoreThreshold`. If still bad and `recall.strategy: hybrid`, check the embedding 4-tuple — a broken embedding provider poisons the RRF merge.
3. **Persona never updates.** Lower `persona.triggerEveryN`. Check `~/.memory-tencentdb/memory-tdai/persona.md` mtime and the Gateway log for `[memory-tdai] [persona]`.
4. **Recall too slow.** Lower `recall.timeoutMs` and `embedding.recallTimeoutMs` to 2-3s. The hook skips injection on timeout, conversation continues.
5. **`vectors.db` not growing.** Embedding is off (`provider: none` or missing 4-tuple). Keyword-only is fine but `hybrid` is now equivalent to `keyword`.

## Source of truth

For every field, type, and constraint, see upstream `openclaw.plugin.json` — that file is the schema the Gateway parses.
