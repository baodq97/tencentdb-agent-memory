---
description: Show memory plugin configuration and data directory paths.
allowed-tools: [Bash]
---

```bash
node -e "
const { globalDir, projectDir, memoryBaseDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const { projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
const fs = require('node:fs');
const path = require('node:path');

const base = memoryBaseDir();
const gDir = globalDir();
const pHash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || '.');
const pDir = projectDir(pHash);

console.log('=== Memory Config ===');
console.log('Base dir:', base);
console.log('Global dir:', gDir);
console.log('Project dir:', pDir, '(' + pHash + ')');
console.log();

const stateFile = path.join(base, 'state.json');
if (fs.existsSync(stateFile)) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  const sessions = Object.keys(state.sessions || {});
  console.log('Tracked sessions:', sessions.length);
  const pending = sessions.filter(s => state.sessions[s]?.status === 'pending').length;
  const completed = sessions.filter(s => state.sessions[s]?.status === 'completed').length;
  console.log('  pending:', pending, ' completed:', completed);
} else {
  console.log('State: (no state.json yet)');
}

const captureState = path.join(base, 'capture_state.json');
if (fs.existsSync(captureState)) {
  const cs = JSON.parse(fs.readFileSync(captureState, 'utf-8'));
  console.log('Auto-capture turns:', cs.turn_count || 0);
  console.log('Consolidation due:', cs.consolidation_due ? 'YES' : 'no');
} else {
  console.log('Auto-capture: (not started)');
}
"
```
