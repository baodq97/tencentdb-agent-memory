---
description: Initialize the local FTS5 memory store for this project.
allowed-tools: Bash
---

Create the global and project-scoped memory directories + FTS5 index databases.

```bash
node -e "
const { globalDir, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const { projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
const { MemoryStore } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_store.js');
const fs = require('node:fs');
const path = require('node:path');

const gDir = globalDir();
const cwd = process.env.CLAUDE_PROJECT_DIR || '.';
const pHash = projectHashForCwd(cwd);
const pDir = projectDir(pHash);

fs.mkdirSync(gDir, { recursive: true });
fs.mkdirSync(pDir, { recursive: true });

// Touch FTS5 indexes so recall works immediately
for (const dir of [gDir, pDir]) {
  const db = path.join(dir, 'index.db');
  const store = new MemoryStore(db);
  store.close();
}

console.log('Global dir:', gDir);
console.log('Project dir:', pDir, '(' + pHash + ')');
console.log('Memory store initialized.');
"
```

After init, run `/memory-seed` to extract memories from past conversations, then `/memory-consolidate` to build scenes and persona.
