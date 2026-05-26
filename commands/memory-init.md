---
description: Initialize local memory store + vector index for this project.
allowed-tools: Bash
---

Create directories, FTS5 indexes, and build vector index from any existing memories.

```bash
node -e "
const { globalDir, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const { projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
const { MemoryStore } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_store.js');
const { VectorStore } = require('${CLAUDE_PLUGIN_ROOT}/scripts/vector_store.js');
const fs = require('node:fs');
const path = require('node:path');

const gDir = globalDir();
const cwd = process.env.CLAUDE_PROJECT_DIR || '.';
const pHash = projectHashForCwd(cwd);
const pDir = projectDir(pHash);

fs.mkdirSync(gDir, { recursive: true });
fs.mkdirSync(pDir, { recursive: true });

// Init FTS5 indexes
for (const dir of [gDir, pDir]) {
  const store = new MemoryStore(path.join(dir, 'index.db'));
  store.close();
}

// Init vector stores (sqlite-vec)
let vecOk = true;
for (const dir of [gDir, pDir]) {
  const vs = new VectorStore(path.join(dir, 'vectors.db'));
  if (vs.degraded) vecOk = false;
  vs.close();
}

// Count existing records
let totalRecords = 0;
for (const dir of [gDir, pDir]) {
  const store = new MemoryStore(path.join(dir, 'index.db'));
  totalRecords += store.count();
  store.close();
}

console.log('Global dir:', gDir);
console.log('Project dir:', pDir, '(' + pHash + ')');
console.log('FTS5: ready');
console.log('Vector store:', vecOk ? 'ready' : 'degraded (sqlite-vec failed)');
console.log('Existing records:', totalRecords);
console.log();

if (totalRecords > 0) {
  console.log('Reindexing ' + totalRecords + ' existing records into vector store...');
} else {
  console.log('No existing memories. Next: /memory-seed to extract from past conversations.');
}
"
```

If existing records were found, reindex them into the vector store:

```bash
node -e "
const path = require('node:path');
const fs = require('node:fs');
const { globalDir, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const { projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
const { MemoryStore } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_store.js');
const { VectorStore } = require('${CLAUDE_PLUGIN_ROOT}/scripts/vector_store.js');
const { getEmbeddingService } = require('${CLAUDE_PLUGIN_ROOT}/scripts/embedding_service.js');

async function reindex(dir, label) {
  const dbPath = path.join(dir, 'index.db');
  if (!fs.existsSync(dbPath)) return 0;
  const ftsStore = new MemoryStore(dbPath);
  const records = ftsStore.allRecords('', 10000);
  ftsStore.close();
  if (!records.length) return 0;
  const vecStore = new VectorStore(path.join(dir, 'vectors.db'));
  if (vecStore.degraded) return 0;
  const svc = getEmbeddingService();
  let count = 0;
  for (const r of records) {
    const vec = await svc.embed(r.content);
    if (vec) { vecStore.upsertVec(r.record_id, vec); count++; }
  }
  vecStore.close();
  if (count) console.log(label + ': indexed ' + count + ' records');
  return count;
}

async function main() {
  const gDir = globalDir();
  const pHash = projectHashForCwd(process.env.CLAUDE_PROJECT_DIR || '.');
  const pDir = projectDir(pHash);

  // Check if there are records to reindex
  let total = 0;
  for (const dir of [gDir, pDir]) {
    const dbPath = path.join(dir, 'index.db');
    if (!fs.existsSync(dbPath)) continue;
    const s = new MemoryStore(dbPath); total += s.count(); s.close();
  }
  if (!total) { process.exit(0); }

  const svc = getEmbeddingService();
  console.log('Warming up embedding model...');
  svc.startWarmup();
  await svc.waitForReady();
  if (!svc.isReady()) { console.log('Embedding not available, skipping vector index.'); process.exit(0); }

  await reindex(gDir, 'Global');
  await reindex(pDir, 'Project');
  console.log('Vector index ready.');
  svc.close();
}
main().catch(() => process.exit(0));
"
```

After init completes, the next step is:
- **`/memory-seed`** — extract memories from past conversations (agent reads transcripts and extracts facts)
- Then **`/memory-consolidate`** — group into scenes + synthesize persona
