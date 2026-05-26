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
node -e "
const { readState } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const { listSessions, projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
const state = readState();
const processed = new Set(Object.keys(state.sessions || {}));
const pHash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || '.');
const sessions = listSessions(pHash).filter(s => !processed.has(s.sessionId));
console.log(JSON.stringify({ project: pHash, pending: sessions.length, sessions: sessions.slice(0, 20) }));
"
```

### 2. Read each session

```bash
node -e "
const { readSession, formatMessagesForExtraction } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
console.log(formatMessagesForExtraction(readSession('SESSION_FILE_PATH')));
"
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

```bash
node -e "
const { writeL1Record, updateState, globalDir, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const records = EXTRACTED_ARRAY;
const projectHash = 'PROJECT_HASH';
const sessionId = 'SESSION_ID';
for (const rec of records) {
  const base = ['persona','instruction'].includes(rec.type) ? globalDir() : projectDir(projectHash);
  writeL1Record(base, rec);
}
updateState(sessionId, projectHash, 'completed');
console.log('Wrote ' + records.length + ' atoms');
"
```

### 5. Hint next step

After seeding, tell the user: **Next: `/memory-consolidate`** to group atoms into scenes and synthesize persona.
