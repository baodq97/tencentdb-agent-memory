---
description: Show memory store stats — record counts, persona, scenes, and data directory tree.
allowed-tools: [Bash]
---

```bash
node -e "
const fs = require('node:fs');
const path = require('node:path');
const { globalDir, projectDir, readPersona } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const { projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
const { MemoryStore } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_store.js');

const gDir = globalDir();
const cwd = process.env.CLAUDE_PROJECT_DIR || '.';
const pHash = projectHashForCwd(cwd);
const pDir = projectDir(pHash);

function dbStats(dir, label) {
  const dbPath = path.join(dir, 'index.db');
  if (!fs.existsSync(dbPath)) { console.log(label + ': (no index.db)'); return; }
  const store = new MemoryStore(dbPath);
  const all = store.allRecords();
  const byType = {};
  for (const r of all) { byType[r.type || 'unknown'] = (byType[r.type || 'unknown'] || 0) + 1; }
  console.log(label + ': ' + all.length + ' records', JSON.stringify(byType));
  store.close();
}

console.log('=== Memory Status ===');
console.log('Global dir:', gDir);
console.log('Project dir:', pDir, '(' + pHash + ')');
console.log();
dbStats(gDir, 'Global');
dbStats(pDir, 'Project');

const persona = readPersona(gDir);
console.log();
console.log('Persona:', persona ? persona.split('\\n').length + ' lines' : '(none)');

const scenesDir = path.join(gDir, 'scenes');
if (fs.existsSync(scenesDir)) {
  const scenes = fs.readdirSync(scenesDir).filter(f => f.endsWith('.md'));
  console.log('Scenes:', scenes.length, scenes.length ? scenes.join(', ') : '');
} else {
  console.log('Scenes: (none)');
}
"
```
