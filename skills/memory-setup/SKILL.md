---
name: memory-setup
description: End-to-end setup workflow for the tencentdb-agent-memory plugin — initialize local FTS5 store, seed memories from past conversations, consolidate into scenes and persona. Use when the user says "install memory", "enable long-term memory", "configure memory-tencentdb", "set up persona", or hits "no memory injection" on a fresh install.
---

# Setup workflow

Standalone local memory — no external Gateway, no paid API keys required. Claude agent handles all extraction and consolidation.

## 1. Preflight

```bash
node -v        # need >= 22
```

Upgrade if older. Python is **not** required — all scripts are Node.js using built-in modules only.

## 2. Initialize (one-time)

Inside Claude Code:

```
/memory-init
```

This creates the local FTS5 database and directory structure at `~/.memory-tencentdb/`. Safe to re-run.

## 3. Seed memories from past conversations

```
/memory-seed
```

This reads your Claude Code conversation history (`~/.claude/projects/`) and uses the agent to extract L1 memory atoms. No external LLM needed — Claude itself does the extraction.

Options:
- `/memory-seed` — current project only
- `/memory-seed --all` — all projects
- `/memory-seed --project <hash>` — specific project

## 3.5. Build vector index (first time only)

```
/memory-reindex
```

Downloads the EmbeddingGemma-300m model (~80MB) on first run, then embeds all existing L1 atoms into `vectors.db` for hybrid recall. Subsequent upserts embed automatically.

## 4. Consolidate (L2 scenes + L3 persona)

```
/memory-consolidate
```

Groups L1 atoms into L2 scene blocks and synthesizes an L3 persona summary. This is also triggered automatically by the asyncRewake Stop hook after N turns.

## 5. Verify

```
/memory-status
```

Look for:
- Record counts in global and project stores
- Persona: N lines (not "none")
- Scenes: at least one `.md` file

## 6. Smoke test

1. Have a 2-3 turn conversation mentioning something memorable ("my preferred language is Go").
2. The `Stop` hook auto-captures each turn to local FTS5.
3. Start a fresh Claude Code session and ask: "what language do I prefer?". The `UserPromptSubmit` hook injects recalled memories and Claude should answer "Go".
4. Manual probe: `/memory-search "language"` returns matching atoms.

## 7. Definition of Done

- [x] `/memory-init` exits 0
- [x] `/memory-status` shows record counts > 0
- [x] `~/.memory-tencentdb/global/` and `~/.memory-tencentdb/projects/` exist
- [x] `/memory-search <query>` returns results after seeding or a few turns
- [x] Persona file exists after `/memory-consolidate`

If any fails, jump to the `memory-troubleshooting` skill.

## How it works

- **UserPromptSubmit hook** → local FTS5 recall → inject `<memory-context>` via `additionalContext`
- **Stop hook** → auto-capture latest turn to FTS5 + trigger consolidation check
- **SessionEnd hook** → mark session as "pending" for later `/memory-seed`
- **asyncRewake pipeline** → background L1→L2→L3 consolidation after N turns

## Safety

- The plugin only modifies `~/.memory-tencentdb/` — no other directories touched.
- All data stays local. No external API calls.
- Token budget: ~77/300 tokens max injected per turn, 74% headroom.
