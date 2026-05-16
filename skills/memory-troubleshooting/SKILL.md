---
name: memory-troubleshooting
description: Diagnose tencentdb-agent-memory plugin failures — Gateway not starting, hooks timing out, recall returning nothing, embedding silently disabled, capture backlog, circuit breaker tripping, persona.md missing, data dir not found, "node not on PATH". Use when the user reports memory misbehaviour, sees `[memory-tdai]` error logs, hits "circuit breaker tripped", or `/memory-status` shows status != ok.
---

# Troubleshooting

A symptom → root-cause map. For each, jump to the fix and verify with `/memory-status`.

## Gateway won't start

**`/memory-init` exits non-zero or `/memory-status` shows `health.status: down`.**

1. **Node missing or too old.** `node -v` must report `>= 22.16`. Install Node, re-run `/memory-init`.
2. **Upstream not cloned.** `ls ~/.memory-tencentdb/tdai-memory-openclaw-plugin/.git` — if missing, `bash $CLAUDE_PLUGIN_ROOT/scripts/install_upstream.sh`.
3. **Port in use.** `MEMORY_TENCENTDB_GATEWAY_PORT` defaults to `8420`. If something else binds it: either kill that process or `export MEMORY_TENCENTDB_GATEWAY_PORT=8421` and re-init.
4. **Crash on startup.** Tail the supervised log: `tail -100 ~/.memory-tencentdb/logs/gateway.stderr.log` — common causes: missing `tsx`, corrupt `node_modules` (re-run `npm install` in the upstream dir).

## Hooks always inject empty context

**Each turn looks like recall returned nothing even though `/memory-search` finds atoms.**

1. **Circuit breaker open.** Check `~/.memory-tencentdb/breaker.json` — if `open_until` is in the future, 5+ consecutive Gateway errors tripped it. Fix the underlying Gateway issue and reset with `rm ~/.memory-tencentdb/breaker.json`.
2. **Hook timing out.** `hooks/hooks.json` budgets are 4–6s. If `/recall` is slower, the hook bails. Either speed up recall (`embedding.recallTimeoutMs: 3000`, `recall.maxResults: 3`) or raise the timeout in `hooks.json`.
3. **Recall response shape mismatch.** Upstream sometimes returns `prependContext` vs `context`. The hook checks both; if neither is non-empty, nothing is injected. `curl -s http://127.0.0.1:8420/recall -d '{"query":"X","session_key":"s"}' -H content-type:application/json` to see the raw response.

## `/memory-search` returns empty results

1. **L1 hasn't fired.** Default `pipeline.everyNConversations: 5`. After 5 turns you should see L1 atoms. Lower it to 2 for fast feedback.
2. **L0 capture not running.** Tail `~/.memory-tencentdb/logs/gateway.stdout.log` — expect `[memory-tdai] [capture]` lines after each `Stop`. If absent, the Stop hook isn't running — verify with: `cat ~/.memory-tencentdb/last_hook.log` (the hooks can be debugged by adding `import logging; logging.basicConfig(filename="/tmp/hook.log")`).
3. **`enableDedup` collapses everything.** Set `extraction.enableDedup: false` temporarily to see if dedup is over-eager.

## Embedding silently disabled

**Log shows `[embedding] disabled — incomplete config` even though `enabled: true`.**

All four of `provider`, `baseUrl`, `apiKey`, `model`, `dimensions` must be present and non-empty. The Gateway disables the path on any missing field rather than throwing. Cross-check against `dimensions` of your chosen model — `text-embedding-3-small` is 1536, not 3072.

If you set `provider: qclaw`, `proxyUrl` is also required.

## Persona never generates

1. `persona.triggerEveryN: 50` — that's a lot of new L1 atoms. Drop to 10 while testing.
2. Confirm L1 is firing (see above). No L1 → no persona.
3. Check `~/.memory-tencentdb/logs/gateway.stdout.log` for `[persona]` lines. If you see "model unavailable", supply `MEMORY_TENCENTDB_LLM_API_KEY` and restart.

## Capture backlog warnings

Log line: `capture backlog: 4 in-flight`.

The Gateway is slower than the conversation rate. Usually means an LLM call (L1 extraction) is blocking. Options:

- Reduce `extraction.maxMemoriesPerSession` to 10
- Raise `llm.timeoutMs` so calls don't pile up retrying
- Switch `extraction.model` to a faster model
- Skip noisy agents via `capture.excludeAgents: ["bench-judge-*"]`

## Data dir not where you expect

Resolution order (Gateway-side):

1. `TDAI_DATA_DIR` env var (absolute path)
2. `data.baseDir` in `tdai-gateway.json`
3. Default: `~/.memory-tencentdb/memory-tdai/` (override parent with `MEMORY_TENCENTDB_ROOT`)
4. Legacy: `~/memory-tdai/` if it exists (deprecated)

Set `TDAI_DATA_DIR` in the shell that launches Claude Code if you want a custom location.

## "Aggressive cleanup not allowed"

You set `capture.l0l1RetentionDays: 1` (or `2`) without `capture.allowAggressiveCleanup: true`. Either accept a longer retention (`3+`) or explicitly opt in:

```json
"capture": { "l0l1RetentionDays": 1, "allowAggressiveCleanup": true, "cleanTime": "03:00" }
```

## Reset everything

Nuclear option, after backing up `~/.memory-tencentdb/memory-tdai/`:

```bash
/memory-stop
rm -rf ~/.memory-tencentdb/breaker.json ~/.memory-tencentdb/gateway.pid
# data dir kept intact at ~/.memory-tencentdb/memory-tdai/
/memory-init
```
