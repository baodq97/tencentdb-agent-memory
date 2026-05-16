# tencentdb-agent-memory (Claude Code plugin)

A Claude Code port of [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory):
four-layer long-term memory (L0 Conversation -> L1 Atom -> L2 Scene -> L3 Persona) plus the optional
Mermaid-canvas Context Offload short-term compression.

The heavy lifting (extraction, dedup, hybrid BM25+vector recall, SQLite + sqlite-vec / TCVDB storage)
runs in the **upstream Node.js Gateway** sidecar on `127.0.0.1:8420`. This plugin is a thin HTTP
client + lifecycle manager wired into Claude Code hooks, mirroring the shape of the upstream Hermes
Python provider.

## Architecture

```
Claude Code session
  |- UserPromptSubmit hook --> POST /recall   --> inject <memory-context>
  |- Stop hook             --> POST /capture  --> fire-and-forget L0 + L1/L2/L3
  |- SessionEnd hook       --> POST /session/end
  |- Slash commands        --> POST /search/* and lifecycle
  |- Skills                --> docs for architecture, tuning, offload, troubleshooting
                         |
                         v HTTP 127.0.0.1:8420
   memory-tencentdb Gateway (Node.js sidecar - UPSTREAM, unchanged)
     L0 SQLite/JSONL > L1 LLM extract+dedup > L2 scenes (md) > L3 persona.md
     + optional Context Offload (Mermaid canvases under data dir)
```

## Prerequisites

- **Node.js >= 22.16** on PATH (`node -v`) — runs the Gateway.
- **Python >= 3.10** invokable as `python` on PATH (`python --version`) — runs the hook scripts.
  - On Windows: install from python.org (it adds `python` to PATH; the Microsoft Store `python` stub does NOT count). Alternatively `uv python install 3.12` then symlink/alias so `python` points at it.
  - On macOS/Linux: `python3` is usually present but may not be aliased as `python`. If `python --version` fails, symlink it: `ln -s "$(which python3)" /usr/local/bin/python` (or adjust the hook commands).
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
| `Stop`              | POST `/capture` -> fire-and-forget L0 + pipeline queue       |
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

## Skills (auto-trigger by topic)

- `memory-architecture` - L0-L3 pyramid, drill-down rules, Mermaid offload
- `memory-setup` - port of upstream `SKILL.md`
- `memory-recall-tuning` - `recall.*` / `pipeline.*` / `persona.*` tuning tables
- `memory-offload` - Context Offload (Mermaid canvas) setup
- `memory-troubleshooting` - circuit breaker, embedding 4-tuple, retention foot-guns

## Agent

- `memory-debugger` - walks Persona -> Scene -> Atom -> Conversation when recall is wrong

## Configuration knobs

All Gateway-side - see upstream `openclaw.plugin.json` and `skills/memory-recall-tuning/SKILL.md`.

## License

Plugin glue: MIT. Upstream engine: MIT (c) TencentDB Agent Memory Team.
