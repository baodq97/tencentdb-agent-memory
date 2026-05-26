---
description: Rebuild vector index (vectors.db) from existing FTS5 memories. Run after first install or model change.
allowed-tools: [Bash]
---

Reindex all L1 memory records into the vector store. This embeds each record's content
using the local EmbeddingGemma model and stores the vectors in `vectors.db`.

First run will download the model (~80MB) if not already cached.

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
  if (!fs.existsSync(dbPath)) { console.log(label + ': no index.db, skipping'); return 0; }
  const ftsStore = new MemoryStore(dbPath);
  const records = ftsStore.allRecords('', 10000);
  ftsStore.close();
  if (!records.length) { console.log(label + ': 0 records, skipping'); return 0; }

  const vecDbPath = path.join(dir, 'vectors.db');
  const vecStore = new VectorStore(vecDbPath);
  if (vecStore.degraded) { console.error(label + ': sqlite-vec failed to load'); return 0; }

  const svc = getEmbeddingService();
  let count = 0;
  for (const r of records) {
    const vec = await svc.embed(r.content);
    if (vec) { vecStore.upsertVec(r.record_id, vec); count++; }
    if (count % 50 === 0 && count > 0) console.log(label + ': ' + count + '/' + records.length);
  }
  vecStore.close();
  console.log(label + ': indexed ' + count + '/' + records.length + ' records');
  return count;
}

async function main() {
  const svc = getEmbeddingService();
  console.log('Warming up embedding model (first run downloads ~80MB)...');
  svc.startWarmup();
  await svc.waitForReady();
  if (!svc.isReady()) { console.error('Embedding failed:', svc.initError?.message); process.exit(1); }
  console.log('Embedding ready (dims=' + svc.getDimensions() + ')');

  const gDir = globalDir();
  const cwd = process.env.CLAUDE_PROJECT_DIR || '.';
  const pHash = projectHashForCwd(cwd);
  const pDir = projectDir(pHash);

  let total = 0;
  total += await reindex(gDir, 'Global');
  total += await reindex(pDir, 'Project(' + pHash + ')');

  console.log('Done. Total vectors indexed: ' + total);
  svc.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
"
```
