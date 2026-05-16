---
name: memory-setup
description: End-to-end setup workflow for the tencentdb-agent-memory plugin — clone upstream, install Node deps, start the Gateway sidecar, write the Gateway config, verify recall and capture work, and run the smoke test. Use when the user says "install memory", "enable long-term memory", "configure memory-tencentdb", "set up persona", "start the memory gateway", or hits a "Gateway not available" / "no memory injection" symptom on a fresh install.
---

# Setup workflow

This is the one-shot install path. Adapted from upstream `SKILL.md`, retargeted at Claude Code.

## 1. Preflight

```bash
node -v        # need >= 22.16
python --version  # need >= 3.10
```

Upgrade either if older.

## 2. Bootstrap (one-time)

Inside Claude Code:

```
/memory-init
```

This runs `scripts/install_upstream.sh` (clone `Tencent/TencentDB-Agent-Memory` into `~/.memory-tencentdb/tdai-memory-openclaw-plugin/`, then `npm install`) and starts the Gateway sidecar. On success `/health` returns `{"status": "ok"}`.

Re-running is safe — the installer is idempotent (`git pull --ff-only` then `npm install`).

## 3. Provide LLM credentials (recommended)

L1/L2/L3 extraction needs an OpenAI-compatible LLM endpoint. Set in the shell that launches Claude Code:

```bash
export MEMORY_TENCENTDB_LLM_API_KEY="sk-..."
export MEMORY_TENCENTDB_LLM_BASE_URL="https://api.openai.com/v1"   # or any compat endpoint
export MEMORY_TENCENTDB_LLM_MODEL="gpt-4o"
```

Without these, L0 capture still works but the pipeline can't promote turns into L1 atoms / L2 scenes / L3 persona — recall will only ever surface raw L0 fragments via BM25.

## 4. Minimum Gateway config

```
/memory-config
```

It writes a default `~/.memory-tencentdb/tdai-gateway.json`. The whole field is optional — the Gateway runs with sensible defaults. The defaults already enable `recall.strategy: hybrid`, `pipeline.everyNConversations: 5`, and `persona.triggerEveryN: 50`.

## 5. Enable embedding (optional, for vector recall)

Set the four required fields under `embedding` — they must all be present or it silently falls back to keyword-only:

```json
{
  "embedding": {
    "enabled": true,
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "${EMBEDDING_API_KEY}",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

If any of `apiKey/baseUrl/model/dimensions` is missing, the embedding path is disabled at startup with a warning in the Gateway log.

## 6. Verify

```
/memory-status
```

Look for:

- `status: ok` from `/health`
- data dir created at `~/.memory-tencentdb/memory-tdai/` (or `$TDAI_DATA_DIR`)
- subdirectories `conversations/ records/ scene_blocks/` (some appear only after the first turn)
- `vectors.db` after the first turn is captured

## 7. Smoke test

1. Have a 2-3 turn conversation with Claude Code where you mention something memorable ("my preferred language is Go").
2. After each turn the `Stop` hook posts `/capture` — check `~/.memory-tencentdb/logs/gateway.stdout.log` for `[memory-tdai] [capture]` lines.
3. Start a fresh Claude Code session and ask: "what language do I prefer?". The `UserPromptSubmit` hook should inject the recalled atom and Claude should answer "Go".
4. Manual probe: `/memory-search "language"` returns the atom with a score.

## 8. Definition of Done

All of the following must hold:

- [x] `/memory-init` exits 0
- [x] `/memory-status` shows `status: ok`
- [x] `~/.memory-tencentdb/memory-tdai/` exists with subdirectories populated after the first turn
- [x] `[memory-tdai]` log lines appear in `~/.memory-tencentdb/logs/gateway.stdout.log`
- [x] `/memory-search <query>` returns at least one result after a few turns

If any of these fails, jump to the `memory-troubleshooting` skill.

## Safety

- Treat `apiKey` as secrets — keep them in env vars, never in `tdai-gateway.json` files committed to git.
- `l0l1RetentionDays = 1` or `2` requires explicit `allowAggressiveCleanup: true` — by default `0` means "never clean up".
- The plugin only modifies `~/.memory-tencentdb/` — it never touches `~/.openclaw/` or `~/.hermes/`.
