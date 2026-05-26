---
description: Search L1 structured memories via local FTS5.
argument-hint: <query>
allowed-tools: [Bash]
---

```bash
node -e "
const { MemoryStore } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_store.js');
const { globalDir, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const { projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
const fs = require('node:fs');
const path = require('node:path');

const query = process.argv[1] || '';
if (!query) { console.log('Usage: /memory-search <query>'); process.exit(0); }

const results = [];
for (const dir of [globalDir(), projectDir(projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || '.'))]) {
  const db = path.join(dir, 'index.db');
  if (!fs.existsSync(db)) continue;
  const store = new MemoryStore(db);
  results.push(...store.search(query, 10));
  store.close();
}

if (!results.length) { console.log('No memories match: ' + query); process.exit(0); }
for (const r of results) {
  console.log('[' + (r.type || '?') + '] (p=' + r.priority + ') ' + r.content);
}
" "$ARGUMENTS"
```
