---
description: Search raw L0 conversation history from Claude Code transcripts.
argument-hint: <query>
allowed-tools: [Bash]
---

```bash
node -e "
const { listProjects, listSessions, readSession, projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');

const query = (process.argv[1] || '').toLowerCase();
if (!query) { console.log('Usage: /memory-conversation-search <query>'); process.exit(0); }

const pHash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || '.');
const sessions = listSessions(pHash);
const matches = [];

for (const s of sessions.slice(-20)) {
  const messages = readSession(s.filePath);
  for (const m of messages) {
    const text = (m.content || '').toLowerCase();
    if (text.includes(query)) {
      matches.push({ session: s.sessionId, role: m.role, preview: (m.content || '').slice(0, 200), ts: m.timestamp });
    }
  }
}

if (!matches.length) { console.log('No conversation matches for: ' + query); process.exit(0); }
console.log(matches.length + ' matches in project ' + pHash + ':');
for (const m of matches.slice(0, 15)) {
  console.log('[' + m.role + ' ' + (m.ts || '') + '] ' + m.preview);
  console.log('---');
}
" "$ARGUMENTS"
```
