---
description: Backfill memory from old Claude Code conversation logs. Processes pending sessions incrementally.
argument-hint: "[--project <hash>] [--all] [--session <id>]"
allowed-tools: Read, Glob, Grep, Bash, Agent
---

Process Claude Code conversation logs and extract L1 memory atoms.

## How It Works

This command makes **you** (the agent) read conversation transcripts and extract memories. No external LLM needed.

## Steps

1. **Read state** to find pending/unprocessed sessions:

```bash
node -e "
const { readState } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const { listProjects, listSessions, projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');

const args = \`\$ARGUMENTS\`.trim();
const state = readState();
const processed = new Set(Object.keys(state.sessions || {}));

if (args.includes('--session')) {
  const sid = args.split('--session')[1]?.trim().split(/\s+/)[0] || '';
  console.log(JSON.stringify({mode:'single', session_id: sid}));
} else if (args.includes('--all')) {
  const sessions = [];
  for (const p of listProjects()) {
    for (const s of listSessions(p)) {
      if (!processed.has(s.sessionId)) sessions.push({session_id:s.sessionId, file_path:s.filePath, project_hash:p});
    }
  }
  console.log(JSON.stringify({mode:'all', pending:sessions.length, sessions:sessions.slice(0,20)}));
} else if (args.includes('--project')) {
  const phash = args.split('--project')[1]?.trim().split(/\s+/)[0] || projectHashForCwd();
  const sessions = [];
  for (const s of listSessions(phash)) {
    if (!processed.has(s.sessionId)) sessions.push({session_id:s.sessionId, file_path:s.filePath, project_hash:phash});
  }
  console.log(JSON.stringify({mode:'project', project_hash:phash, pending:sessions.length, sessions:sessions.slice(0,20)}));
} else {
  const phash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || '.');
  const sessions = [];
  for (const s of listSessions(phash)) {
    if (!processed.has(s.sessionId)) sessions.push({session_id:s.sessionId, file_path:s.filePath, project_hash:phash});
  }
  console.log(JSON.stringify({mode:'current', project_hash:phash, pending:sessions.length, sessions:sessions.slice(0,20)}));
}
"
```

2. **For each pending session**, read the conversation and invoke the memory-consolidation skill to extract L1 atoms.

3. **Write extracted atoms** using the write script:

```bash
node -e "
const { writeL1Record, updateState, globalDir, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');

// AGENT: Replace these with actual extracted data
const records = [];  // Array of {content, type, priority, scene_name, source_message_ids, metadata}
const projectHash = '';  // The project hash
const sessionId = '';  // The session ID

for (const rec of records) {
  const base = ['persona','instruction'].includes(rec.type) ? globalDir() : projectDir(projectHash);
  writeL1Record(base, rec);
}

updateState(sessionId, projectHash, 'completed');
console.log('Wrote ' + records.length + ' L1 atoms for session ' + sessionId);
"
```

## Extraction Guidelines

When reading conversations, extract memories following these rules:

**Three types:**
- **persona** (priority 50-100): Stable user attributes, preferences, skills, values
- **episodic** (priority 60-100): Objective events, decisions, plans with timestamps
- **instruction** (priority 70-100 or -1): Long-term AI behavior rules

**Scope routing:**
- persona + instruction → global storage (`~/.memory-tencentdb/global/`)
- episodic + project-specific instructions → project storage (`~/.memory-tencentdb/projects/{hash}/`)

**Filtering:**
- Skip trivial chatter, greetings, one-time tool requests
- Skip AI self-descriptions and tool outputs
- Each memory must be understandable without conversation context
- Merge related facts into single complete memories

Refer to `/memory-consolidation` skill for detailed extraction format and examples.
