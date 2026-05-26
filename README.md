# tencentdb-agent-memory (Claude Code plugin)

A Claude Code port of [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory):
four-layer long-term memory (L0 Conversation -> L1 Atom -> L2 Scene -> L3 Persona) plus the optional
Mermaid-canvas Context Offload short-term compression.

Works in two modes:

1. **Standalone** (zero dependencies): Local FTS5 storage + auto-capture + agent-driven consolidation.
   No Gateway, no paid LLM API, no Python needed.
2. **With Gateway** (optional): Full upstream pipeline with hybrid BM25+vector recall, LLM extraction,
   and SQLite + sqlite-vec storage via the Node.js sidecar on `127.0.0.1:8420`.

## Architecture

```
Claude Code session
  |- UserPromptSubmit hook --> Gateway /recall OR local FTS5 --> inject <memory-context>
  |- Stop hook (sync)      --> Gateway /capture + auto-capture to local FTS5
  |- Stop hook (asyncRewake) --> background consolidation trigger (L1→L2→L3)
  |- SessionEnd hook       --> POST /session/end
  |- Slash commands        --> /memory-seed, /memory-consolidate, /memory-search, ...
  |- Skills                --> architecture, consolidation, tuning, offload, troubleshooting

Local storage (~/.memory-tencentdb/):
  global/   {records/*.jsonl, index.db (FTS5), persona.md}
  projects/ {hash/records/*.jsonl, hash/index.db, hash/scene_blocks/*.md}

Optional upstream Gateway (127.0.0.1:8420):
  L0 SQLite/JSONL > L1 LLM extract+dedup > L2 scenes > L3 persona
  + hybrid BM25+vector recall + Context Offload (Mermaid canvases)
```

## Prerequisites

- **Node.js >= 22.16** on PATH (`node -v`) — runs the Gateway and all hook scripts.
- **Bash** to run `/memory-init` and the search slash-commands (Git Bash, WSL, or the bundled bash in Claude Code's shell on Windows).

## Install (one-time)

1. Add this plugin to Claude Code (marketplace install or copy to `~/.claude/plugins/`).
2. Inside Claude Code, run `/memory-init`. It will:
   - clone `Tencent/TencentDB-Agent-Memory` into `~/.memory-tencentdb/tdai-memory-openclaw-plugin/`
   - run `npm install` once
   - launch the Gateway and wait for `/health = ok`
3. (Optional) provide LLM credentials for L1/L2/L3 extraction:
   ```bash
   export MEMORY_TENCENTDB_LLM_API_KEY="sk-..."
   export MEMORY_TENCENTDB_LLM_BASE_URL="https://api.openai.com/v1"
   export MEMORY_TENCENTDB_LLM_MODEL="gpt-4o"
   ```

## What is wired up automatically

| Claude Code event   | Action                                                       |
|---------------------|--------------------------------------------------------------|
| `UserPromptSubmit`  | POST `/recall` -> injects `<memory-context>` into the prompt |
| `Stop`              | POST `/capture` + auto-capture to local FTS5 + asyncRewake consolidation trigger |
| `SessionEnd`        | POST `/session/end` -> flush pending pipeline work           |

On Gateway down or slow, hooks bail out in under 5 seconds and the conversation continues
uninterrupted - no errors surface to the user.

## Slash commands

- `/memory-init` - clone upstream, npm install, start Gateway
- `/memory-status` - Gateway `/health`, data-dir tree
- `/memory-search <query>` - search L1 structured memories
- `/memory-conversation-search <query>` - search L0 raw conversations
- `/memory-persona` - show current `persona.md`
- `/memory-scenes` - list L2 scene blocks
- `/memory-config` - open the Gateway config
- `/memory-stop` - stop the Gateway sidecar
- `/memory-seed` - backfill memory from old conversation logs
- `/memory-consolidate` - consolidate L1 atoms into L2 scenes + L3 persona
- `/memory-eval` - run the automated evaluation suite
- `/memory-capture-status` - show auto-capture turn count and consolidation status

## Skills (auto-trigger by topic)

- `memory-architecture` - L0-L3 pyramid, drill-down rules, Mermaid offload
- `memory-setup` - port of upstream `SKILL.md`
- `memory-recall-tuning` - `recall.*` / `pipeline.*` / `persona.*` tuning tables
- `memory-offload` - Context Offload (Mermaid canvas) setup
- `memory-consolidation` - L1 extraction rules, L2 scene building, L3 persona synthesis
- `memory-troubleshooting` - circuit breaker, embedding 4-tuple, retention foot-guns

## Agents

- `memory-debugger` - walks Persona -> Scene -> Atom -> Conversation when recall is wrong
- `memory-eval` - subagent for real scenario testing (invoked by `/memory-eval`)

## Configuration knobs

All Gateway-side - see upstream `openclaw.plugin.json` and `skills/memory-recall-tuning/SKILL.md`.

## License

Plugin glue: MIT. Upstream engine: MIT (c) TencentDB Agent Memory Team.
