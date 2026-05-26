---
name: memory-seed
description: Extract L1 memory atoms from Claude Code conversation history. Triggers when the user says "seed memories", "extract memories", "backfill memory", "memory seed", or when the asyncRewake pipeline needs to process pending sessions. Also use after /memory-init to populate the memory store from past conversations.
---

# Memory Seeding

Read conversation transcripts from `~/.claude/projects/` and extract structured L1 memory atoms. You (the agent) perform all extraction — no external LLM needed.

## When to use

- After `/memory-init` on a project with conversation history
- When the user asks to "seed", "extract", or "backfill" memories
- When asyncRewake pipeline flags pending sessions

## Workflow

### 1. Find pending sessions

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js sessions
```

### 2. Read each session

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js read-session SESSION_FILE_PATH
```

### 3. Extract memories

Read the conversation and extract L1 atoms. See `references/extraction-guide.md` for detailed rules, types, priority scoring, and examples.

**Output format** — produce a JSON array:
```json
[
  {
    "content": "User prefers dark mode in all IDEs",
    "type": "persona",
    "priority": 80,
    "scene_name": "IDE configuration",
    "source_message_ids": ["msg-id-1"],
    "metadata": {}
  }
]
```

**Three types:**
- **persona** → global storage (stable user attributes)
- **episodic** → project storage (events, decisions)
- **instruction** → global storage (AI behavior rules)

### 4. Write atoms

Pipe the JSON array to stdin:

```bash
echo 'JSON_ARRAY' | node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js write-l1 --session SESSION_ID
```

### 5. Verify

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js status
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js changelog --last 10
```

After seeding, tell the user: **Next: use the memory-consolidate skill** to group atoms into scenes and synthesize persona.
